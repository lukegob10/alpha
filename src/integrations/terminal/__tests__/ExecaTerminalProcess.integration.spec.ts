import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { RooTerminal } from "../types"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import { TerminalRegistry } from "../TerminalRegistry"
import { executeCommandInTerminal } from "../../../core/tools/ExecuteCommandTool"

type FixturePids = { parentPid: number; childPid: number }

const supportedPlatform = ["win32", "linux", "darwin"].includes(process.platform)
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "process-tree-sleeper.mjs")

function isPidAlive(pid: number | undefined): boolean {
	if (!pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
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
	it("removes the real shell, fixture parent, and sleeper child", async () => {
		const terminal = {
			provider: "execa",
			id: 1,
			busy: true,
			running: true,
			getCurrentWorkingDirectory: () => path.dirname(fixturePath),
			isClosed: () => false,
			setActiveStream: () => undefined,
		} as unknown as RooTerminal
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
