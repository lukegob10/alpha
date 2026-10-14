import { execa, ExecaError } from "execa"
import psTree from "ps-tree"
import process from "process"
import { execFile, type ExecFileException } from "node:child_process"
import { captureRejectionSymbol } from "node:events"

import type { AlphaTerminal, ExitCodeDetails } from "./types"
import { BaseTerminal } from "./BaseTerminal"
import { BaseTerminalProcess } from "./BaseTerminalProcess"

const PROCESS_TERMINATION_TIMEOUT_MS = 5_000
const PROCESS_SETTLEMENT_POLL_MS = 25
const PID_UPDATE_TIMEOUT_MS = 1_000
const MAX_PENDING_LINE_OBSERVERS = 16

export class ExecaTerminalProcess extends BaseTerminalProcess {
	private terminalRef: WeakRef<AlphaTerminal>
	private aborted = false
	private pid?: number
	private subprocess?: ReturnType<typeof execa>
	private pidUpdatePromise?: Promise<void>
	private abortPromise?: Promise<void>
	private handleListenerRejection?: (error: unknown) => void
	private readonly pendingLineObservers = new Set<Promise<void>>()

	constructor(terminal: AlphaTerminal) {
		super({ captureRejections: true })

		this.terminalRef = new WeakRef(terminal)

		this.once("completed", () => {
			if (!this.terminal.process || this.terminal.process === this) this.terminal.busy = false
		})
	}

	public get terminal(): AlphaTerminal {
		const terminal = this.terminalRef.deref()

		if (!terminal) {
			throw new Error("Unable to dereference terminal")
		}

		return terminal
	}

	public override async run(command: string) {
		this.command = command
		let processSettlement: Promise<PromiseSettledResult<Awaited<ReturnType<typeof execa>>>> | undefined
		let processFailure: Error | undefined
		let outputFailureTermination: Promise<void> | undefined
		let removeOutputFailureListener: (() => void) | undefined
		let exitDetails: ExitCodeDetails = { exitCode: undefined }
		let physicalProcessSettled = false
		const stopAfterOutputFailure = (error: unknown): Promise<void> => {
			if (outputFailureTermination) return outputFailureTermination
			processFailure = error instanceof Error ? error : new Error(String(error))
			if (error instanceof ExecaError) {
				console.error("[ExecaTerminalProcess#run] command process failed", {
					code: error.code,
					signal: error.signal,
				})
			} else {
				console.error(`[ExecaTerminalProcess#run] shell execution error: ${processFailure.message}`)
			}
			outputFailureTermination = (physicalProcessSettled ? Promise.resolve() : this.startTermination()).catch(
				(terminationError) => {
					processFailure = new AggregateError(
						[processFailure, terminationError],
						"Command output failed and process-tree termination failed",
					)
					console.error("[ExecaTerminalProcess#run] process-tree termination failed")
				},
			)
			return outputFailureTermination
		}
		this.handleListenerRejection = (error) => void stopAfterOutputFailure(error)

		try {
			this.isHot = true

			this.subprocess = execa({
				shell: BaseTerminal.getExecaShellPath() || true,
				windowsHide: true,
				cwd: this.terminal.getCurrentWorkingDirectory(),
				all: true,
				// Alpha owns the complete output and receipts. Avoid Execa retaining
				// another stdout/stderr/all copy of the same command output.
				buffer: false,
				// Ignore stdin to ensure non-interactive mode and prevent hanging
				stdin: "ignore",
				env: {
					...process.env,
					...this.terminal.commandEnv,
					// Ensure UTF-8 encoding for Ruby, CocoaPods, etc.
					LANG: "en_US.UTF-8",
					LC_ALL: "en_US.UTF-8",
				},
			})`${command}`
			// Observe rejection immediately, and retain physical process ownership
			// independently of the output iterator or its presentation callbacks.
			processSettlement = Promise.allSettled([this.subprocess]).then(([outcome]) => outcome)
			const outputStream = this.subprocess.all
			if (outputStream) {
				const onOutputError = (error: unknown) => void stopAfterOutputFailure(error)
				outputStream.once("error", onOutputError)
				removeOutputFailureListener = () => outputStream.removeListener("error", onOutputError)
			}

			this.pid = this.subprocess.pid

			// When using shell: true, the PID is for the shell, not the actual command
			// Find the actual command PID after a small delay
			if (this.pid && process.platform !== "win32") {
				this.pidUpdatePromise = new Promise<void>((resolve) => {
					setTimeout(() => {
						void this.getDescendantPids(this.pid!, PID_UPDATE_TIMEOUT_MS)
							.then((children) => {
								const actualPid = children[0]
								if (Number.isInteger(actualPid) && actualPid > 0) this.pid = actualPid
							})
							// PID refinement is optional. Tree termination still snapshots both
							// the original shell PID and any descendants it can discover later.
							.catch(() => undefined)
							.finally(resolve)
					}, 100)
				})
			}

			// Binary chunks avoid retaining an arbitrarily long line before yielding.
			const rawStream = this.subprocess.iterable({ from: "all", binary: true })

			// Wrap the stream to ensure all chunks are strings (execa can return Uint8Array)
			const stream = (async function* () {
				const decoder = new TextDecoder()
				for await (const chunk of rawStream) {
					const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
					if (text) yield text
				}
				const tail = decoder.decode()
				if (tail) yield tail
			})()

			this.terminal.setActiveStream(stream, this.pid)

			for await (const line of stream) {
				if (this.aborted) {
					break
				}

				try {
					this.fullOutput += line
					this.emit("output_available")

					const now = Date.now()

					if (this.isListening && (now - this.lastEmitTime_ms > 500 || this.lastEmitTime_ms === 0)) {
						this.emitRemainingBufferIfListening()
						this.lastEmitTime_ms = now
					}

					this.startHotTimer(line)
					// Bound outstanding async output callbacks without awaiting every
					// chunk or retaining a separate output queue. The active command
					// consumer is synchronous; this only backpressures async observers.
					if (this.pendingLineObservers.size >= MAX_PENDING_LINE_OBSERVERS) {
						await Promise.race(this.pendingLineObservers)
					}
				} catch (error) {
					// Execa's iterator.return() waits for process exit. Stop the
					// process before throwing so iterator cleanup cannot deadlock.
					await stopAfterOutputFailure(error)
					throw error
				}
			}

			const outcome = await processSettlement
			if (outcome.status === "rejected") throw outcome.reason
			exitDetails = this.aborted ? { exitCode: 137, signalName: "SIGKILL" } : { exitCode: 0 }
		} catch (error) {
			if (error instanceof ExecaError && !processFailure && (error.exitCode !== undefined || this.aborted)) {
				// Nonzero command exits are tool results, including rg's no-match exit 1.
				// Execa's message duplicates the command and all captured output; sending
				// it through the shared host console can copy megabytes of workspace data.
				// An iterable error is not itself proof that the process has settled.
				await processSettlement
				exitDetails = {
					exitCode: error.exitCode ?? 137,
					signalName: error.signal,
				}
			} else {
				await stopAfterOutputFailure(error)
				if (this.subprocess) {
					// A failed termination leaves Stop retryable. Do not release the
					// terminal or advertise completion while that process still lives.
					const outcome = await processSettlement
					if (outcome?.status === "fulfilled") {
						exitDetails = { exitCode: outcome.value.exitCode }
					} else if (outcome?.reason instanceof ExecaError) {
						exitDetails = { exitCode: outcome.reason.exitCode, signalName: outcome.reason.signal }
					}
				}
			}
		}

		physicalProcessSettled = true
		await outputFailureTermination
		this.subprocess = undefined
		let failureReported = false
		const reportFailure = () => {
			if (!processFailure || failureReported) return
			failureReported = true
			this.emit("error", processFailure)
		}
		try {
			reportFailure()
			try {
				this.terminal.shellExecutionComplete(exitDetails)
				if (!processFailure) this.emitRemainingBufferIfListening()
			} catch (error) {
				await stopAfterOutputFailure(error)
				reportFailure()
			}
			this.stopHotTimer()
			const completionFailure = await this.emitCompletedAndWait()
			if (completionFailure) {
				await stopAfterOutputFailure(completionFailure)
			}
			// Completion observers may flush outstanding output callbacks. Join
			// those callbacks before continue can resolve the command successfully.
			await Promise.all(this.pendingLineObservers)
			await outputFailureTermination
			reportFailure()
		} finally {
			removeOutputFailureListener?.()
			this.handleListenerRejection = undefined
			// Shell completion permits terminal reuse while these observers settle.
			// An old owner must never close the replacement's stream or clear it.
			if (!this.terminal.process || this.terminal.process === this) this.terminal.setActiveStream(undefined)
			this.stopHotTimer()
			if (this.terminal.process === this) {
				this.terminal.process = undefined
				this.terminal.running = false
				this.terminal.busy = false
			}
			this.emit("continue")
		}
	}

	public override [captureRejectionSymbol](error: unknown, eventName: unknown, ..._args: unknown[]): void {
		// This hook must stay synchronous: returning a rejecting promise can
		// recursively invoke Node's rejection capture.
		if (eventName !== "error" && this.handleListenerRejection) {
			this.handleListenerRejection(error)
		} else {
			console.error("[ExecaTerminalProcess] terminal observer rejected outside active output handling", {
				eventName: String(eventName),
			})
		}
	}

	private async emitCompletedAndWait(): Promise<Error | undefined> {
		// Keep native once wrappers, listener order, and emitter context. Unlike
		// streaming output callbacks, completion callbacks own the finalization
		// barrier and must settle before the command promise can report success.
		const pending = this.rawListeners("completed").map((listener) => {
			try {
				return Promise.resolve(listener.call(this, this.fullOutput))
			} catch (error) {
				return Promise.reject(error)
			}
		})
		const failures = (await Promise.allSettled(pending)).flatMap((outcome) =>
			outcome.status === "rejected"
				? [outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason))]
				: [],
		)
		if (failures.length === 1) return failures[0]
		if (failures.length > 1) return new AggregateError(failures, "Command completion observers failed")
		return undefined
	}

	public override continue() {
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	public override abort(): Promise<void> {
		this.aborted = true
		return this.startTermination()
	}

	private startTermination(): Promise<void> {
		if (this.abortPromise) return this.abortPromise
		const abortPromise = this.terminateProcessTree().catch((error) => {
			if (this.abortPromise === abortPromise) this.abortPromise = undefined
			throw error
		})
		this.abortPromise = abortPromise
		return abortPromise
	}

	private async terminateProcessTree(): Promise<void> {
		const subprocess = this.subprocess
		if (!subprocess) return

		await this.pidUpdatePromise
		const roots = [this.pid, subprocess.pid].filter(
			(pid, index, values): pid is number => typeof pid === "number" && pid > 0 && values.indexOf(pid) === index,
		)
		if (roots.length === 0) return

		if (process.platform === "win32") {
			// taskkill performs its own tree snapshot and forcefully terminates the
			// complete tree. Unlike ps-tree@1.x, it does not depend on WMIC.
			const results = await Promise.allSettled(roots.map((pid) => this.terminateWindowsProcessTree(pid)))
			this.throwTerminationErrors(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
			)
			return
		}

		const descendants = new Set<number>()
		const discoveryResults = await Promise.allSettled(
			roots.map(async (rootPid) => {
				for (const childPid of await this.getDescendantPids(rootPid)) {
					if (!roots.includes(childPid)) descendants.add(childPid)
				}
			}),
		)
		const errors: unknown[] = discoveryResults.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		)

		// Snapshot every descendant before terminating its parents so re-parenting
		// cannot hide a process between discovery and delivery of SIGKILL.
		const terminatedPids: number[] = []
		for (const pid of [...descendants].reverse()) {
			try {
				this.killPid(pid)
				terminatedPids.push(pid)
			} catch (error) {
				errors.push(error)
			}
		}
		for (const pid of roots) {
			try {
				this.killPid(pid)
				terminatedPids.push(pid)
			} catch (error) {
				errors.push(error)
			}
		}
		try {
			await this.waitForPosixProcessSettlement(terminatedPids)
		} catch (error) {
			errors.push(error)
		}
		this.throwTerminationErrors(errors)
	}

	private async waitForPosixProcessSettlement(pids: readonly number[]): Promise<void> {
		if (pids.length === 0) return
		const deadline = Date.now() + PROCESS_TERMINATION_TIMEOUT_MS
		while (true) {
			const remainingMs = deadline - Date.now()
			if (remainingMs <= 0) throw new Error("Timed out waiting for the terminated process tree to stop")
			const runningPids = await new Promise<number[]>((resolve, reject) => {
				execFile(
					"ps",
					["-o", "pid=,stat=", "-p", pids.join(",")],
					{ timeout: remainingMs, maxBuffer: 1024 * 1024 },
					(error, stdout, stderr) => {
						// ps exits 1 with no rows when every selected PID has disappeared.
						if (
							error &&
							!(error.code === 1 && !error.killed && !error.signal && !stdout.trim() && !stderr.trim())
						) {
							reject(new Error("Failed to inspect terminated process-tree state", { cause: error }))
							return
						}
						const running: number[] = []
						for (const row of stdout.trim().split("\n").filter(Boolean)) {
							const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(row)
							if (!match || !pids.includes(Number(match[1]))) {
								reject(new Error("Invalid terminated process-tree state from ps"))
								return
							}
							// A zombie is already dead; its parent/init owns reaping the PID.
							// Signal delivery alone does not establish this exit boundary.
							if (!/^[ZXx]/.test(match[2])) running.push(Number(match[1]))
						}
						resolve(running)
					},
				)
			})
			if (runningPids.length === 0) return
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(PROCESS_SETTLEMENT_POLL_MS, remainingMs)))
		}
	}

	private throwTerminationErrors(errors: readonly unknown[]): void {
		if (errors.length === 0) return
		if (errors.length === 1) throw errors[0]
		throw new AggregateError(errors, `Failed to terminate ${errors.length} process-tree targets`)
	}

	private terminateWindowsProcessTree(pid: number): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile(
				"taskkill.exe",
				["/PID", String(pid), "/T", "/F"],
				{ windowsHide: true, timeout: PROCESS_TERMINATION_TIMEOUT_MS },
				(error: ExecFileException | null) => {
					if (!error) {
						resolve()
						return
					}
					// taskkill returns an error when a prior tree kill already removed
					// this root. Missing taskkill and failures against a still-live root
					// are real cleanup failures and must remain observable.
					const launcherOrTimeoutFailure = error.code === "ENOENT" || error.killed || error.signal
					if (!launcherOrTimeoutFailure && !this.isProcessAlive(pid)) {
						resolve()
						return
					}
					reject(new Error(`taskkill failed for PID ${pid}: ${error.message}`, { cause: error }))
				},
			)
		})
	}

	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0)
			return true
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH"
		}
	}

	private getDescendantPids(pid: number, timeoutMs = PROCESS_TERMINATION_TIMEOUT_MS): Promise<number[]> {
		return new Promise((resolve, reject) => {
			let settled = false
			const timeout = setTimeout(() => {
				settled = true
				reject(new Error(`Timed out discovering the process tree for PID ${pid}`))
			}, timeoutMs)
			psTree(pid, (error, children) => {
				if (settled) return
				settled = true
				clearTimeout(timeout)
				if (error) {
					reject(new Error(`Failed to get process tree for PID ${pid}: ${error.message}`, { cause: error }))
					return
				}
				resolve(
					children
						.map((child) => Number.parseInt(child.PID, 10))
						.filter((childPid) => Number.isInteger(childPid) && childPid > 0),
				)
			})
		})
	}

	private killPid(pid: number): void {
		try {
			if (!process.kill(pid, "SIGKILL")) throw new Error("process.kill returned false")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return
			throw new Error(
				`Failed to kill process ${pid}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			)
		}
	}

	public override hasUnretrievedOutput() {
		return this.lastRetrievedIndex < this.fullOutput.length
	}

	protected override getUnretrievedOutputRange(
		maxCharacters: number,
		includeTrailingOutput: boolean,
	): { endIndex: number; output: string } {
		const startIndex = Math.min(Math.max(0, this.lastRetrievedIndex), this.fullOutput.length)
		let endIndex = this.fullOutput.length

		// While the subprocess is active, retain the existing complete-line
		// behavior. Once completed, include a final line even when it has no
		// trailing newline so output is not silently lost.
		if (!this.isSettled || !includeTrailingOutput) {
			const newlineIndex = this.fullOutput.lastIndexOf("\n", this.fullOutput.length - 1)
			if (newlineIndex < startIndex) {
				return { endIndex: startIndex, output: "" }
			}
			endIndex = newlineIndex + 1
		}

		endIndex = Math.min(endIndex, startIndex + maxCharacters)
		if (endIndex <= startIndex) {
			return { endIndex: startIndex, output: "" }
		}

		return {
			endIndex,
			output: this.fullOutput.slice(startIndex, endIndex),
		}
	}

	private emitRemainingBufferIfListening() {
		if (!this.isListening) {
			return
		}

		const output = this.getUnretrievedOutput()

		if (output !== "") {
			// Native emit discards listener return values. Preserve native once
			// wrappers and context while owning only still-pending output work.
			for (const listener of this.rawListeners("line")) {
				const result: unknown = listener.call(this, output)
				if (
					result &&
					(typeof result === "object" || typeof result === "function") &&
					"then" in result &&
					typeof result.then === "function"
				) {
					const pending = Promise.resolve(result)
						.then(
							() => undefined,
							(error) => this.handleListenerRejection?.(error),
						)
						.finally(() => this.pendingLineObservers.delete(pending))
					this.pendingLineObservers.add(pending)
				}
			}
		}
	}
}
