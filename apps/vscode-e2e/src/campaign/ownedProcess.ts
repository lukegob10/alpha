import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import process from "node:process"

export interface OwnedProcessCommand {
	executable: string
	args: readonly string[]
	cwd: string
	env?: NodeJS.ProcessEnv
}

export interface OwnedProcessResult {
	exitCode: number | null
	signal: NodeJS.Signals | null
	stdout: string
	stderr: string
	outputTruncated: boolean
	cleanupVerified: boolean
}

interface OwnedProcessOptions {
	signal?: AbortSignal
	maxOutputBytes?: number
	killGraceMs?: number
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_KILL_GRACE_MS = 1_000
const MAX_TIMER_MS = 2_147_483_647
const TASKKILL_TIMEOUT_MS = 5_000

/**
 * Run one directly spawned process and retain ownership of its termination boundary.
 *
 * On POSIX, the child is detached into a new process group and cancellation signals
 * that group. On Windows, cancellation targets only this invocation's child PID with
 * taskkill's tree mode. The contract does not claim to contain a process that
 * intentionally daemonizes, reparents itself, or otherwise escapes the OS-visible
 * process family; Node also has no portable Windows Job Object API. Callers must keep
 * and await the returned promise when abandoning a run so the close/cleanup protocol
 * can finish before the runner exits.
 *
 * maxOutputBytes bounds each captured stream independently. The streams continue to
 * drain after reaching the cap so a noisy child cannot deadlock on a full pipe.
 * cleanupVerified is false when cancellation cleanup fails, when a POSIX process
 * group remains alive, or when an externally signaled root makes descendant
 * ownership unverifiable. On Windows, an ordinary root close is never proof that
 * descendants are gone; only a successful taskkill tree operation performed while
 * this root was live can verify the OS-visible tree. Callers must not start unsafe
 * repair/evidence work when it is false.
 */
export async function runOwnedProcess(
	command: OwnedProcessCommand,
	options: OwnedProcessOptions,
): Promise<OwnedProcessResult> {
	const maxOutputBytes = normalizeLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes", false)
	const killGraceMs = normalizeLimit(options.killGraceMs, DEFAULT_KILL_GRACE_MS, "killGraceMs", true)

	if (options.signal?.aborted) throw createAbortError()

	const spawnOptions: SpawnOptions = {
		cwd: command.cwd,
		shell: false,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	}
	if (command.env !== undefined) spawnOptions.env = { ...command.env }

	const child = spawn(command.executable, command.args, spawnOptions)

	const stdoutCapture = new BoundedOutput(maxOutputBytes)
	const stderrCapture = new BoundedOutput(maxOutputBytes)
	let closed = false
	let finalized = false
	let abortRequested = false
	let launchError: Error | undefined
	let terminationPromise: Promise<TerminationOutcome> | undefined
	let graceTimer: NodeJS.Timeout | undefined
	let releaseGracePeriod: (() => void) | undefined
	let onClose: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined
	let cleanupDeadlineTimer: NodeJS.Timeout | undefined
	let rejectCompletion: ((reason?: unknown) => void) | undefined

	const onStdout = (chunk: unknown) => stdoutCapture.append(chunk)
	const onStderr = (chunk: unknown) => stderrCapture.append(chunk)
	const onChildError = (error: Error) => {
		launchError ??= error
	}

	const clearGracePeriod = () => {
		if (graceTimer) {
			clearTimeout(graceTimer)
			graceTimer = undefined
		}
		const release = releaseGracePeriod
		releaseGracePeriod = undefined
		release?.()
		if (cleanupDeadlineTimer) {
			clearTimeout(cleanupDeadlineTimer)
			cleanupDeadlineTimer = undefined
		}
	}

	const waitForGracePeriodOrClose = (): Promise<void> => {
		if (closed || killGraceMs === 0) return Promise.resolve()

		return new Promise<void>((resolve) => {
			releaseGracePeriod = () => {
				releaseGracePeriod = undefined
				resolve()
			}
			graceTimer = setTimeout(() => {
				graceTimer = undefined
				releaseGracePeriod = undefined
				resolve()
			}, killGraceMs)
		})
	}

	const onAbort = () => {
		if (closed || abortRequested) return
		abortRequested = true
		terminationPromise = terminateOwnedProcess(child, child.pid, () => closed, waitForGracePeriodOrClose)
		// The close handler awaits this same promise. Attach a handler now so a
		// cleanup failure cannot become an unhandled rejection while close is pending.
		void terminationPromise.catch(() => undefined)
		cleanupDeadlineTimer = setTimeout(() => {
			if (closed || finalized) return

			// This is deliberately a last-resort root kill. It never targets an
			// arbitrary PID and cannot establish descendant cleanup by itself.
			try {
				killChild(child, process.platform === "win32" ? undefined : "SIGKILL", () => closed)
			} catch {
				// The caller receives an explicit cleanup failure below. Keeping the
				// promise from resolving as a cancelled success is the safe outcome.
			}

			// Do not manufacture an OwnedProcessResult from a direct-root exit:
			// descendants may still be alive. This bounded failure is deliberately
			// a rejection, so the campaign controller classifies it as infrastructure
			// and cannot proceed to evidence, repair, or another launch.
			finalized = true
			cleanupListeners()
			rejectCompletion?.(new OwnedProcessCleanupError())
		}, cleanupDeadlineMs(killGraceMs))
	}

	const cleanupListeners = () => {
		clearGracePeriod()
		options.signal?.removeEventListener("abort", onAbort)
		child.stdout?.removeListener("data", onStdout)
		child.stderr?.removeListener("data", onStderr)
		child.removeListener("error", onChildError)
		if (onClose) child.removeListener("close", onClose)
	}

	const completion = new Promise<OwnedProcessResult>((resolve, reject) => {
		rejectCompletion = reject
		const finish = async (exitCode: number | null, signal: NodeJS.Signals | null) => {
			if (finalized) return
			finalized = true
			closed = true
			clearGracePeriod()

			let cleanupVerified = true
			try {
				if (terminationPromise) {
					const termination = await terminationPromise
					cleanupVerified = termination.cleanupVerified
				}
			} catch {
				cleanupVerified = false
			} finally {
				cleanupListeners()
			}

			if (launchError) {
				reject(launchError)
				return
			}
			if (!abortRequested && (exitCode === null || signal !== null)) cleanupVerified = false
			if (process.platform === "win32" && !abortRequested) cleanupVerified = false
			if (cleanupVerified && process.platform !== "win32") {
				cleanupVerified = verifyPosixProcessGroupGone(child.pid)
			}

			resolve({
				exitCode,
				signal,
				stdout: stdoutCapture.toString(),
				stderr: stderrCapture.toString(),
				outputTruncated: stdoutCapture.truncated || stderrCapture.truncated,
				cleanupVerified,
			})
		}

		onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			if (closed) return
			closed = true
			clearGracePeriod()
			void finish(exitCode, signal)
		}

		child.once("error", onChildError)
		child.once("close", onClose)
		child.stdout?.on("data", onStdout)
		child.stderr?.on("data", onStderr)
		options.signal?.addEventListener("abort", onAbort, { once: true })

		// AbortSignal does not invoke a listener added after it was aborted.
		if (options.signal?.aborted) onAbort()
	})

	return completion
}

function cleanupDeadlineMs(killGraceMs: number): number {
	return Math.min(MAX_TIMER_MS, Math.max(1_000, killGraceMs + 1_000))
}

function normalizeLimit(
	value: number | undefined,
	defaultValue: number,
	name: string,
	validateTimerRange: boolean,
): number {
	const limit = value ?? defaultValue
	if (!Number.isSafeInteger(limit) || limit < 0 || (validateTimerRange && limit > MAX_TIMER_MS)) {
		throw new RangeError(`${name} must be a non-negative safe integer`)
	}
	return limit
}

function createAbortError(): Error {
	const error = new Error("The owned process was aborted")
	error.name = "AbortError"
	return error
}

class OwnedProcessCleanupError extends Error {
	readonly cleanupVerified = false

	constructor() {
		super("Owned process cleanup did not reach close within the bounded deadline")
		this.name = "OwnedProcessCleanupError"
	}
}

class BoundedOutput {
	private readonly chunks: Buffer[] = []
	private capturedBytes = 0
	truncated = false

	constructor(private readonly maxBytes: number) {}

	append(chunk: unknown): void {
		const buffer = toBuffer(chunk)
		if (buffer.byteLength === 0) return

		const remaining = this.maxBytes - this.capturedBytes
		if (remaining > 0) {
			// Copy the prefix so a large stream chunk's backing ArrayBuffer cannot
			// keep unbounded data alive after the cap has been reached.
			const captured = Buffer.from(buffer.subarray(0, remaining))
			this.chunks.push(captured)
			this.capturedBytes += captured.byteLength
		}
		if (buffer.byteLength > Math.max(remaining, 0)) this.truncated = true
	}

	toString(): string {
		const value = Buffer.concat(this.chunks, this.capturedBytes).toString("utf8")
		if (Buffer.byteLength(value) <= this.maxBytes) return value

		const codePoints = Array.from(value)
		let low = 0
		let high = codePoints.length
		while (low < high) {
			const middle = Math.ceil((low + high) / 2)
			const candidate = codePoints.slice(0, middle).join("")
			if (Buffer.byteLength(candidate) <= this.maxBytes) low = middle
			else high = middle - 1
		}
		return codePoints.slice(0, low).join("")
	}
}

function toBuffer(chunk: unknown): Buffer {
	if (typeof chunk === "string") return Buffer.from(chunk)
	if (Buffer.isBuffer(chunk)) return chunk
	if (chunk instanceof Uint8Array) return Buffer.from(chunk)
	if (chunk === undefined || chunk === null) return Buffer.alloc(0)
	return Buffer.from(String(chunk))
}

async function terminateOwnedProcess(
	child: ChildProcess,
	pid: number | undefined,
	isClosed: () => boolean,
	waitForGracePeriodOrClose: () => Promise<void>,
): Promise<TerminationOutcome> {
	if (process.platform === "win32") {
		return terminateWindowsProcess(child, pid, isClosed)
	}

	const errors: unknown[] = []
	let forceSignalSent = false
	try {
		if (isValidPid(pid)) signalProcessGroup(pid, "SIGTERM")
		else killChild(child, "SIGTERM", isClosed)
	} catch (error) {
		errors.push(error)
	}

	await waitForGracePeriodOrClose()
	if (!isClosed()) {
		try {
			if (isValidPid(pid)) signalProcessGroup(pid, "SIGKILL")
			else killChild(child, "SIGKILL", isClosed)
			forceSignalSent = true
		} catch (error) {
			errors.push(error)
		}
	}

	if (!forceSignalSent && !isClosed()) {
		try {
			// If group signaling failed, killing the owned root is still safer
			// than allowing it to run indefinitely. This deliberately verifies
			// nothing about descendants, so the result remains unverified.
			killChild(child, "SIGKILL", isClosed)
		} catch (error) {
			errors.push(error)
		}
	}

	return { cleanupVerified: errors.length === 0 && isValidPid(pid) }
}

async function terminateWindowsProcess(
	child: ChildProcess,
	pid: number | undefined,
	isClosed: () => boolean,
): Promise<TerminationOutcome> {
	if (!isChildLive(child, isClosed)) return { cleanupVerified: false }

	if (!isValidPid(pid)) {
		killChild(child, undefined, isClosed)
		return { cleanupVerified: false }
	}

	try {
		const result = await runTaskkill(pid)
		if (result.exitCode === 0 && result.signal === null) return { cleanupVerified: true }
		if (!isChildLive(child, isClosed)) return { cleanupVerified: false }
	} catch {
		if (!isChildLive(child, isClosed)) return { cleanupVerified: false }
	}

	try {
		killChild(child, undefined, isClosed)
	} catch {
		return { cleanupVerified: false }
	}

	// taskkill is the only tree-capable operation here. A direct root fallback
	// cannot prove descendants were terminated, so the result remains false.
	return { cleanupVerified: false }
}

interface TerminationOutcome {
	cleanupVerified: boolean
}

interface TaskkillResult {
	exitCode: number | null
	signal: NodeJS.Signals | null
}

function runTaskkill(pid: number): Promise<TaskkillResult> {
	return new Promise<TaskkillResult>((resolve, reject) => {
		let taskkill: ChildProcess
		try {
			taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "ignore", "ignore"],
			})
		} catch (error) {
			reject(error)
			return
		}

		let launchError: Error | undefined
		let timeout: NodeJS.Timeout | undefined
		let settled = false
		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout)
				timeout = undefined
			}
			taskkill.removeListener("error", onError)
			taskkill.removeListener("close", onClose)
		}
		const onError = (error: Error) => {
			launchError ??= error
		}
		const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return
			settled = true
			cleanup()
			if (launchError) {
				reject(launchError)
				return
			}
			resolve({ exitCode, signal })
		}

		taskkill.once("error", onError)
		taskkill.once("close", onClose)
		timeout = setTimeout(() => {
			if (settled) return
			settled = true
			try {
				taskkill.kill()
			} catch {
				// The bounded rejection below remains authoritative for the caller.
			}
			cleanup()
			reject(new Error(`taskkill.exe timed out for PID ${pid}`))
		}, TASKKILL_TIMEOUT_MS)
	})
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		if (!process.kill(-pid, signal)) throw new Error(`process.kill returned false for process group ${pid}`)
	} catch (error) {
		if (isErrno(error, "ESRCH")) return
		throw new Error(`Failed to send ${signal} to owned process group ${pid}`, { cause: error })
	}
}

function killChild(child: ChildProcess, signal: NodeJS.Signals | undefined, isClosed: () => boolean): void {
	try {
		const killed = signal === undefined ? child.kill() : child.kill(signal)
		if (!killed && isChildLive(child, isClosed)) throw new Error("ChildProcess.kill returned false")
	} catch (error) {
		if (isErrno(error, "ESRCH")) return
		throw new Error("Failed to terminate the owned child process", { cause: error })
	}
}

function isChildLive(child: ChildProcess, isClosed: () => boolean): boolean {
	return (
		!isClosed() &&
		(child.exitCode === null || child.exitCode === undefined) &&
		(child.signalCode === null || child.signalCode === undefined)
	)
}

function isValidPid(pid: number | undefined): pid is number {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
}

function verifyPosixProcessGroupGone(pid: number | undefined): boolean {
	if (!isValidPid(pid)) return false
	try {
		process.kill(-pid, 0)
		return false
	} catch (error) {
		return isErrno(error, "ESRCH")
	}
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}
