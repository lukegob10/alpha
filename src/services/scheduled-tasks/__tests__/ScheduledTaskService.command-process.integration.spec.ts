import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"

import type { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { ScheduledTaskService } from "../ScheduledTaskService"
import { ScheduledTaskStore } from "../ScheduledTaskStore"

vi.mock("../../../utils/storage", () => ({ getStorageBasePath: (base: string) => base }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

type FixturePids = { pid: number; parentPid: number }
const nativeSetTimeout = setTimeout
const nativeClearTimeout = clearTimeout

function isPidAlive(pid: number): boolean {
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
			return !/^[ZXx]/.test(stat.slice(stat.lastIndexOf(")") + 2))
		}
		process.kill(pid, 0)
		return true
	} catch (error) {
		return !["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
	}
}

async function forceKill(pid: number): Promise<void> {
	if (!isPidAlive(pid)) return
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, () =>
				resolve(),
			)
		})
	} else {
		try {
			process.kill(pid, "SIGKILL")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
		}
	}
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = nativeSetTimeout(() => reject(new Error("Scheduled process fixture did not settle")), 15_000)
			}),
		])
	} finally {
		if (timer) nativeClearTimeout(timer)
	}
}

describe.skipIf(!["win32", "linux", "darwin"].includes(process.platform))(
	"scheduled direct command process ownership",
	() => {
		it.each(["disposal", "timeout"] as const)(
			"waits for a READY descendant to stop after %s before persisting failure and releasing its owner",
			async (trigger) => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-scheduled-process-"))
				const folders = vscode.workspace.workspaceFolders
				const sockets = new Set<net.Socket>()
				const server = net.createServer()
				let pids: FixturePids | undefined
				let service: ScheduledTaskService | undefined
				let running: Promise<void> | undefined
				let fireDeadline: (() => void) | undefined
				const releases = new Set<Promise<void>>()
				try {
					const ready = new Promise<FixturePids>((resolve, reject) => {
						server.on("error", reject)
						server.on("connection", (socket) => {
							sockets.add(socket)
							socket.on("error", (error: NodeJS.ErrnoException) => {
								if (error.code !== "ECONNRESET") reject(error)
							})
							let data = ""
							socket.on("data", (chunk) => {
								data += chunk.toString()
								if (data.includes("\n")) resolve(JSON.parse(data.trim()) as FixturePids)
							})
						})
					})
					await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
					const address = server.address()
					if (!address || typeof address === "string") throw new Error("Missing fixture listener port")
					const fixture = path.join(root, "process-fixture.cjs")
					await fs.writeFile(
						fixture,
						[
							'const { spawn } = require("node:child_process")',
							'const net = require("node:net")',
							'if (process.argv[2] === "child") {',
							'  const socket = net.connect(Number(process.argv[3]), "127.0.0.1", () => {',
							'    socket.write(JSON.stringify({ pid: process.pid, parentPid: process.ppid }) + "\\n")',
							"  })",
							'  socket.on("error", () => {})',
							"} else {",
							'  spawn(process.execPath, [__filename, "child", process.argv[2]], { stdio: "ignore", windowsHide: true })',
							"}",
							"setInterval(() => {}, 60_000)",
						].join("\n"),
					)
					Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root) }] })
					vi.spyOn(ScheduledTaskStore.prototype, "watchChanges").mockResolvedValue(() => {})
					const acquireOwnerLease = ScheduledTaskStore.prototype.acquireOwnerLease
					const released = vi.fn()
					vi.spyOn(ScheduledTaskStore.prototype, "acquireOwnerLease").mockImplementation(async function (
						this: ScheduledTaskStore,
						...args: Parameters<ScheduledTaskStore["acquireOwnerLease"]>
					) {
						const release = await acquireOwnerLease.apply(this, args)
						return () => {
							released()
							const pending = release()
							releases.add(pending)
							return pending
						}
					})
					const completeRun = ScheduledTaskStore.prototype.completeRun
					const completed = vi
						.spyOn(ScheduledTaskStore.prototype, "completeRun")
						.mockImplementation(async function (this: ScheduledTaskStore, run) {
							if (!pids) throw new Error("Command completed before its READY handshake")
							expect(isPidAlive(pids.pid)).toBe(false)
							expect(isPidAlive(pids.parentPid)).toBe(false)
							return completeRun.call(this, run)
						})
					const provider = Object.assign(new EventEmitter(), {
						postMessageToWebview: vi.fn(async () => undefined),
						getState: vi.fn(async () => ({ approvalMode: "bypass", deniedCommands: [] })),
					})
					service = new ScheduledTaskService(
						{ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext,
						provider as unknown as AlphaProvider,
						{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
						120_000,
					)
					const processQueue = vi.spyOn(
						service as unknown as { processQueue: () => Promise<void> },
						"processQueue",
					)
					await service.initialize()
					const schedule = await service.createTask({
						name: "Process cleanup fixture",
						prompt: "",
						workspace: root,
						execution: {
							type: "command",
							command: `"${process.execPath}" "${fixture}" ${address.port}`,
							timeoutMs: 60_000,
						},
						autoApproval: { approvalMode: "bypass" },
						schedule: { type: "once", startAt: Date.now() + 60_000, timezone: "UTC" },
						notificationPreference: "never",
					})
					if (trigger === "timeout") {
						// Fire the command's deadline only after READY; OS cleanup keeps real timers.
						vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
							if (delay === 60_000) fireDeadline = () => callback(...args)
							return nativeSetTimeout(callback, delay, ...args)
						})
					}
					await service.runNow(schedule.id)
					running = processQueue.mock.results[0].value
					if (!running) throw new Error("Scheduled command queue did not start")
					pids = await bounded(ready)
					expect(isPidAlive(pids.pid)).toBe(true)
					expect(isPidAlive(pids.parentPid)).toBe(true)
					if (trigger === "disposal") service.dispose()
					else {
						if (!fireDeadline) throw new Error("Command deadline was not installed")
						fireDeadline()
					}
					await bounded(running)
					expect(isPidAlive(pids.pid), `READY descendant survived scheduled-command ${trigger}`).toBe(false)
					expect(isPidAlive(pids.parentPid)).toBe(false)
					expect(completed).toHaveBeenCalledOnce()
					expect(service.getState().runs[0].status).toBe("failed")
					expect(service.getState().runs[0].error).toContain(trigger === "disposal" ? "aborted" : "timed out")
					service.dispose()
					await Promise.all(releases)
					expect(released).toHaveBeenCalledOnce()
					expect(completed.mock.invocationCallOrder[0]).toBeLessThan(released.mock.invocationCallOrder[0])
				} finally {
					service?.dispose()
					if (pids) {
						await forceKill(pids.parentPid)
						await forceKill(pids.pid)
					}
					await running
					await Promise.all(releases)
					for (const socket of sockets) socket.destroy()
					await new Promise<void>((resolve) => server.close(() => resolve()))
					Object.assign(vscode.workspace, { workspaceFolders: folders })
					vi.restoreAllMocks()
					await fs.rm(root, { recursive: true, force: true })
				}
			},
		)
	},
)
