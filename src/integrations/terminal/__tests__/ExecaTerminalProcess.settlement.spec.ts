const execaMock = vitest.hoisted(() => vitest.fn())
const execFileMock = vitest.hoisted(() => vitest.fn())

vitest.mock("execa", () => ({ execa: execaMock, ExecaError: class extends Error {} }))
vitest.mock("node:child_process", () => ({ execFile: execFileMock }))
vitest.mock("ps-tree", () => ({ default: vitest.fn((_pid, callback) => callback(null, [])) }))

import { ExecaError } from "execa"
import { EventEmitter, captureRejectionSymbol } from "node:events"

import { ExecaTerminal } from "../ExecaTerminal"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

describe("ExecaTerminalProcess physical settlement", () => {
	let platform: PropertyDescriptor | undefined

	beforeEach(() => {
		platform = Object.getOwnPropertyDescriptor(process, "platform")
		Object.defineProperty(process, "platform", { value: "win32" })
		execaMock.mockReset()
		execFileMock.mockReset()
	})

	afterEach(() => {
		if (platform) Object.defineProperty(process, "platform", platform)
		vitest.restoreAllMocks()
	})

	it.each([
		"reader",
		"Execa reader",
		"line callback",
		"async line callback",
		"merged output",
		"reader after failed termination",
		"reader and finalization",
		"reader and rejected error observer",
	])("keeps a living subprocess owned after a %s failure", async (source) => {
		const failure =
			source === "Execa reader"
				? Object.assign(new ExecaError(), { message: `${source} failed` })
				: new Error(`${source} failed`)
		const retryTermination = source === "reader after failed termination"
		if (retryTermination) vitest.spyOn(process, "kill").mockReturnValue(true)
		const failureRaised = deferred<void>()
		const lineFailure = deferred<void>()
		void lineFailure.promise.catch(() => undefined)
		const physicalExit = deferred<{ exitCode: number }>()
		const killRequested = deferred<void>()
		const killAcknowledged = deferred<void>()
		const errorLog = vitest.spyOn(console, "error").mockImplementation(() => undefined)
		const shellComplete = vitest.fn()
		const completed = vitest.fn(() =>
			source === "reader and finalization"
				? Promise.reject(new Error("Secondary finalization failure"))
				: undefined,
		)
		const failed = vitest.fn()
		const outputStream = new EventEmitter()
		let alive = true
		void physicalExit.promise.catch(() => undefined)
		const subprocess = Object.assign(physicalExit.promise, {
			pid: 12_345,
			all: outputStream,
			iterable: () =>
				(async function* () {
					try {
						yield "ready\n"
						if (source === "merged output") {
							failureRaised.resolve()
							outputStream.emit("error", failure)
							await physicalExit.promise.catch(() => undefined)
						} else if (source === "async line callback") {
							await physicalExit.promise.catch(() => undefined)
						} else if (source !== "line callback") {
							failureRaised.resolve()
							throw failure
						}
					} finally {
						if (source === "line callback") await physicalExit.promise.catch(() => undefined)
					}
				})(),
			kill: vitest.fn(),
		})
		execaMock.mockImplementation(() => () => subprocess)
		execFileMock.mockImplementation((_file, _args, _options, callback) => {
			if (retryTermination && execFileMock.mock.calls.length === 1) {
				callback(Object.assign(new Error("access denied"), { code: 5 }), "", "")
				return {}
			}
			killRequested.resolve()
			void killAcknowledged.promise.then(() => callback(null, "", ""))
			return {}
		})
		const terminal = new ExecaTerminal(1, "/test/cwd")
		const command = terminal.runCommand("long-running-command", {
			onLine: () => {
				if (source === "async line callback") {
					failureRaised.resolve()
					return lineFailure.promise
				}
				if (source === "line callback") {
					failureRaised.resolve()
					throw failure
				}
				return undefined
			},
			onCompleted: completed,
			onShellExecutionStarted: vitest.fn(),
			onShellExecutionComplete: shellComplete,
		})
		command.on("error", failed)
		if (source === "reader and rejected error observer") {
			command.on("error", () => Promise.reject(new Error("Secondary error observer failure")))
		}
		const outcome = command.then(
			() => ({ status: "success" as const }),
			(error: unknown) => ({ status: "error" as const, error }),
		)

		try {
			await failureRaised.promise
			if (source === "async line callback") lineFailure.reject(failure)
			await vitest.waitFor(() => expect(errorLog).toHaveBeenCalledTimes(retryTermination ? 2 : 1))
			expect(alive).toBe(true)
			expect(command.isSettled).toBe(false)
			expect(terminal.running).toBe(true)
			expect(terminal.busy).toBe(true)
			expect(terminal.process).toBe(command)
			expect(shellComplete).not.toHaveBeenCalled()
			expect(completed).not.toHaveBeenCalled()
			expect(failed).not.toHaveBeenCalled()

			const firstStop = command.abort()
			expect(command.abort()).toBe(firstStop)
			await killRequested.promise
			expect(execFileMock).toHaveBeenCalledTimes(retryTermination ? 2 : 1)
			expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual(["taskkill.exe", ["/PID", "12345", "/T", "/F"]])
			killAcknowledged.resolve()
			await firstStop
			// Termination acknowledgement alone is not evidence of subprocess exit.
			expect(command.isSettled).toBe(false)
			expect(terminal.process).toBe(command)
			expect(shellComplete).not.toHaveBeenCalled()

			alive = false
			physicalExit.reject(Object.assign(new ExecaError(), { signal: "SIGKILL" }))
			const result = await outcome
			if (retryTermination) {
				expect(result).toMatchObject({
					status: "error",
					error: { message: "Command output failed and process-tree termination failed" },
				})
				if (result.status !== "error" || !(result.error instanceof AggregateError)) {
					throw new Error("Expected the output and process termination failure to remain observable")
				}
				expect(result.error.errors).toEqual([
					failure,
					expect.objectContaining({ message: expect.stringContaining("access denied") }),
				])
			} else {
				expect(result).toEqual({ status: "error", error: failure })
			}
			expect(command.isSettled).toBe(true)
			expect(terminal.running).toBe(false)
			expect(terminal.busy).toBe(false)
			expect(terminal.process).toBeUndefined()
			expect(failed).toHaveBeenCalledExactlyOnceWith(result.status === "error" ? result.error : undefined)
			expect(completed).toHaveBeenCalledExactlyOnceWith("ready\n", command)
			expect(shellComplete).toHaveBeenCalledExactlyOnceWith(
				{ exitCode: undefined, signalName: "SIGKILL" },
				command,
			)
			if (source === "reader and rejected error observer") {
				await new Promise<void>((resolve) => setImmediate(resolve))
				expect(errorLog).toHaveBeenCalledTimes(2)
				expect(
					(command as unknown as ExecaTerminalProcess)[captureRejectionSymbol](failure, "error"),
				).toBeUndefined()
			}
		} finally {
			alive = false
			killAcknowledged.resolve()
			physicalExit.resolve({ exitCode: 0 })
			await outcome
		}
	})

	it("retains ownership after output EOF until the subprocess actually exits", async () => {
		const outputClosed = deferred<void>()
		const physicalExit = deferred<{ exitCode: number }>()
		const outputStream = new EventEmitter()
		execaMock.mockImplementation(
			() => () =>
				Object.assign(physicalExit.promise, {
					pid: 12_345,
					all: outputStream,
					iterable: () =>
						(async function* () {
							yield "ready\n"
							outputClosed.resolve()
						})(),
				}),
		)
		const terminal = new ExecaTerminal(2, "/test/cwd")
		const completed = vitest.fn()
		const shellComplete = vitest.fn()
		const command = terminal.runCommand("long-running-command", {
			onLine: vitest.fn(),
			onCompleted: completed,
			onShellExecutionStarted: vitest.fn(),
			onShellExecutionComplete: shellComplete,
		})
		try {
			await outputClosed.promise
			expect(command.isSettled).toBe(false)
			expect(terminal.process).toBe(command)
			expect(terminal.running).toBe(true)
			expect(completed).not.toHaveBeenCalled()
			expect(shellComplete).not.toHaveBeenCalled()
			physicalExit.resolve({ exitCode: 0 })
			await command
			expect(completed).toHaveBeenCalledExactlyOnceWith("ready\n", command)
			expect(shellComplete).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 }, command)
			expect(command.isSettled).toBe(true)
			expect(terminal.process).toBeUndefined()
			expect(outputStream.listenerCount("error")).toBe(0)
		} finally {
			physicalExit.resolve({ exitCode: 0 })
			await command
		}
	})

	it.each(["synchronous", "asynchronous", "shell outcome", "late output"])(
		"fails a command when its %s completed observer fails after exit",
		async (source) => {
			const failure = new Error("Finalization observer failed")
			const physicalExit = deferred<{ exitCode: number }>()
			const observerCalled = deferred<void>()
			const observerResult = deferred<void>()
			const lineResult = deferred<void>()
			void lineResult.promise.catch(() => undefined)
			void observerResult.promise.catch(() => undefined)
			// Observe the old fire-and-forget run rejection so the regression can
			// assert the missing terminal event instead of leaking a test rejection.
			const escapedRunFailure = vitest.fn()
			const originalRun = ExecaTerminalProcess.prototype.run
			vitest.spyOn(ExecaTerminalProcess.prototype, "run").mockImplementation(function (
				this: ExecaTerminalProcess,
				command,
			) {
				return originalRun.call(this, command).catch(escapedRunFailure)
			})
			vitest.spyOn(console, "error").mockImplementation(() => undefined)
			const outputStream = new EventEmitter()
			execaMock.mockImplementation(
				() => () =>
					Object.assign(physicalExit.promise, {
						pid: 12_345,
						all: outputStream,
						iterable: () =>
							(async function* () {
								yield "ready\n"
							})(),
					}),
			)
			const terminal = new ExecaTerminal(3, "/test/cwd")
			const completed = vitest.fn(() => {
				observerCalled.resolve()
				if (source === "synchronous") throw failure
				if (source === "asynchronous") return observerResult.promise
				return undefined
			})
			const command = terminal.runCommand("command", {
				onLine: vitest.fn(() => (source === "late output" ? lineResult.promise : undefined)),
				onCompleted: completed,
				onShellExecutionStarted: vitest.fn(),
				onShellExecutionComplete: vitest.fn(() => {
					if (source === "shell outcome") throw failure
				}),
			})
			const failed = vitest.fn()
			const laterCompletedObserver = vitest.fn()
			const continued = vitest.fn()
			command.on("error", failed)
			command.once("completed", laterCompletedObserver)
			command.on("continue", continued)
			let outcomeObserved = false
			const outcome = command
				.then(
					() => ({ status: "success" as const }),
					(error: unknown) => ({ status: "error" as const, error }),
				)
				.then((result) => {
					outcomeObserved = true
					return result
				})
			try {
				physicalExit.resolve({ exitCode: 0 })
				await observerCalled.promise
				await new Promise<void>((resolve) => setImmediate(resolve))
				if (source === "asynchronous" || source === "late output") {
					expect(outcomeObserved).toBe(false)
					if (source === "asynchronous") observerResult.reject(failure)
					else lineResult.reject(failure)
				}
				await vitest.waitFor(() => expect(failed).toHaveBeenCalledExactlyOnceWith(failure))
				expect(await outcome).toEqual({ status: "error", error: failure })
				expect(completed).toHaveBeenCalledOnce()
				expect(laterCompletedObserver).toHaveBeenCalledExactlyOnceWith("ready\n")
				expect(command.listenerCount("completed")).toBe(0)
				expect(continued).toHaveBeenCalledOnce()
				expect(escapedRunFailure).not.toHaveBeenCalled()
				expect(command.isSettled).toBe(true)
				expect(command.isHot).toBe(false)
				expect(terminal.process).toBeUndefined()
				expect(terminal.running).toBe(false)
				expect(terminal.busy).toBe(false)
				expect((command as unknown as ExecaTerminalProcess)["subprocess"]).toBeUndefined()
				expect(outputStream.listenerCount("error")).toBe(0)
			} finally {
				physicalExit.resolve({ exitCode: 0 })
				observerResult.resolve()
				lineResult.resolve()
				if (!outcomeObserved) command.emit("continue")
				await outcome
			}
		},
	)

	it("backpressures a bounded batch of async output callbacks while preserving streaming order", async () => {
		const lineResult = deferred<void>()
		const batchFull = deferred<void>()
		let clock = 0
		vitest.spyOn(Date, "now").mockImplementation(() => (clock += 501))
		execaMock.mockImplementation(
			() => () =>
				Object.assign(Promise.resolve({ exitCode: 0 }), {
					pid: 12_345,
					iterable: () =>
						(async function* () {
							for (let index = 0; index < 32; index++) yield `${index}\n`
						})(),
				}),
		)
		const lines: string[] = []
		const completed = vitest.fn()
		const terminal = new ExecaTerminal(4, "/test/cwd")
		const command = terminal.runCommand("command", {
			onLine: (line) => {
				lines.push(line)
				if (lines.length === 16) batchFull.resolve()
				return lineResult.promise
			},
			onCompleted: completed,
			onShellExecutionStarted: vitest.fn(),
			onShellExecutionComplete: vitest.fn(),
		})
		try {
			await batchFull.promise
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(lines).toHaveLength(16)
			expect(completed).not.toHaveBeenCalled()
			lineResult.resolve()
			await command
			expect(lines).toEqual(Array.from({ length: 32 }, (_, index) => `${index}\n`))
			expect(completed).toHaveBeenCalledOnce()
			expect(terminal.process).toBeUndefined()
			expect((command as unknown as ExecaTerminalProcess)["pendingLineObservers"].size).toBe(0)
		} finally {
			lineResult.resolve()
			await command
		}
	})

	it.each(["completed listener", "final cleanup"])(
		"leaves a replacement command owned when an older %s settles",
		async (source) => {
			const observerCalled = deferred<void>()
			const observerResult = deferred<void>()
			const replacementStarted = deferred<void>()
			const replacementExit = deferred<{ exitCode: number }>()
			execaMock.mockImplementationOnce(
				() => () =>
					Object.assign(Promise.resolve({ exitCode: 0 }), {
						pid: 12_345,
						iterable: () =>
							(async function* () {
								yield "finished\n"
							})(),
					}),
			)
			execaMock.mockImplementationOnce(
				() => () =>
					Object.assign(replacementExit.promise, {
						pid: 12_346,
						iterable: () =>
							(async function* () {
								yield "running\n"
								await replacementExit.promise
							})(),
					}),
			)
			const terminal = new ExecaTerminal(5, "/test/cwd")
			const startReplacement = () =>
				terminal.runCommand("replacement", {
					onLine: vitest.fn(),
					onCompleted: vitest.fn(),
					onShellExecutionStarted: () => replacementStarted.resolve(),
					onShellExecutionComplete: vitest.fn(),
				})
			const original = terminal.runCommand("original", {
				onLine: vitest.fn(),
				onCompleted: () => {
					observerCalled.resolve()
					return observerResult.promise
				},
				onShellExecutionStarted: vitest.fn(),
				onShellExecutionComplete: vitest.fn(),
			})
			let replacementFromObserver: ReturnType<ExecaTerminal["runCommand"]> | undefined
			if (source === "completed listener") {
				original.prependOnceListener("completed", () => {
					replacementFromObserver = startReplacement()
				})
			}
			await observerCalled.promise
			const replacement = replacementFromObserver ?? startReplacement()
			try {
				await replacementStarted.promise
				expect(terminal.isStreamClosed).toBe(false)
				expect(terminal.busy).toBe(true)
				observerResult.resolve()
				await original
				expect(terminal.process).toBe(replacement)
				expect(terminal.running).toBe(true)
				expect(terminal.busy).toBe(true)
				expect(terminal.isStreamClosed).toBe(false)
			} finally {
				observerResult.resolve()
				replacementExit.resolve({ exitCode: 0 })
				await Promise.all([original, replacement])
			}
		},
	)
})
