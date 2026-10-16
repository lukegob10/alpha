import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ExecaTerminal } from "../ExecaTerminal"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import { OutputInterceptor } from "../OutputInterceptor"
import { ShellIntegrationManager } from "../ShellIntegrationManager"
import { Terminal } from "../Terminal"
import { TerminalProcess } from "../TerminalProcess"
import { TerminalRegistry } from "../TerminalRegistry"
import type { AlphaTerminalCallbacks, AlphaTerminalProcess } from "../types"

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }))
vi.mock("execa", () => ({ execa: execaMock, ExecaError: class extends Error {} }))

const OUTPUT_BUFFER_BYTES = 1_048_576
const OMISSION_ALLOWANCE = 256

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

class InspectableExecaProcess extends ExecaTerminalProcess {
	constructor(readonly fixtureTerminal: ExecaTerminal) {
		super(fixtureTerminal)
	}

	seed(output: string): void {
		this.fullOutput = output
	}

	get retainedBytes(): number {
		return Buffer.byteLength(this.fullOutput)
	}
}

class InspectableVscodeProcess extends TerminalProcess {
	constructor(readonly fixtureTerminal: Terminal) {
		super(fixtureTerminal)
	}

	seed(output: string): void {
		this.fullOutput = output
	}
}

function createExecaProcess(): InspectableExecaProcess {
	const terminal = new ExecaTerminal(1, "/test")
	const process = new InspectableExecaProcess(terminal)
	terminal.process = process
	return process
}

function createVscodeProcess(integrated = false): InspectableVscodeProcess {
	const terminal = new Terminal(
		2,
		{
			shellIntegration: integrated ? { executeCommand: vi.fn() } : undefined,
			exitStatus: undefined,
		} as unknown as vscode.Terminal,
		"/test",
	)
	const process = new InspectableVscodeProcess(terminal)
	terminal.process = process
	return process
}

function mockSubprocess(stream: AsyncIterable<string>, exit: Promise<{ exitCode: number }>): void {
	const subprocess = Object.assign(exit, {
		all: new EventEmitter(),
		iterable: () => stream,
	})
	execaMock.mockImplementation(() => () => subprocess)
}

function drain(process: AlphaTerminalProcess): string {
	let output = ""
	for (let attempt = 0; process.hasUnretrievedOutput(); attempt++) {
		if (attempt >= 128) throw new Error("Bounded command output failed to drain")
		const receipt = process.captureUnretrievedOutput(50_000)
		expect(Buffer.from(receipt.output, "utf8").toString("utf8")).toBe(receipt.output)
		output += receipt.output
		receipt.commit()
	}
	return output
}

afterEach(() => {
	vi.restoreAllMocks()
	execaMock.mockReset()
})

describe("explicit command output polling", () => {
	it.each([
		["Execa", createExecaProcess],
		["VS Code", createVscodeProcess],
	] as const)("returns an active %s prompt before a newline and consumes only after delivery", (_name, create) => {
		const process = create()
		process.seed("READY_WITHOUT_NEWLINE")

		const first = process.captureUnretrievedOutput()
		expect(first.output).toBe("READY_WITHOUT_NEWLINE")
		expect(process.hasUnretrievedOutput()).toBe(true)
		first.release()

		const retry = process.captureUnretrievedOutput()
		expect(retry.output).toBe("READY_WITHOUT_NEWLINE")
		retry.commit()
		expect(process.hasUnretrievedOutput()).toBe(false)
	})

	it.each([
		["Execa", createExecaProcess],
		["VS Code", createVscodeProcess],
	] as const)("preserves complete-line consumption for legacy %s listeners", (_name, create) => {
		const process = create()
		process.seed("one complete line\nPROMPT")
		expect(process.getUnretrievedOutput()).toBe("one complete line\n")
		expect(process.getUnretrievedOutput()).toBe("")
		const poll = process.captureUnretrievedOutput()
		expect(poll.output).toBe("PROMPT")
		poll.commit()
	})

	it("commits a partial ANSI prefix once and exposes later visible bytes without poll churn", () => {
		const process = createVscodeProcess()
		const prefix = "\x1b]8;;https://example.test"
		process.seed(prefix)
		const marker = process.captureUnretrievedOutput()
		expect(marker.output).toBe("")
		marker.commit()
		expect(process.hasUnretrievedOutput()).toBe(false)

		process.seed(prefix + "\x07READY\x1b]8;;\x07")
		const visible = process.captureUnretrievedOutput()
		expect(visible.output).toBe("READY")
		visible.release()
		const retry = process.captureUnretrievedOutput()
		expect(retry.output).toBe("READY")
		retry.commit()
		expect(process.hasUnretrievedOutput()).toBe(false)
	})
})

describe("closed terminal output ownership", () => {
	it("notifies a failed reader through host close and closed lookup after exitStatus is already set", async () => {
		let onClose!: (terminal: vscode.Terminal) => unknown
		vi.spyOn(vscode.window, "onDidCloseTerminal").mockImplementation((listener) => {
			onClose = listener
			return { dispose: vi.fn() }
		})
		vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir").mockReturnValue(false)
		vi.spyOn(ShellIntegrationManager, "clear").mockImplementation(() => undefined)
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		const createTerminal = vi.spyOn(vscode.window, "createTerminal")
		TerminalRegistry.initialize()
		try {
			for (const route of ["host close after finalization", "closed lookup during finalization"] as const) {
				const accepted = deferred<void>()
				const failReader = deferred<void>()
				const closeEntered = deferred<void>()
				const releaseClose = deferred<void>()
				const finalized = deferred<void>()
				const failure = new Error(`synthetic failed reader: ${route}`)
				const onCompleted = vi.fn()
				const onShellExecutionComplete = vi.fn()
				const onOutputClosed = vi.fn(async () => {
					closeEntered.resolve()
					await releaseClose.promise
				})
				const native = {
					exitStatus: undefined as vscode.TerminalExitStatus | undefined,
					shellIntegration: {
						executeCommand: () => {
							terminal.setActiveStream(
								(async function* () {
									yield "\x1b]633;C\x07PARTIAL_READER_OUTPUT"
									await failReader.promise
									throw failure
								})(),
							)
						},
					},
				}
				createTerminal.mockReturnValueOnce(native as unknown as vscode.Terminal)
				const terminal = TerminalRegistry.createTerminal("/test", "vscode") as Terminal
				terminal.taskId = `closed-reader-${route}`
				const process = terminal.runCommand("synthetic closed reader", {
					onLine: vi.fn(),
					onOutput: () => accepted.resolve(),
					onOutputClosed,
					onCompleted,
					onShellExecutionStarted: vi.fn(),
					onShellExecutionComplete,
				})
				const errors = vi.fn()
				process.on("error", errors)
				process.once("finalized", () => finalized.resolve())
				const outcome = process.then(
					() => ({ status: "success" as const }),
					(error: unknown) => ({ status: "error" as const, error }),
				)
				try {
					await accepted.promise
					failReader.resolve()
					await closeEntered.promise
					expect(await outcome).toEqual({ status: "error", error: failure })
					if (route === "host close after finalization") {
						releaseClose.resolve()
						await finalized.promise
					} else expect(process.isOutputFinalized).toBe(false)
					expect(terminal.running).toBe(true)
					native.exitStatus = { code: 0 } as vscode.TerminalExitStatus
					if (route === "host close after finalization") onClose(native as unknown as vscode.Terminal)
					else expect(TerminalRegistry.getTerminals(true, terminal.taskId)).toEqual([])
					expect(terminal.running).toBe(false)
					expect(terminal.busy).toBe(false)
					expect(terminal.process).toBeUndefined()
					releaseClose.resolve()
					await finalized.promise
					expect(process.isOutputFinalized).toBe(true)
					expect(process.outputArchiveInterrupted).toBe(true)
					expect(process.outputArtifactId).toBeUndefined()
					expect(onOutputClosed).toHaveBeenCalledOnce()
					expect(errors).toHaveBeenCalledExactlyOnceWith(failure)
					expect(onCompleted).not.toHaveBeenCalled()
					expect(onShellExecutionComplete).not.toHaveBeenCalled()
					expect(TerminalRegistry.getTerminals(true, terminal.taskId)).toEqual([])
				} finally {
					failReader.resolve()
					releaseClose.resolve()
					await outcome
					if (terminal.running) terminal.notifyTerminalClosed()
				}
			}
		} finally {
			TerminalRegistry.cleanup()
		}
	})
})

describe("bounded live command output", () => {
	it("reclaims delivered output during a long-lived stream without losing later receipts", async () => {
		const produced = deferred<void>()
		const closeOutput = deferred<void>()
		const exit = deferred<{ exitCode: number }>()
		const chunk = "x".repeat(65_535) + "\n"
		mockSubprocess(
			(async function* () {
				for (let index = 0; index < 128; index++) yield chunk
				produced.resolve()
				await closeOutput.promise
			})(),
			exit.promise,
		)
		const process = createExecaProcess()
		process.continue()
		let deliveredBytes = 0
		let retainedBytes = 0
		process.on("output_available", () => {
			const output = drain(process)
			expect(output).toBe(chunk)
			deliveredBytes += Buffer.byteLength(output)
			retainedBytes = Math.max(retainedBytes, process.retainedBytes)
		})
		const run = process.run("synthetic repeated output drains")
		try {
			await produced.promise
			expect(process.isSettled).toBe(false)
			expect(deliveredBytes).toBe(128 * Buffer.byteLength(chunk))
			expect(retainedBytes).toBeLessThanOrEqual(OUTPUT_BUFFER_BYTES + OMISSION_ALLOWANCE)
			expect(process.hasUnretrievedOutput()).toBe(false)
		} finally {
			closeOutput.resolve()
			exit.resolve({ exitCode: 0 })
			await run
		}
	})

	it("cleans a VS Code completion marker spanning retained head and tail without an omission", async () => {
		const process = createVscodeProcess(true)
		const prefix = "x".repeat(OUTPUT_BUFFER_BYTES / 2 - 2)
		const body = prefix + "\x1b]8;;https://example.test\x07LINK\x1b]8;;\x07"
		const completed = vi.fn()
		process.on("completed", completed)
		const run = process.run("synthetic marker boundary")
		process.emit(
			"stream_available",
			(async function* () {
				yield "\x1b]633;C\x07" + body
				process.emit("shell_execution_complete", { exitCode: 0 })
			})(),
		)
		await run
		expect(completed).toHaveBeenCalledExactlyOnceWith(prefix + "LINK")
	})

	it("preserves completion order when a multibyte code point crosses the head budget", async () => {
		const chunks = ["x".repeat(OUTPUT_BUFFER_BYTES / 2 - 1), "🚀", "a"]
		mockSubprocess(
			(async function* () {
				for (const chunk of chunks) yield chunk
			})(),
			Promise.resolve({ exitCode: 0 }),
		)
		const process = createExecaProcess()
		const completed = vi.fn()
		process.on("completed", completed)
		await process.run("synthetic chunk boundary")
		expect(completed).toHaveBeenCalledExactlyOnceWith(chunks.join(""))
	})

	it("caps retained active output while retaining an explicit omission and the latest tail", async () => {
		const produced = deferred<void>()
		const closeOutput = deferred<void>()
		const exit = deferred<{ exitCode: number }>()
		const chunk = "x".repeat(65_535) + "\n"
		mockSubprocess(
			(async function* () {
				yield "FIRST_BYTES\n"
				for (let index = 0; index < 32; index++) yield chunk
				yield "LATEST_BYTES\n"
				produced.resolve()
				await closeOutput.promise
			})(),
			exit.promise,
		)
		const process = createExecaProcess()
		process.continue()
		const run = process.run("synthetic noisy command")
		try {
			await produced.promise
			expect(process.isSettled).toBe(false)
			expect(process.retainedBytes).toBeLessThanOrEqual(OUTPUT_BUFFER_BYTES + OMISSION_ALLOWANCE)
			const output = drain(process)
			expect(Buffer.byteLength(output)).toBeLessThanOrEqual(OUTPUT_BUFFER_BYTES + OMISSION_ALLOWANCE)
			expect(output).toContain("FIRST_BYTES")
			expect(output).toMatch(/omitted/i)
			expect(output).toContain("LATEST_BYTES")
			expect(process.retainedBytes).toBeLessThanOrEqual(OUTPUT_BUFFER_BYTES + OMISSION_ALLOWANCE)
		} finally {
			closeOutput.resolve()
			exit.resolve({ exitCode: 0 })
			await run
		}
	})

	it.each(["commit", "release"] as const)(
		"keeps a reserved receipt coherent across overflow and %s",
		async (delivery) => {
			const initialReady = deferred<void>()
			const appendMore = deferred<void>()
			const overflowReady = deferred<void>()
			const closeOutput = deferred<void>()
			const exit = deferred<{ exitCode: number }>()
			const prefix = "RESERVED_PREFIX\n"
			mockSubprocess(
				(async function* () {
					yield prefix
					initialReady.resolve()
					await appendMore.promise
					for (let index = 0; index < 32; index++) yield "x".repeat(65_535) + "\n"
					yield "TAIL_AFTER_RESERVATION\n"
					overflowReady.resolve()
					await closeOutput.promise
				})(),
				exit.promise,
			)
			const process = createExecaProcess()
			process.continue()
			const run = process.run("synthetic output pressure")
			try {
				await initialReady.promise
				const reserved = process.captureUnretrievedOutput(prefix.length)
				expect(reserved.output).toBe(prefix)
				appendMore.resolve()
				await overflowReady.promise
				expect(reserved.output).toBe(prefix)
				expect(process.retainedBytes).toBeLessThanOrEqual(OUTPUT_BUFFER_BYTES + OMISSION_ALLOWANCE)
				if (delivery === "release") {
					reserved.release()
					const retry = process.captureUnretrievedOutput(prefix.length)
					expect(retry.output).toBe(prefix)
					retry.commit()
				} else reserved.commit()
				reserved.commit()
				reserved.release()
				const remaining = drain(process)
				expect(remaining).not.toContain("RESERVED_PREFIX")
				expect(remaining).toContain("TAIL_AFTER_RESERVATION")
				expect(remaining).toMatch(/omitted/i)
			} finally {
				appendMore.resolve()
				closeOutput.resolve()
				exit.resolve({ exitCode: 0 })
				await run
			}
		},
	)

	it("bounds multibyte output without manufacturing replacement characters", async () => {
		const produced = deferred<void>()
		const closeOutput = deferred<void>()
		const exit = deferred<{ exitCode: number }>()
		mockSubprocess(
			(async function* () {
				for (let index = 0; index < 48; index++) yield "🚀é".repeat(8_192) + "\n"
				yield "UNICODE_TAIL\n"
				produced.resolve()
				await closeOutput.promise
			})(),
			exit.promise,
		)
		const process = createExecaProcess()
		process.continue()
		const run = process.run("synthetic Unicode output")
		try {
			await produced.promise
			const output = drain(process)
			expect(Buffer.byteLength(output)).toBeLessThanOrEqual(OUTPUT_BUFFER_BYTES + OMISSION_ALLOWANCE)
			expect(output).not.toContain("\ufffd")
			expect(output).toContain("UNICODE_TAIL")
		} finally {
			closeOutput.resolve()
			exit.resolve({ exitCode: 0 })
			await run
		}
	})

	it("archives raw output after backgrounding without depending on line listeners", async () => {
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-archive-")))
		const interceptor = new OutputInterceptor({
			executionId: "1706119234567",
			taskId: "archive-owner",
			command: "synthetic archival command",
			storageDir: directory,
			previewSize: "small",
		})
		const startOutput = deferred<void>()
		const produced = deferred<void>()
		const closeOutput = deferred<void>()
		const exit = deferred<{ exitCode: number }>()
		const completed = deferred<void>()
		const chunks = [
			"no newline",
			...Array.from({ length: 32 }, (_, index) => `${index}:` + "x".repeat(65_536) + "\n"),
			"FINAL_PARTIAL",
		]
		mockSubprocess(
			(async function* () {
				await startOutput.promise
				for (const chunk of chunks) yield chunk
				produced.resolve()
				await closeOutput.promise
			})(),
			exit.promise,
		)
		const archived: string[] = []
		let artifactPath: string | null = null
		const callbacks: AlphaTerminalCallbacks & { onOutput: (chunk: string) => Promise<void> } = {
			onLine: vi.fn(),
			onOutput: async (chunk) => {
				archived.push(chunk)
				await interceptor.writeWithBackpressure(chunk)
			},
			onCompleted: async () => {
				try {
					artifactPath = (await interceptor.finalize()).artifactPath
				} finally {
					completed.resolve()
				}
			},
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		}
		const terminal = new ExecaTerminal(3, "/test")
		const process = terminal.runCommand("synthetic archival command", callbacks)
		process.continue()
		try {
			startOutput.resolve()
			await produced.promise
			expect(archived.join("")).toBe(chunks.join(""))
			expect(callbacks.onLine).not.toHaveBeenCalled()
			expect(process.isSettled).toBe(false)
			closeOutput.resolve()
			exit.resolve({ exitCode: 0 })
			await completed.promise
			expect(artifactPath).not.toBeNull()
			if (!artifactPath) throw new Error("Expected a complete command output artifact")
			expect(await fs.readFile(artifactPath, "utf8")).toBe(chunks.join(""))
		} finally {
			closeOutput.resolve()
			exit.resolve({ exitCode: 0 })
			await completed.promise
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("backpressures a pending archival sink and keeps physical ownership after its failure", async () => {
		const startOutput = deferred<void>()
		const sinkEntered = deferred<void>()
		const sinkResult = deferred<void>()
		const readPastFirst = deferred<void>()
		const failureSeen = deferred<void>()
		const exit = deferred<{ exitCode: number }>()
		const completed = deferred<void>()
		const failure = new Error("archival sink failed")
		let readAhead = false
		let calledSink = false
		void sinkResult.promise.catch(() => undefined)
		vi.spyOn(console, "error").mockImplementation(() => failureSeen.resolve())
		mockSubprocess(
			(async function* () {
				await startOutput.promise
				yield "FIRST_CHUNK\n"
				readAhead = true
				readPastFirst.resolve()
				yield "SECOND_CHUNK\n"
			})(),
			exit.promise,
		)
		const callbacks: AlphaTerminalCallbacks & { onOutput: (chunk: string) => Promise<void> } = {
			onLine: vi.fn(),
			onOutput: async () => {
				calledSink = true
				sinkEntered.resolve()
				await sinkResult.promise
			},
			onCompleted: () => completed.resolve(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		}
		const terminal = new ExecaTerminal(4, "/test")
		const process = terminal.runCommand("synthetic stalled archival sink", callbacks)
		const outcome = process.then(
			() => ({ status: "success" as const }),
			(error: unknown) => ({ status: "error" as const, error }),
		)
		try {
			startOutput.resolve()
			await Promise.race([sinkEntered.promise, readPastFirst.promise])
			expect(calledSink).toBe(true)
			expect(readAhead).toBe(false)
			sinkResult.reject(failure)
			await failureSeen.promise
			expect(process.isSettled).toBe(false)
			expect(terminal.running).toBe(true)
			expect(terminal.process).toBe(process)
			exit.resolve({ exitCode: 0 })
			expect(await outcome).toEqual({ status: "error", error: failure })
			await completed.promise
		} finally {
			sinkResult.resolve()
			exit.resolve({ exitCode: 0 })
			await outcome
			await completed.promise
		}
	})

	it("cancels a blocked archival writer while retaining ownership until physical exit", async () => {
		const startOutput = deferred<void>()
		const sinkEntered = deferred<void>()
		const writerReleased = deferred<void>()
		const readPastFirst = deferred<void>()
		const exit = deferred<{ exitCode: number }>()
		const completed = deferred<void>()
		let sinkSignal: AbortSignal | undefined
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		mockSubprocess(
			(async function* () {
				await startOutput.promise
				yield "FIRST_CHUNK\n"
				readPastFirst.resolve()
				yield "SECOND_CHUNK\n"
			})(),
			exit.promise,
		)
		const callbacks: AlphaTerminalCallbacks & {
			onOutput: (chunk: string, process: AlphaTerminalProcess, signal: AbortSignal) => Promise<void>
		} = {
			onLine: vi.fn(),
			onOutput: async (_chunk, _process, signal) => {
				sinkSignal = signal
				let onAbort!: () => void
				try {
					await new Promise<void>((_resolve, reject) => {
						onAbort = () => reject(signal.reason)
						signal.addEventListener("abort", onAbort, { once: true })
						sinkEntered.resolve()
						if (signal.aborted) onAbort()
					})
				} finally {
					signal.removeEventListener("abort", onAbort)
					writerReleased.resolve()
				}
			},
			onCompleted: () => completed.resolve(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		}
		const terminal = new ExecaTerminal(5, "/test")
		const process = terminal.runCommand("synthetic cancelled archival sink", callbacks)
		const outcome = process.then(
			() => ({ status: "success" as const }),
			(error: unknown) => ({ status: "error" as const, error }),
		)
		try {
			startOutput.resolve()
			await Promise.race([sinkEntered.promise, readPastFirst.promise])
			expect(sinkSignal).toBeDefined()
			await process.abort()
			await writerReleased.promise
			expect(sinkSignal?.aborted).toBe(true)
			expect(process.isSettled).toBe(false)
			expect(terminal.process).toBe(process)
			expect(terminal.running).toBe(true)
			exit.resolve({ exitCode: 0 })
			await outcome
			await completed.promise
			expect(terminal.process).toBeUndefined()
			expect(terminal.running).toBe(false)
		} finally {
			exit.resolve({ exitCode: 0 })
			await outcome
			await completed.promise
		}
	})

	it("does not cancel an already delivered archival chunk when the command is stopped", async () => {
		const startOutput = deferred<void>()
		const produced = deferred<void>()
		const closeOutput = deferred<void>()
		const exit = deferred<{ exitCode: number }>()
		let sinkSignal: AbortSignal | undefined
		mockSubprocess(
			(async function* () {
				await startOutput.promise
				yield "ARCHIVED_BEFORE_STOP\n"
				produced.resolve()
				await closeOutput.promise
			})(),
			exit.promise,
		)
		const callbacks: AlphaTerminalCallbacks & {
			onOutput: (chunk: string, process: AlphaTerminalProcess, signal: AbortSignal) => Promise<void>
		} = {
			onLine: vi.fn(),
			onOutput: async (_chunk, _process, signal) => {
				sinkSignal = signal
			},
			onCompleted: vi.fn(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		}
		const terminal = new ExecaTerminal(6, "/test")
		const process = terminal.runCommand("synthetic stopped archival command", callbacks)
		try {
			startOutput.resolve()
			await produced.promise
			expect(sinkSignal).toBeDefined()
			await process.abort()
			expect(sinkSignal?.aborted).toBe(false)
			closeOutput.resolve()
			exit.resolve({ exitCode: 0 })
			await process
			expect(callbacks.onCompleted).toHaveBeenCalledOnce()
		} finally {
			closeOutput.resolve()
			exit.resolve({ exitCode: 0 })
			await process
		}
	})
})
