import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { AlphaTerminal } from "../types"
import { MAX_TERMINAL_OUTPUT_BUFFER_BYTES } from "../types"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import { ExecaTerminal } from "../ExecaTerminal"
import { TerminalRegistry } from "../TerminalRegistry"
import { executeCommandInTerminal } from "../../../core/tools/ExecuteCommandTool"
import { Task, type CommandExecutionEvidence } from "../../../core/task/Task"
import { commandSessionRegistry } from "../../../core/tools/CommandSessionRegistry"
import { ToolRegistry } from "../../../core/tools/ToolRegistry"
import type { ToolResultMetadata } from "../../../core/tools/BaseTool"
import type { CommandToolResult } from "@alpha-code/types"

type FixturePids = { parentPid: number; childPid: number }

const supportedPlatform = ["win32", "linux", "darwin"].includes(process.platform)
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "process-tree-sleeper.mjs")

function isPidAlive(pid: number | undefined): boolean {
	if (!pid) return false
	try {
		if (process.platform === "linux") {
			// kill(pid, 0) also finds dead zombies awaiting init/parent reaping.
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
			return !/^[ZXx]/.test(stat.slice(stat.lastIndexOf(")") + 2))
		}
		process.kill(pid, 0)
		return true
	} catch (error) {
		return !["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
	}
}

function forceKill(pid: number | undefined): void {
	if (!pid || !isPidAlive(pid)) return
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			})
		} else {
			process.kill(pid, "SIGKILL")
		}
	} catch {
		// The test assertion reports any survivor; cleanup remains best-effort.
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
			}),
		])
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}

// The implementation relies on taskkill on Windows and ps on POSIX. Other
// Node platforms are gated because neither process-tree primitive is defined.
describe.skipIf(!supportedPlatform)("ExecaTerminalProcess process-tree integration", () => {
	it("retains a real direct-argv process past a short yield and joins its archive before the final native poll", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-direct-argv-live-"))
		const taskId = `direct-argv-live-${process.pid}-${Date.now()}`
		const lifetime = new AbortController()
		const provider = {
			context: { globalStorageUri: { fsPath: storage } },
			postMessageToWebview: () => undefined,
			getState: async () => ({ terminalShellIntegrationDisabled: true }),
			getValue: (key: string) => (key === "terminalShellIntegrationDisabled" ? true : undefined),
		}
		const task = {
			taskId,
			cwd: path.dirname(fixturePath),
			taskKind: "subagent",
			subagentRole: "worker",
			abort: false,
			providerRef: { deref: () => provider },
			getTaskLifetimeCancellationSignal: () => lifetime.signal,
			commandExecutionEvidence: new Map<string, CommandExecutionEvidence>(),
			pendingCommandVerification: Promise.resolve(),
			completionRuntimeRevision: 0,
			beginCommandExecution: Task.prototype.beginCommandExecution,
			admitCommandExecution: Task.prototype.admitCommandExecution,
			completeCommandExecution: Task.prototype.completeCommandExecution,
			failCommandExecution: Task.prototype.failCommandExecution,
			getCommandExecutionEvidence: Task.prototype.getCommandExecutionEvidence,
			markCommandExecutionBackgrounded: Task.prototype.markCommandExecutionBackgrounded,
			prepareCommandEvidenceSlot: Task.prototype["prepareCommandEvidenceSlot"],
			enqueueCommandEvidence: Task.prototype["enqueueCommandEvidence"],
			publishParentVerificationEvidence: () => undefined,
			supersedePendingAsk: () => undefined,
			say: async () => undefined,
			ask: async () => ({ response: "yesButtonClicked" as const }),
		} as unknown as Task
		const env: Record<string, string> = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }
		for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME"]) {
			const value = process.env[key]
			if (value !== undefined) env[key] = value
		}
		let firstResult: CommandToolResult | undefined
		let fixturePids: FixturePids | undefined
		let original: AlphaTerminal["process"]
		try {
			await executeCommandInTerminal(task, {
				executionId: Date.now().toString(),
				toolCallId: "direct-argv-live",
				command: "host-owned direct argv fixture",
				terminalShellIntegrationDisabled: true,
				agentTimeout: 250,
				// This is trusted host/test input; Node does not become an eligible model command.
				directCommand: { executable: process.execPath, args: [fixturePath], env },
				onCommandResult: (result) => {
					firstResult = result
				},
			})
			const sessionId = firstResult?.session_id
			expect(sessionId).toBeTypeOf("number")
			if (sessionId === undefined) throw new Error("Live direct argv command returned no session")
			original = commandSessionRegistry.resolve(task, sessionId)?.process
			expect(original?.isSettled).toBe(false)
			if (!original) throw new Error("Live session lost its original process")
			expect(commandSessionRegistry.ownsOutput(original)).toBe(true)
			const processOwner = original
			const readiness = (async () => {
				while (true) {
					let wake!: () => void
					const available = new Promise<void>((resolve) => {
						wake = resolve
					})
					processOwner.once("output_available", wake)
					processOwner.once("completed", wake)
					processOwner.once("error", wake)
					try {
						const receipt = processOwner.captureUnretrievedOutput(4_096)
						const match = `${firstResult?.output ?? ""}\n${receipt.output}`.match(
							/\{"parentPid":\d+,"childPid":\d+\}/,
						)
						receipt.release()
						if (match) return JSON.parse(match[0]) as FixturePids
						if (processOwner.isSettled) throw new Error("Owned child exited before readiness")
						await available
					} finally {
						processOwner.off("output_available", wake)
						processOwner.off("completed", wake)
						processOwner.off("error", wake)
					}
				}
			})()
			fixturePids = await withTimeout(readiness, 15_000, "Direct argv child did not report readiness")
			expect(isPidAlive(fixturePids.parentPid)).toBe(true)
			expect(isPidAlive(fixturePids.childPid)).toBe(true)
			expect(TerminalRegistry.getTerminals(true, taskId).some((terminal) => terminal.process === original)).toBe(
				true,
			)
			await original.abort()
			if (!original.waitForOutputFinalization) throw new Error("Owned process has no passive archive barrier")
			await withTimeout(original.waitForOutputFinalization(), 10_000, "Owned archive did not settle after Stop")
			expect(isPidAlive(fixturePids.parentPid)).toBe(false)
			expect(isPidAlive(fixturePids.childPid)).toBe(false)
			expect(original.isSettled).toBe(true)
			expect(TerminalRegistry.getTerminals(true, taskId)).toEqual([])
			const metadata: ToolResultMetadata[] = []
			const errors = vitest.fn()
			const receipts = vitest.fn()
			const descriptor = new ToolRegistry().resolve("write_stdin")
			if (!descriptor) throw new Error("Native session poll is unavailable")
			await descriptor.execute({
				task,
				mode: "code",
				call: {
					type: "tool_use",
					id: "direct-argv-final",
					name: "write_stdin",
					partial: false,
					params: {},
					nativeArgs: { session_id: sessionId, chars: "", yield_time_ms: 0, max_output_tokens: 2_000 },
				},
				callbacks: {
					askApproval: async () => true,
					pushToolResult: receipts,
					handleError: errors,
					setResultMetadata: (value) => {
						metadata.push(value)
					},
				},
			})
			expect(errors).not.toHaveBeenCalled()
			expect(receipts).toHaveBeenCalledOnce()
			expect(metadata.some(({ commandResult }) => commandResult !== undefined)).toBe(true)
			expect(metadata.some(({ commandResult }) => commandResult?.session_id !== undefined)).toBe(false)
			expect(metadata.some(({ commandResult }) => commandResult?.exit_code === 0)).toBe(false)
			expect(commandSessionRegistry.resolve(task, sessionId)).toBeUndefined()
			expect(commandSessionRegistry.ownsOutput(original)).toBe(false)
		} finally {
			if (original && !original.isSettled) {
				const originalProcess = original
				await Promise.resolve()
					.then(() => originalProcess.abort())
					.catch(() => undefined)
			}
			forceKill(fixturePids?.childPid)
			forceKill(fixturePids?.parentPid)
			if (original?.waitForOutputFinalization) {
				await withTimeout(
					original.waitForOutputFinalization(),
					1_000,
					"Owned archive remained after cleanup",
				).catch(() => undefined)
			}
			commandSessionRegistry.releaseForTask(task)
			TerminalRegistry.releaseTerminalsForTask(taskId)
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("bounds high-output completion while preserving UTF-8, CRLF, and the final tail", async () => {
		const outputFixture = path.join(path.dirname(fixturePath), "high-output.mjs")
		const expected = "界🙂\r\n".repeat(8192 * 32) + "final-no-newline🙂"
		const terminal = new ExecaTerminal(31, path.dirname(fixturePath))
		let completed = ""
		const command = terminal.runCommand(`"${process.execPath}" "${outputFixture}"`, {
			onLine: () => undefined,
			onCompleted: (output) => {
				completed = output ?? ""
			},
			onShellExecutionStarted: () => undefined,
			onShellExecutionComplete: () => undefined,
		})
		await withTimeout(command, 10_000, "High output did not complete")
		expect(Buffer.byteLength(completed)).toBeLessThanOrEqual(MAX_TERMINAL_OUTPUT_BUFFER_BYTES + 96)
		expect(completed).toMatch(/bytes omitted/)
		expect(completed.startsWith("界🙂\r\n")).toBe(true)
		expect(completed.endsWith("final-no-newline🙂")).toBe(true)
		expect(completed).not.toContain("\ufffd")
		expect(Buffer.byteLength(completed)).toBeLessThan(Buffer.byteLength(expected))
		expect(terminal.running).toBe(false)
		expect(command.isSettled).toBe(true)
	})
	it.each(["callback", "stream"])(
		"settles the real process tree before reporting an output %s failure",
		async (source) => {
			const terminal = new ExecaTerminal(3, path.dirname(fixturePath))
			const failure = new Error("Output callback failed")
			const errorLog = vitest.spyOn(console, "error").mockImplementation(() => undefined)
			const shellCompleted = vitest.fn()
			let fixturePids: FixturePids | undefined
			let shellPid: number | undefined
			const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`
			const command = terminal.runCommand(`${quote(process.execPath)} ${quote(fixturePath)}`, {
				onLine: (line, process) => {
					fixturePids = JSON.parse(line.trim()) as FixturePids
					shellPid = (process as ExecaTerminalProcess)["subprocess"]?.pid
					expect(isPidAlive(shellPid)).toBe(true)
					expect(isPidAlive(fixturePids.parentPid)).toBe(true)
					expect(isPidAlive(fixturePids.childPid)).toBe(true)
					if (source === "stream") {
						;(process as ExecaTerminalProcess)["subprocess"]?.all?.destroy(failure)
					} else {
						throw failure
					}
				},
				onCompleted: () => {
					expect(isPidAlive(shellPid)).toBe(false)
					expect(isPidAlive(fixturePids?.parentPid)).toBe(false)
					expect(isPidAlive(fixturePids?.childPid)).toBe(false)
				},
				onShellExecutionStarted: vitest.fn(),
				onShellExecutionComplete: shellCompleted,
			})
			const outcome = command.then(
				() => ({ status: "success" as const }),
				(error: unknown) => ({ status: "error" as const, error }),
			)

			try {
				expect(await withTimeout(outcome, 10_000, "Output failure did not settle the process tree")).toEqual({
					status: "error",
					error: failure,
				})
				expect(fixturePids).toBeDefined()
				expect(isPidAlive(shellPid)).toBe(false)
				expect(isPidAlive(fixturePids?.parentPid)).toBe(false)
				expect(isPidAlive(fixturePids?.childPid)).toBe(false)
				expect(command.isSettled).toBe(true)
				expect(terminal.running).toBe(false)
				expect(terminal.busy).toBe(false)
				expect(terminal.process).toBeUndefined()
				expect(shellCompleted).toHaveBeenCalledOnce()
			} finally {
				forceKill(fixturePids?.childPid)
				forceKill(fixturePids?.parentPid)
				forceKill(shellPid)
				await withTimeout(outcome, 1_000, "Output failure did not settle after cleanup").catch(() => undefined)
				errorLog.mockRestore()
			}
		},
	)

	it("removes the real shell, fixture parent, and sleeper child", async () => {
		const terminal = {
			provider: "execa",
			id: 1,
			busy: true,
			running: true,
			getCurrentWorkingDirectory: () => path.dirname(fixturePath),
			isClosed: () => false,
			setActiveStream: () => undefined,
			shellExecutionComplete: (details: Parameters<AlphaTerminal["shellExecutionComplete"]>[0]) => {
				terminal.running = false
				terminal.busy = false
				terminalProcess.emit("shell_execution_complete", details)
			},
		} as unknown as AlphaTerminal
		const terminalProcess = new ExecaTerminalProcess(terminal)
		let fixturePids: FixturePids | undefined
		let shellPid: number | undefined
		let resolveFixture!: (pids: FixturePids) => void
		let rejectFixture!: (error: Error) => void
		const fixtureStarted = new Promise<FixturePids>((resolve, reject) => {
			resolveFixture = resolve
			rejectFixture = reject
		})
		terminalProcess.on("line", (line) => {
			try {
				resolveFixture(JSON.parse(line.trim()) as FixturePids)
			} catch (error) {
				rejectFixture(error instanceof Error ? error : new Error(String(error)))
			}
		})
		const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`
		const run = terminalProcess.run(`${quote(process.execPath)} ${quote(fixturePath)}`)

		try {
			fixturePids = await withTimeout(fixtureStarted, 5_000, "Fixture did not report its PIDs within 5 seconds")
			shellPid = (terminalProcess as any).subprocess?.pid
			expect(shellPid).toBeTypeOf("number")
			expect(isPidAlive(shellPid)).toBe(true)
			expect(isPidAlive(fixturePids.parentPid)).toBe(true)
			expect(isPidAlive(fixturePids.childPid)).toBe(true)

			await terminalProcess.abort()
			await vitest.waitFor(
				() => {
					expect(isPidAlive(shellPid)).toBe(false)
					expect(isPidAlive(fixturePids?.parentPid)).toBe(false)
					expect(isPidAlive(fixturePids?.childPid)).toBe(false)
				},
				{ timeout: 5_000, interval: 50 },
			)
			await run
		} finally {
			forceKill(fixturePids?.childPid)
			forceKill(fixturePids?.parentPid)
			forceKill(shellPid)
			await withTimeout(
				run.catch(() => undefined),
				1_000,
				"Terminal run did not settle after cleanup",
			).catch(() => undefined)
		}
	})

	it("keeps an agent-timeout command registry-owned until its real process tree is aborted", async () => {
		const taskId = `process-tree-integration-${process.pid}`
		const lifetime = new AbortController()
		const task = {
			taskId,
			cwd: path.dirname(fixturePath),
			taskKind: "subagent",
			subagentRole: "worker",
			abort: false,
			providerRef: {
				deref: () => ({
					postMessageToWebview: () => undefined,
				}),
			},
			getTaskLifetimeCancellationSignal: () => lifetime.signal,
			supersedePendingAsk: () => undefined,
			failCommandExecution: () => undefined,
			completeCommandExecution: () => undefined,
			say: async () => undefined,
		} as any
		let fixturePids: FixturePids | undefined
		let shellPid: number | undefined
		let terminalProcess: ExecaTerminalProcess | undefined
		const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`

		try {
			const [, output] = await executeCommandInTerminal(task, {
				executionId: taskId,
				command: `${quote(process.execPath)} ${quote(fixturePath)}`,
				terminalShellIntegrationDisabled: true,
				agentTimeout: 250,
			})
			const serializedOutput = typeof output === "string" ? output : JSON.stringify(output)

			const terminals = TerminalRegistry.getTerminals(true, taskId)
			expect(terminals).toHaveLength(1)
			terminalProcess = terminals[0].process as ExecaTerminalProcess
			await vitest.waitFor(
				() => {
					// The 250 ms agent timeout intentionally returns before process
					// completion. Under full-suite load, Windows may not start Node before
					// that threshold, so wait for readiness in the registry-owned buffer.
					const bufferedOutput = `${serializedOutput}\n${(terminalProcess as any).fullOutput ?? ""}`
					const match = bufferedOutput.match(/\{"parentPid":\d+,"childPid":\d+\}/)
					expect(match, `Expected fixture PID output in ${bufferedOutput}`).not.toBeNull()
					fixturePids = JSON.parse(match![0]) as FixturePids
				},
				{ timeout: 15_000, interval: 50 },
			)
			if (!fixturePids) throw new Error("Fixture readiness completed without reporting PIDs")
			shellPid = (terminalProcess as any).subprocess?.pid
			expect(isPidAlive(shellPid)).toBe(true)
			expect(isPidAlive(fixturePids.parentPid)).toBe(true)
			expect(isPidAlive(fixturePids.childPid)).toBe(true)

			const settled = new Promise<void>((resolve) => terminalProcess!.once("completed", () => resolve()))
			await terminalProcess.abort()
			await withTimeout(settled, 5_000, "Registry-owned terminal did not settle after abort")
			await vitest.waitFor(
				() => {
					expect(isPidAlive(shellPid)).toBe(false)
					expect(isPidAlive(fixturePids?.parentPid)).toBe(false)
					expect(isPidAlive(fixturePids?.childPid)).toBe(false)
				},
				{ timeout: 5_000, interval: 50 },
			)
			expect(TerminalRegistry.getTerminals(true, taskId)).toEqual([])
		} finally {
			if (terminalProcess && terminalProcess.isSettled !== true) {
				await terminalProcess.abort().catch(() => undefined)
			}
			forceKill(fixturePids?.childPid)
			forceKill(fixturePids?.parentPid)
			forceKill(shellPid)
			TerminalRegistry.releaseTerminalsForTask(taskId)
		}
	})
})
