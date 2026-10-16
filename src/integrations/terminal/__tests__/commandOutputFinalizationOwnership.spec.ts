import * as vscode from "vscode"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CommandSessionRegistry } from "../../../core/tools/CommandSessionRegistry"
import type { Task } from "../../../core/task/Task"
import { BaseTerminalProcess } from "../BaseTerminalProcess"
import { ExecaTerminal } from "../ExecaTerminal"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import { ShellIntegrationManager } from "../ShellIntegrationManager"
import { Terminal } from "../Terminal"
import { TerminalProcess } from "../TerminalProcess"
import { TerminalRegistry } from "../TerminalRegistry"
import type { AlphaTerminalCallbacks, AlphaTerminalProcessResultPromise } from "../types"

vi.mock("p-wait-for", () => ({ default: vi.fn(async () => undefined) }))
vi.mock("execa", () => ({ execa: vi.fn(), ExecaError: class extends Error {} }))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((fulfilled, rejected) => {
		resolve = fulfilled
		reject = rejected
	})
	return { promise, resolve, reject }
}

function outcome(promise: Promise<void>) {
	return promise.then(
		() => ({ status: "fulfilled" as const }),
		(reason: unknown) => ({ status: "rejected" as const, reason }),
	)
}

function expectExactRejection(result: Awaited<ReturnType<typeof outcome>>, reason: unknown) {
	expect(result.status).toBe("rejected")
	if (result.status === "rejected") expect(result.reason).toBe(reason)
}

class OutputProcess extends BaseTerminalProcess {
	readonly abort = vi.fn()

	constructor() {
		super()
	}

	async run(): Promise<void> {}

	continue(): void {
		this.emit("continue")
	}

	append(chunk: string): Promise<void> {
		return this.appendOutput(chunk)
	}

	hasUnretrievedOutput(): boolean {
		return this.lastRetrievedIndex < this.fullOutput.length
	}

	protected getUnretrievedOutputRange(maxCharacters: number) {
		const endIndex = this.safeOutputRangeEnd(
			Math.min(this.fullOutput.length, this.lastRetrievedIndex + maxCharacters),
		)
		return { output: this.fullOutput.slice(this.lastRetrievedIndex, endIndex), endIndex }
	}
}

function callbacks(overrides: Partial<AlphaTerminalCallbacks> = {}): AlphaTerminalCallbacks {
	return {
		onLine: vi.fn(),
		onCompleted: vi.fn(),
		onShellExecutionStarted: vi.fn(),
		onShellExecutionComplete: vi.fn(),
		...overrides,
	}
}

let nextTerminalId = 50_000
const adapters = [
	{
		name: "Execa",
		create: () => new ExecaTerminal(nextTerminalId++, "/test"),
		prototype: ExecaTerminalProcess.prototype,
	},
	{
		name: "VS Code",
		create: () =>
			new Terminal(
				nextTerminalId++,
				{ shellIntegration: { executeCommand: vi.fn() }, exitStatus: undefined } as unknown as vscode.Terminal,
				"/test",
			),
		prototype: TerminalProcess.prototype,
	},
] as const

afterEach(() => vi.restoreAllMocks())

// Passive-wait controls require the proposed API and are GREEN-only. Adapter
// creation-hook cases exercise existing runCommand and RED on owned assertions.
describe("passive command output finalization", () => {
	it("observes finalization without starting it or detaching a reader tail writer", async () => {
		const process = new OutputProcess()
		const writes: string[] = []
		const releaseClose = deferred<void>()
		const closeEntered = deferred<void>()
		const finalizer = vi.fn(async () => {
			closeEntered.resolve()
			await releaseClose.promise
		})
		process.setOutputWriter((chunk) => {
			writes.push(chunk)
		})
		process.setOutputFinalizer(finalizer)
		const finalized = vi.fn()
		process.on("finalized", finalized)
		let observed: "pending" | "fulfilled" | "rejected" = "pending"
		const waiting = process.waitForOutputFinalization().then(
			() => (observed = "fulfilled"),
			() => (observed = "rejected"),
		)
		try {
			await process.append("BEFORE_EXIT\n")
			process.emit("shell_execution_complete", { exitCode: 0 })
			// The host's physical exit is allowed to precede the iterator's EOF.
			await process.append("TAIL_AFTER_EXIT\n")
			expect(writes).toEqual(["BEFORE_EXIT\n", "TAIL_AFTER_EXIT\n"])
			expect(finalizer).not.toHaveBeenCalled()
			expect(finalized).not.toHaveBeenCalled()
			expect(observed).toBe("pending")
			expect(process.abort).not.toHaveBeenCalled()
			const receipt = process.captureUnretrievedOutput()
			expect(receipt.output).toBe("BEFORE_EXIT\nTAIL_AFTER_EXIT\n")
			receipt.release()
			process.emit("completed", receipt.output)
			const closing = process.finalizeOutput()
			await closeEntered.promise
			expect(observed).toBe("pending")
			expect(process.isOutputFinalized).toBe(false)
			releaseClose.resolve()
			await closing
			await waiting
			expect(observed).toBe("fulfilled")
			expect(finalizer).toHaveBeenCalledOnce()
			expect(finalized).toHaveBeenCalledOnce()
			expect(process.hasUnretrievedOutput()).toBe(true)
		} finally {
			releaseClose.resolve()
			await outcome(process.finalizeOutput())
			await waiting
		}
	})

	it("releases only an already blocked archival write without another physical abort", async () => {
		const process = new OutputProcess()
		const writeEntered = deferred<void>()
		const releaseWrite = deferred<void>()
		const write = vi.fn(async () => {
			writeEntered.resolve()
			await releaseWrite.promise
		})
		const close = vi.fn()
		process.setOutputWriter(write)
		process.setOutputFinalizer(close)
		const waiting = outcome(process.waitForOutputFinalization())
		const writing = process.append("BLOCKED_PREFIX")
		try {
			await writeEntered.promise
			process.cancelPendingOutputWrite()
			await writing
			expect(process.outputArchiveInterrupted).toBe(true)
			expect(process.outputCancellationSignal.aborted).toBe(true)
			expect(process.abort).not.toHaveBeenCalled()
			expect(close).not.toHaveBeenCalled()
			expect(process.isOutputFinalized).toBe(false)
			await process.append("_READER_TAIL")
			expect(write).toHaveBeenCalledOnce()
			const receipt = process.captureUnretrievedOutput()
			expect(receipt.output).toBe("BLOCKED_PREFIX_READER_TAIL")
			receipt.release()
			await process.finalizeOutput()
			expect(await waiting).toEqual({ status: "fulfilled" })
			expect(close).toHaveBeenCalledOnce()
		} finally {
			releaseWrite.resolve()
			await writing
			await outcome(process.finalizeOutput())
			await waiting
		}
	})

	it("does not interrupt a healthy held finalizer after natural close admission", async () => {
		const process = new OutputProcess()
		const closeEntered = deferred<void>()
		const releaseClose = deferred<void>()
		process.setOutputFinalizer(async () => {
			closeEntered.resolve()
			await releaseClose.promise
		})
		const closed = outcome(process.waitForOutputFinalization())
		const closing = process.finalizeOutput()
		try {
			await closeEntered.promise
			process.cancelPendingOutputWrite()
			expect(process.outputCancellationSignal.aborted).toBe(false)
			expect(process.outputArchiveInterrupted).toBe(false)
			expect(process.isOutputFinalized).toBe(false)
			expect(process.abort).not.toHaveBeenCalled()
			releaseClose.resolve()
			await closing
			expect(await closed).toEqual({ status: "fulfilled" })
		} finally {
			releaseClose.resolve()
			await outcome(closing)
			await closed
		}
	})

	it.each([
		["undefined", undefined],
		["null", null],
		["Error", new Error("synthetic close failure")],
	] as const)("preserves the exact %s rejection for early and late passive waiters", async (_label, reason) => {
		const process = new OutputProcess()
		const closeEntered = deferred<void>()
		const releaseClose = deferred<void>()
		process.setOutputFinalizer(async () => {
			closeEntered.resolve()
			await releaseClose.promise
		})
		const early = outcome(process.waitForOutputFinalization())
		const closing = outcome(process.finalizeOutput())
		try {
			await closeEntered.promise
			releaseClose.reject(reason)
			expectExactRejection(await closing, reason)
			expectExactRejection(await early, reason)
			expectExactRejection(await outcome(process.waitForOutputFinalization()), reason)
			expect(process.outputArchiveInterrupted).toBe(true)
			expect(process.outputArtifactId).toBeUndefined()
			// This fixture proves the attempt's result, not raw-file-descriptor closure.
		} finally {
			releaseClose.resolve()
			await closing
			await early
		}
	})
})

for (const adapter of adapters) {
	describe(`${adapter.name} process creation ownership`, () => {
		it("binds the original process before a synchronous shell-start callback can reenter", async () => {
			vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
			vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir").mockReturnValue(false)
			const registry = new CommandSessionRegistry()
			const owner = { taskId: "reentrant-owner" } as Task
			const terminal = adapter.create()
			terminal.taskId = owner.taskId
			const runEntered = deferred<void>()
			const releaseRun = deferred<void>()
			const started = vi.fn()
			const onOutputClosed = vi.fn()
			const trace: string[] = []
			const run = vi.spyOn(adapter.prototype, "run").mockImplementation(async function (
				this: ExecaTerminalProcess | TerminalProcess,
			) {
				trace.push("run")
				this.emit("shell_execution_started", undefined)
				runEntered.resolve()
				try {
					await releaseRun.promise
				} finally {
					await this.finalizeOutput()
					this.emit("continue")
				}
			})
			const running = terminal.runCommand(
				"synthetic command",
				callbacks({
					onOutputClosed,
					onProcessCreated: (process) => {
						trace.push("created")
						process.executionId = "1000:original-physical"
						registry.trackTaskOutput(owner, process, "1000:original-physical", {
							archiveExecutionId: "1000",
							isClosed: () => true,
						})
					},
					onShellExecutionStarted: (_pid, process) => {
						trace.push("external callback")
						started(process.executionId)
						// Models Stop/dispose reentry from a provider/status callback.
						registry.releaseForTask(owner)
					},
				}),
			)
			const result = outcome(running)
			try {
				await runEntered.promise
				expect(trace).toEqual(["created", "run", "external callback"])
				expect(started).toHaveBeenCalledExactlyOnceWith("1000:original-physical")
				const captured = registry.capturePendingTaskOutput(owner)
				expect(captured).toHaveLength(1)
				expect(captured[0]!.process).toBe(running)
				expect(captured[0]!.executionId).toBe("1000:original-physical")
				expect(registry.ownsOutput(running)).toBe(false)
				expect(onOutputClosed).not.toHaveBeenCalled()
				releaseRun.resolve()
				expect(await result).toEqual({ status: "fulfilled" })
				await captured[0]!.completion
				expect(run).toHaveBeenCalledOnce()
				expect(onOutputClosed).toHaveBeenCalledOnce()
			} finally {
				releaseRun.resolve()
				await result
				registry.releaseForTask(owner)
				if (terminal.process === running) terminal.process = undefined
				terminal.busy = false
				terminal.running = false
			}
		})

		it.each([
			["undefined", undefined],
			["null", null],
			["Error", new Error("synthetic creation-hook failure")],
		] as const)(
			"does not launch or leak its reservation when a creation hook throws %s",
			async (_label, reason) => {
				vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir").mockReturnValue(false)
				const terminal = adapter.create()
				const closeEntered = deferred<void>()
				const releaseClose = deferred<void>()
				let created: BaseTerminalProcess | undefined
				const run = vi.spyOn(adapter.prototype, "run").mockImplementation(async function (
					this: ExecaTerminalProcess | TerminalProcess,
				) {
					await this.finalizeOutput()
					this.emit("continue")
				})
				const completed = vi.fn()
				const physicalExit = vi.fn()
				const onOutputClosed = vi.fn(async () => {
					closeEntered.resolve()
					await releaseClose.promise
				})
				let returned: AlphaTerminalProcessResultPromise | undefined
				let thrown: { caught: boolean; reason?: unknown } = { caught: false }
				try {
					try {
						returned = terminal.runCommand(
							"must not launch",
							callbacks({
								onCompleted: completed,
								onShellExecutionComplete: physicalExit,
								onOutputClosed,
								onProcessCreated: (process) => {
									if (!(process instanceof BaseTerminalProcess))
										throw new Error("Unexpected adapter process")
									created = process
									throw reason
								},
							}),
						)
					} catch (error) {
						thrown = { caught: true, reason: error }
					}
					expect(thrown).toEqual({ caught: true, reason })
					expect(thrown.reason).toBe(reason)
					expect(run).not.toHaveBeenCalled()
					expect(created).toBeInstanceOf(BaseTerminalProcess)
					expect(terminal.process).toBeUndefined()
					expect(terminal.busy).toBe(false)
					expect(terminal.running).toBe(false)
					const closed = outcome(created!.waitForOutputFinalization())
					await closeEntered.promise
					expect(created!.isOutputFinalized).toBe(false)
					releaseClose.resolve()
					expect(await closed).toEqual({ status: "fulfilled" })
					expect(onOutputClosed).toHaveBeenCalledOnce()
					expect(completed).not.toHaveBeenCalled()
					expect(physicalExit).not.toHaveBeenCalled()
					const terminalClosed = vi.fn()
					created!.on("terminal_closed", terminalClosed)
					if (terminal instanceof Terminal) terminal.notifyTerminalClosed()
					expect(terminalClosed).not.toHaveBeenCalled()
					expect(created!.listenerCount("continue")).toBe(0)
					expect(created!.listenerCount("line")).toBe(0)
					expect(created!.listenerCount("shell_execution_started")).toBe(0)
				} finally {
					releaseClose.resolve()
					if (returned) await outcome(returned)
					if (created) await outcome(created.finalizeOutput())
					const launched = run.mock.contexts.at(-1)
					if (launched instanceof BaseTerminalProcess) await outcome(launched.finalizeOutput())
					terminal.process = undefined
					terminal.busy = false
					terminal.running = false
				}
			},
		)

		it("does not clear a replacement process when the original creation hook throws", async () => {
			vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir").mockReturnValue(false)
			const terminal = adapter.create()
			const replacement = new OutputProcess()
			const replacementFinalizer = vi.fn()
			replacement.setOutputFinalizer(replacementFinalizer)
			const failure = new Error("synthetic reentrant replacement")
			const closed = deferred<void>()
			let original: BaseTerminalProcess | undefined
			const run = vi.spyOn(adapter.prototype, "run").mockImplementation(async function (
				this: ExecaTerminalProcess | TerminalProcess,
			) {
				await this.finalizeOutput()
				this.emit("continue")
			})
			let returned: AlphaTerminalProcessResultPromise | undefined
			let thrown: unknown
			try {
				try {
					returned = terminal.runCommand(
						"unlaunched original",
						callbacks({
							onOutputClosed: () => closed.resolve(),
							onProcessCreated: (process) => {
								if (!(process instanceof BaseTerminalProcess))
									throw new Error("Unexpected adapter process")
								original = process
								terminal.process = replacement
								terminal.busy = true
								terminal.running = true
								throw failure
							},
						}),
					)
				} catch (error) {
					thrown = error
				}
				expect(thrown).toBe(failure)
				expect(run).not.toHaveBeenCalled()
				expect(terminal.process).toBe(replacement)
				expect(terminal.busy).toBe(true)
				expect(terminal.running).toBe(true)
				await closed.promise
				await original!.waitForOutputFinalization()
				expect(replacementFinalizer).not.toHaveBeenCalled()
				expect(replacement.isOutputFinalized).toBe(false)
			} finally {
				if (returned) await outcome(returned)
				if (original) await outcome(original.finalizeOutput())
				await replacement.finalizeOutput()
				terminal.process = undefined
				terminal.busy = false
				terminal.running = false
			}
		})
	})
}
