import type { ChildProcess } from "child_process"

const CANCELLED_PROCESS_SETTLEMENT_TIMEOUT_MS = 5_000

export interface WorktreeProcessCancellation {
	signal: AbortSignal
	/** The host retains process-tree ownership until this join settles. */
	terminateProcessTree(roots: readonly number[], options: { allowMissingWindowsRoots: true }): Promise<void>
}

export class WorktreeProcessCleanupError extends Error {}

type WorktreeChildProcess = Pick<ChildProcess, "pid"> & {
	once(event: "close", listener: () => void): unknown
	removeListener(event: "close", listener: () => void): unknown
}

/** Join the original process and host-owned tree cleanup before allowing startup rollback. */
export async function joinWorktreeProcess<T>(
	execution: Promise<T>,
	child: WorktreeChildProcess,
	cancellation?: WorktreeProcessCancellation,
): Promise<T> {
	if (!cancellation) return execution
	let closed = false
	const observeClose = () => {
		closed = true
	}
	child.once("close", observeClose)
	let stopping: Promise<void> | undefined
	let settlementTimer: ReturnType<typeof setTimeout> | undefined
	let rejectCleanup!: (error: Error) => void
	const cleanupFailure = new Promise<never>((_resolve, reject) => (rejectCleanup = reject))
	const cancel = () => {
		if (stopping || closed) return
		// Capture descendants before killing the root; native abort signals can lose that ownership.
		const pid = child.pid
		stopping = Promise.resolve().then(() =>
			cancellation.terminateProcessTree(pid ? [pid] : [], { allowMissingWindowsRoots: true }),
		)
		void stopping.then(
			() => {
				settlementTimer = setTimeout(
					() =>
						rejectCleanup(
							new WorktreeProcessCleanupError(
								"Cancelled worktree process did not settle after tree cleanup",
							),
						),
					CANCELLED_PROCESS_SETTLEMENT_TIMEOUT_MS,
				)
			},
			(error: unknown) =>
				rejectCleanup(
					new WorktreeProcessCleanupError("Worktree process-tree cleanup failed", { cause: error }),
				),
		)
	}
	if (cancellation.signal.aborted) cancel()
	else cancellation.signal.addEventListener("abort", cancel, { once: true })
	try {
		const result = await Promise.race([execution, cleanupFailure])
		await stopping
		cancellation.signal.throwIfAborted()
		return result
	} catch (error) {
		try {
			await stopping
		} catch (cleanupError) {
			throw new WorktreeProcessCleanupError("Worktree process-tree cleanup failed", { cause: cleanupError })
		}
		if (!(error instanceof WorktreeProcessCleanupError)) cancellation.signal.throwIfAborted()
		throw error
	} finally {
		child.removeListener("close", observeClose)
		cancellation.signal.removeEventListener("abort", cancel)
		if (settlementTimer) clearTimeout(settlementTimer)
	}
}
