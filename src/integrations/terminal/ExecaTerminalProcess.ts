import { execa, ExecaError } from "execa"
import process from "process"
import { captureRejectionSymbol } from "node:events"

import type { AlphaTerminal, DirectTerminalCommand, ExitCodeDetails } from "./types"
import { BaseTerminal } from "./BaseTerminal"
import { BaseTerminalProcess } from "./BaseTerminalProcess"
import { getDescendantPids, terminateProcessTree } from "../../utils/processTree"

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

	public override async run(command: string, directCommand?: DirectTerminalCommand) {
		this.command = command
		let processSettlement: Promise<PromiseSettledResult<Awaited<ReturnType<typeof execa>>>> | undefined
		let processFailure: Error | undefined
		let outputFailureTermination: Promise<void> | undefined
		let removeOutputFailureListener: (() => void) | undefined
		let exitDetails: ExitCodeDetails = { exitCode: undefined }
		let physicalProcessSettled = false
		const stopAfterOutputFailure = (error: unknown): Promise<void> => {
			if (outputFailureTermination) return outputFailureTermination
			this.outputArchiveInterrupted = true
			this.outputArtifactId = undefined
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
			// Stop can reach the owned process in onProcessCreated, before any
			// subprocess exists. Keep that cancellation from launching new work.
			if (this.aborted) {
				exitDetails = { exitCode: 130, signalName: "SIGINT" }
			} else {
				this.isHot = true

				const spawn = execa({
					shell: directCommand ? false : BaseTerminal.getExecaShellPath() || true,
					extendEnv: !directCommand,
					windowsHide: true,
					cwd: this.terminal.getCurrentWorkingDirectory(),
					all: true,
					// Alpha owns the complete output and receipts. Avoid Execa retaining
					// another stdout/stderr/all copy of the same command output.
					buffer: false,
					// Ignore stdin to ensure non-interactive mode and prevent hanging
					stdin: "ignore",
					env: directCommand?.env ?? {
						...process.env,
						...this.terminal.commandEnv,
						// Ensure UTF-8 encoding for Ruby, CocoaPods, etc.
						LANG: "en_US.UTF-8",
						LC_ALL: "en_US.UTF-8",
					},
				})
				this.subprocess = directCommand
					? spawn(directCommand.executable, [...directCommand.args])
					: spawn`${command}`
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
				if (!directCommand && this.pid && process.platform !== "win32") {
					this.pidUpdatePromise = new Promise<void>((resolve) => {
						setTimeout(() => {
							void getDescendantPids(this.pid!, PID_UPDATE_TIMEOUT_MS)
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
						await this.appendOutput(line)

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
				exitDetails = { exitCode: outcome.value.exitCode, signalName: outcome.value.signal }
			}
		} catch (error) {
			if (
				error instanceof ExecaError &&
				!processFailure &&
				(error.exitCode !== undefined || error.signal !== undefined || this.aborted)
			) {
				// Nonzero command exits are tool results, including rg's no-match exit 1.
				// Execa's message duplicates the command and all captured output; sending
				// it through the shared host console can copy megabytes of workspace data.
				// An iterable error is not itself proof that the process has settled.
				await processSettlement
				exitDetails = {
					exitCode: error.exitCode,
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
			const completionFailure = await this.emitCompletedAndWait(this.getOutputTranscript())
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
			try {
				await this.finalizeOutput()
			} catch (error) {
				await stopAfterOutputFailure(error)
				reportFailure()
			}
			this.terminal.cleanCompletedProcessQueue?.()
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

	public override continue() {
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	public override abort(): Promise<void> {
		this.aborted = true
		this.cancelOutputWriter()
		return this.startTermination()
	}

	/** Pipe sessions have closed stdin; Ctrl-C is a provider-owned interrupt. */
	public async interrupt(): Promise<void> {
		const subprocess = this.subprocess
		if (!subprocess || !this.terminal.running || this.terminal.process !== this)
			throw new Error("Command is no longer running")
		if (process.platform === "win32") {
			// Node cannot deliver console Ctrl-C to a detached pipe process on Windows.
			// Use the existing owned-tree stop, retaining the actual exit evidence.
			this.cancelOutputWriter()
			await this.startTermination()
			return
		}
		const roots = [this.pid, subprocess.pid].filter(
			(pid, index, values): pid is number => typeof pid === "number" && pid > 0 && values.indexOf(pid) === index,
		)
		const targets = new Set(roots)
		for (const root of roots) {
			for (const descendant of await getDescendantPids(root)) targets.add(descendant)
		}
		for (const pid of [...targets].reverse()) {
			try {
				if (!process.kill(pid, "SIGINT")) throw new Error("process.kill returned false")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
			}
		}
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
		await terminateProcessTree(roots, { allowMissingWindowsRoots: true })
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

		// Explicit session polls expose prompts before a newline. Legacy UI line
		// consumers retain their complete-line behavior.
		if (!includeTrailingOutput) {
			const newlineIndex = this.fullOutput.lastIndexOf("\n", this.fullOutput.length - 1)
			if (newlineIndex < startIndex) {
				return { endIndex: startIndex, output: "" }
			}
			endIndex = newlineIndex + 1
		}

		endIndex = this.safeOutputRangeEnd(Math.min(endIndex, startIndex + maxCharacters))
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
