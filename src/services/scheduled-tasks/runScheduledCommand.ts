import { spawn } from "node:child_process"

import { terminateProcessTree } from "../../utils/processTree"

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
// Discovery and physical settlement each have a five-second bound in the shared helper.
const PROCESS_CLOSE_TIMEOUT_MS = 11_000

type CommandOptions = { cwd?: string; signal: AbortSignal; timeoutMs: number }
type CommandOutput = { stdout: string; stderr: string }

/** Process-tree termination rejected, so a failed command is not proof that its effects stopped. */
export class ScheduledCommandCleanupError extends Error {
	constructor(message: string, options: ErrorOptions) {
		super(message, options)
		this.name = "ScheduledCommandCleanupError"
	}
}

/** The command string has already passed scheduled-command approval. */
export async function runScheduledCommand(command: string, options: CommandOptions): Promise<CommandOutput> {
	if (options.signal.aborted) throw new Error("Command aborted during shutdown")
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: true,
			detached: process.platform !== "win32",
		})
		const stdout: Buffer[] = []
		const stderr: Buffer[] = []
		let stdoutBytes = 0
		let stderrBytes = 0
		let settled = false
		let failure: Error | undefined
		let stopping: Promise<void> | undefined
		let stopRequested = false
		let closed = false
		let closeTimer: ReturnType<typeof setTimeout> | undefined
		const finish = () => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			if (closeTimer) clearTimeout(closeTimer)
			options.signal.removeEventListener("abort", cancel)
			child.stdout?.removeListener("data", collectStdout)
			child.stderr?.removeListener("data", collectStderr)
			const output = {
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}
			stdout.length = 0
			stderr.length = 0
			if (failure) reject(Object.assign(failure, output))
			else resolve(output)
		}
		const finishStop = () => {
			if (!stopping || !closed) return
			void stopping.then(finish)
		}
		const stop = (reason: Error) => {
			if (settled || stopRequested) return
			// Latch the outcome before tree termination can trigger late successful close events.
			stopRequested = true
			failure = reason
			clearTimeout(timeout)
			stopping = terminateProcessTree(child.pid ? [child.pid] : [], {
				detachedProcessGroup: process.platform !== "win32" ? child.pid : undefined,
				graceful: true,
			}).catch((error: unknown) => {
				failure = new ScheduledCommandCleanupError(
					`${failure?.message}; process cleanup failed: ${String(error)}`,
					{
						cause: error,
					},
				)
			})
			closeTimer = setTimeout(() => {
				const message = `${failure?.message}; timed out waiting for the scheduled command process to close`
				failure =
					failure instanceof ScheduledCommandCleanupError
						? new ScheduledCommandCleanupError(message, { cause: failure.cause })
						: new Error(message, { cause: failure })
				child.stdout?.destroy()
				child.stderr?.destroy()
				closed = true
				finishStop()
			}, PROCESS_CLOSE_TIMEOUT_MS)
			finishStop()
		}
		const cancel = () => stop(new Error("Command aborted during shutdown"))
		const timeout = setTimeout(() => stop(new Error("Command timed out")), options.timeoutMs)
		const collect = (chunks: Buffer[], chunk: Buffer, retainedBytes: number): number => {
			if (settled || failure || chunk.length === 0) return retainedBytes
			if (chunk.length > MAX_OUTPUT_BYTES - retainedBytes) {
				stop(new Error("Command output exceeded its buffer limit"))
				return retainedBytes
			}
			const retained = Buffer.alloc(chunk.length)
			chunk.copy(retained)
			chunks.push(retained)
			return retainedBytes + retained.length
		}
		const collectStdout = (chunk: Buffer) => {
			stdoutBytes = collect(stdout, chunk, stdoutBytes)
		}
		const collectStderr = (chunk: Buffer) => {
			stderrBytes = collect(stderr, chunk, stderrBytes)
		}
		child.stdout?.on("data", collectStdout)
		child.stderr?.on("data", collectStderr)
		child.stdout?.on("error", stop)
		child.stderr?.on("error", stop)
		child.on("error", (error) => {
			if (settled || stopRequested) return
			if (child.pid) stop(error)
			else {
				failure = error
				finish()
			}
		})
		child.once("close", (code, signal) => {
			if (settled) return
			closed = true
			if (stopRequested) {
				finishStop()
				return
			}
			if (code !== 0) {
				failure = Object.assign(new Error(`Command failed (${signal ?? `exit code ${code}`})`), { code })
			}
			finish()
		})
		options.signal.addEventListener("abort", cancel, { once: true })
		if (options.signal.aborted) cancel()
	})
}
