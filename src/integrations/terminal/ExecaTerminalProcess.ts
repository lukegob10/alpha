import { execa, ExecaError } from "execa"
import psTree from "ps-tree"
import process from "process"
import { execFile, type ExecFileException } from "node:child_process"

import type { RooTerminal } from "./types"
import { BaseTerminal } from "./BaseTerminal"
import { BaseTerminalProcess } from "./BaseTerminalProcess"

const PROCESS_TERMINATION_TIMEOUT_MS = 5_000
const PID_UPDATE_TIMEOUT_MS = 1_000

export class ExecaTerminalProcess extends BaseTerminalProcess {
	private terminalRef: WeakRef<RooTerminal>
	private aborted = false
	private pid?: number
	private subprocess?: ReturnType<typeof execa>
	private pidUpdatePromise?: Promise<void>
	private abortPromise?: Promise<void>

	constructor(terminal: RooTerminal) {
		super()

		this.terminalRef = new WeakRef(terminal)

		this.once("completed", () => {
			this.terminal.busy = false
		})
	}

	public get terminal(): RooTerminal {
		const terminal = this.terminalRef.deref()

		if (!terminal) {
			throw new Error("Unable to dereference terminal")
		}

		return terminal
	}

	public override async run(command: string) {
		this.command = command

		try {
			this.isHot = true

			this.subprocess = execa({
				shell: BaseTerminal.getExecaShellPath() || true,
				cwd: this.terminal.getCurrentWorkingDirectory(),
				all: true,
				// Ignore stdin to ensure non-interactive mode and prevent hanging
				stdin: "ignore",
				env: {
					...process.env,
					// Ensure UTF-8 encoding for Ruby, CocoaPods, etc.
					LANG: "en_US.UTF-8",
					LC_ALL: "en_US.UTF-8",
				},
			})`${command}`

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

			const rawStream = this.subprocess.iterable({ from: "all", preserveNewlines: true })

			// Wrap the stream to ensure all chunks are strings (execa can return Uint8Array)
			const stream = (async function* () {
				for await (const chunk of rawStream) {
					yield typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
				}
			})()

			this.terminal.setActiveStream(stream, this.pid)

			for await (const line of stream) {
				if (this.aborted) {
					break
				}

				this.fullOutput += line

				const now = Date.now()

				if (this.isListening && (now - this.lastEmitTime_ms > 500 || this.lastEmitTime_ms === 0)) {
					this.emitRemainingBufferIfListening()
					this.lastEmitTime_ms = now
				}

				this.startHotTimer(line)
			}

			if (this.aborted) {
				let timeoutId: NodeJS.Timeout | undefined

				const kill = new Promise<void>((resolve, reject) => {
					timeoutId = setTimeout(() => {
						try {
							this.subprocess?.kill("SIGKILL")
							resolve()
						} catch (error) {
							reject(error)
						}
					}, PROCESS_TERMINATION_TIMEOUT_MS)
				})

				try {
					await Promise.race([this.subprocess, kill])
				} finally {
					if (timeoutId) clearTimeout(timeoutId)
				}
			}

			this.emit(
				"shell_execution_complete",
				this.aborted ? { exitCode: 137, signalName: "SIGKILL" } : { exitCode: 0 },
			)
		} catch (error) {
			if (error instanceof ExecaError) {
				if (!this.aborted) console.error(`[ExecaTerminalProcess#run] shell execution error: ${error.message}`)
				this.emit("shell_execution_complete", {
					exitCode: error.exitCode ?? (this.aborted ? 137 : 1),
					signalName: error.signal,
				})
			} else {
				console.error(
					`[ExecaTerminalProcess#run] shell execution error: ${error instanceof Error ? error.message : String(error)}`,
				)

				this.emit("shell_execution_complete", { exitCode: 1 })
			}
			this.subprocess = undefined
		}

		this.terminal.setActiveStream(undefined)
		this.emitRemainingBufferIfListening()
		this.stopHotTimer()
		this.emit("completed", this.fullOutput)
		this.emit("continue")
		this.subprocess = undefined
	}

	public override continue() {
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	public override abort(): Promise<void> {
		if (this.abortPromise) return this.abortPromise
		this.aborted = true
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
		for (const pid of [...descendants].reverse()) {
			try {
				this.killPid(pid)
			} catch (error) {
				errors.push(error)
			}
		}
		for (const pid of roots) {
			try {
				this.killPid(pid)
			} catch (error) {
				errors.push(error)
			}
		}
		this.throwTerminationErrors(errors)
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

	public override getUnretrievedOutput() {
		let output = this.fullOutput.slice(this.lastRetrievedIndex)
		let index = output.lastIndexOf("\n")

		if (index === -1) {
			return ""
		}

		index++
		this.lastRetrievedIndex += index

		// console.log(
		// 	`[ExecaTerminalProcess#getUnretrievedOutput] fullOutput.length=${this.fullOutput.length} lastRetrievedIndex=${this.lastRetrievedIndex}`,
		// 	output.slice(0, index),
		// )

		return output.slice(0, index)
	}

	private emitRemainingBufferIfListening() {
		if (!this.isListening) {
			return
		}

		const output = this.getUnretrievedOutput()

		if (output !== "") {
			this.emit("line", output)
		}
	}
}
