import { execFile, type ExecFileException } from "node:child_process"
import { win32 as windowsPath } from "node:path"
import psTree from "ps-tree"

const PROCESS_TERMINATION_TIMEOUT_MS = 5_000
const PROCESS_SETTLEMENT_POLL_MS = 25
const PROCESS_TERMINATION_GRACE_MS = 100

type ProcessTreeOptions = {
	detachedProcessGroup?: number
	graceful?: boolean
	// Legacy terminal callers also join their subprocess promise after an idempotent stop.
	allowMissingWindowsRoots?: boolean
}

/** Callers retain ownership of every root and of the optional detached POSIX group until this settles. */
export async function terminateProcessTree(roots: readonly number[], options: ProcessTreeOptions = {}): Promise<void> {
	if (roots.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid owned process PID")
	const group = options.detachedProcessGroup
	if (group !== undefined && (!Number.isSafeInteger(group) || group <= 0 || !roots.includes(group))) {
		throw new Error("Detached process group must be an owned root")
	}
	if (roots.length === 0) return

	if (process.platform === "win32") {
		// taskkill performs its own tree snapshot and forcefully terminates the
		// complete tree. Unlike ps-tree@1.x, it does not depend on WMIC.
		const results = await Promise.allSettled(
			roots.map((pid) => terminateWindowsProcessTree(pid, options.allowMissingWindowsRoots ?? false)),
		)
		throwTerminationErrors(results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
		return
	}

	const descendants = new Set<number>()
	const discoveryResults = await Promise.allSettled(
		roots.map(async (rootPid) => {
			for (const childPid of await getDescendantPids(rootPid)) {
				if (!roots.includes(childPid)) descendants.add(childPid)
			}
		}),
	)
	const errors: unknown[] = discoveryResults.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	)
	const groupSignalErrors: unknown[] = []
	if (group !== undefined && options.graceful) {
		try {
			if (signalProcessGroup(group, "SIGTERM")) {
				await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_TERMINATION_GRACE_MS))
			}
		} catch (error) {
			groupSignalErrors.push(error)
		}
	}

	// Snapshot every descendant before terminating its parents so re-parenting
	// cannot hide a process between discovery and delivery of SIGKILL.
	const terminatedPids: number[] = []
	for (const pid of [...descendants].reverse()) {
		try {
			killPid(pid)
			terminatedPids.push(pid)
		} catch (error) {
			errors.push(error)
		}
	}
	for (const pid of roots) {
		try {
			killPid(pid)
			terminatedPids.push(pid)
		} catch (error) {
			errors.push(error)
		}
	}
	if (group !== undefined) {
		try {
			// A parent may exit or spawn again during the grace period. Its original
			// owned group still includes those children after they are re-parented.
			signalProcessGroup(group, "SIGKILL")
		} catch (error) {
			groupSignalErrors.push(error)
		}
	}
	let physicalSettlementConfirmed = false
	let settlementFailure: unknown
	try {
		await waitForPosixProcessSettlement(terminatedPids, group)
		physicalSettlementConfirmed = true
	} catch (error) {
		settlementFailure = error
	}
	for (const error of groupSignalErrors) {
		// Darwin killpg skips zombies and can return EPERM for a stopped group.
		// Only independent observation of every owned PID/group can establish that
		// race; a live member or unavailable process state remains a cleanup failure.
		const exitedDarwinGroup =
			process.platform === "darwin" &&
			physicalSettlementConfirmed &&
			error instanceof Error &&
			(error.cause as NodeJS.ErrnoException | undefined)?.code === "EPERM"
		if (!exitedDarwinGroup) errors.push(error)
	}
	if (settlementFailure) errors.push(settlementFailure)
	throwTerminationErrors(errors)
}

async function waitForPosixProcessSettlement(pids: readonly number[], group?: number): Promise<void> {
	if (pids.length === 0 && group === undefined) return
	const deadline = Date.now() + PROCESS_TERMINATION_TIMEOUT_MS
	while (true) {
		const remainingMs = deadline - Date.now()
		if (remainingMs <= 0) throw new Error("Timed out waiting for the terminated process tree to stop")
		const runningPids = await new Promise<number[]>((resolve, reject) => {
			execFile(
				"ps",
				group === undefined ? ["-o", "pid=,stat=", "-p", pids.join(",")] : ["-eo", "pid=,pgid=,stat="],
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
						const match =
							group === undefined
								? /^\s*(\d+)\s+(\S+)\s*$/.exec(row)
								: /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row)
						if (!match || (group === undefined && !pids.includes(Number(match[1])))) {
							reject(new Error("Invalid terminated process-tree state from ps"))
							return
						}
						// A zombie is already dead; its parent/init owns reaping the PID.
						// Signal delivery alone does not establish this exit boundary.
						const belongsToTree = pids.includes(Number(match[1])) || Number(match[2]) === group
						if (belongsToTree && !/^[ZXx]/.test(match[group === undefined ? 2 : 3])) {
							running.push(Number(match[1]))
						}
					}
					resolve(running)
				},
			)
		})
		if (runningPids.length === 0) return
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(PROCESS_SETTLEMENT_POLL_MS, remainingMs)))
	}
}

function signalProcessGroup(group: number, signal: NodeJS.Signals): boolean {
	try {
		if (!process.kill(-group, signal)) throw new Error("process.kill returned false")
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
		throw new Error(`Failed to signal owned process group ${group}`, { cause: error })
	}
}

function throwTerminationErrors(errors: readonly unknown[]): void {
	if (errors.length === 0) return
	if (errors.length === 1) throw errors[0]
	throw new AggregateError(errors, `Failed to terminate ${errors.length} process-tree targets`)
}

function terminateWindowsProcessTree(pid: number, allowMissingRoot: boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const systemRoot = process.env.SystemRoot ?? process.env.windir
		if (!systemRoot || !windowsPath.isAbsolute(systemRoot)) {
			reject(new Error("Windows system root is unavailable for process-tree termination"))
			return
		}
		execFile(
			windowsPath.join(systemRoot, "System32", "taskkill.exe"),
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
				if (!launcherOrTimeoutFailure && !isProcessAlive(pid)) {
					if (allowMissingRoot) resolve()
					else reject(new Error(`Could not verify process-tree cleanup for exited Windows root PID ${pid}`))
					return
				}
				reject(new Error(`taskkill failed for PID ${pid}: ${error.message}`, { cause: error }))
			},
		)
	})
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
	}
}

export function getDescendantPids(pid: number, timeoutMs = PROCESS_TERMINATION_TIMEOUT_MS): Promise<number[]> {
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

function killPid(pid: number): void {
	try {
		if (!process.kill(pid, "SIGKILL")) throw new Error("process.kill returned false")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return
		throw new Error(`Failed to kill process ${pid}: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		})
	}
}
