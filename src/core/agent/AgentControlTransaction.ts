/** Labels are deliberately closed: lock metadata must never contain command text or task content. */
export const AGENT_CONTROL_OPERATIONS = [
	"transaction",
	"initialize",
	"recovery",
	"mutation",
	"reserve-primary-mutation",
] as const

export type AgentControlOperation = (typeof AGENT_CONTROL_OPERATIONS)[number]

export interface AgentControlTransactionOptions {
	signal?: AbortSignal
	operation?: AgentControlOperation
	/** Monotonic time already spent in the store's queue, included in the acquisition budget. */
	queueWaitMs?: number
}

export interface AgentControlTransactionDiagnostic {
	operation: AgentControlOperation
	outcome: "success" | "error" | "cancelled"
	queueWaitMs: number
	acquisitionWaitMs: number
	holdMs: number
	releaseMs: number
	attempts: number
	ownerState: "none" | "live" | "dead" | "released" | "legacy" | "unreadable"
	ownerPid?: number
	ownerOperation?: AgentControlOperation
	committed: boolean
	releaseFailed: boolean
}

export interface FileAgentControlPersistenceOptions {
	/** Queue plus acquisition deadline; never a lease expiry or a transaction-body timeout. */
	transactionWaitTimeoutMs?: number
	maxPendingTransactions?: number
	onTransactionDiagnostic?: (diagnostic: AgentControlTransactionDiagnostic) => void
}

export class AgentControlTransactionError extends Error {
	constructor(
		message: string,
		readonly code: "ELOCKED" | "ELOCKLEGACY" | "ELOCKOWNER" | "EQUEUEFULL" | "ABORT_ERR",
		public diagnostic?: AgentControlTransactionDiagnostic,
	) {
		super(message)
		this.name = code === "ABORT_ERR" ? "AbortError" : "AgentControlTransactionError"
	}
}

export const DEFAULT_TRANSACTION_WAIT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_PENDING_TRANSACTIONS = 64

export function createTransactionDiagnostic(
	options: AgentControlTransactionOptions = {},
): AgentControlTransactionDiagnostic {
	return {
		operation: AGENT_CONTROL_OPERATIONS.includes(options.operation!) ? options.operation! : "transaction",
		outcome: "error",
		queueWaitMs:
			options.queueWaitMs !== undefined && Number.isFinite(options.queueWaitMs) && options.queueWaitMs >= 0
				? options.queueWaitMs
				: 0,
		acquisitionWaitMs: 0,
		holdMs: 0,
		releaseMs: 0,
		attempts: 0,
		ownerState: "none",
		committed: false,
		releaseFailed: false,
	}
}

export function logTransactionDiagnostic(diagnostic: AgentControlTransactionDiagnostic): void {
	if (diagnostic.outcome === "error" || diagnostic.releaseFailed || diagnostic.acquisitionWaitMs >= 1_000) {
		console.warn("[AgentControlStore] Transaction diagnostic", diagnostic)
	}
}

export function throwIfTransactionCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		// Do not propagate an arbitrary abort reason into bounded diagnostics.
		throw new AgentControlTransactionError("Agent control transaction acquisition was cancelled", "ABORT_ERR")
	}
}

interface QueueEntry {
	start: () => void
}

/** A removable FIFO keeps cancellation prompt without retaining cancelled promise chains. */
export class AgentControlTransactionQueue {
	private active = false
	private readonly pending: QueueEntry[] = []
	private readonly idleWaiters = new Set<() => void>()

	constructor(private readonly maxPending = DEFAULT_MAX_PENDING_TRANSACTIONS) {}

	async run<T>(
		operation: (queueWaitMs: number) => Promise<T>,
		signal?: AbortSignal,
		timeoutMs = DEFAULT_TRANSACTION_WAIT_TIMEOUT_MS,
	): Promise<T> {
		throwIfTransactionCancelled(signal)
		const started = performance.now()
		if (this.active) {
			if (this.pending.length >= this.maxPending) {
				throw new AgentControlTransactionError(
					"Agent control transaction queue is full; retry later",
					"EQUEUEFULL",
				)
			}
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					clearTimeout(timer)
					signal?.removeEventListener("abort", abort)
				}
				const remove = (error: AgentControlTransactionError) => {
					const index = this.pending.indexOf(entry)
					if (index < 0) return
					this.pending.splice(index, 1)
					cleanup()
					reject(error)
				}
				const abort = () =>
					remove(
						new AgentControlTransactionError(
							"Agent control transaction acquisition was cancelled",
							"ABORT_ERR",
						),
					)
				const timer = setTimeout(
					() =>
						remove(
							new AgentControlTransactionError("Agent control transaction queue wait expired", "ELOCKED"),
						),
					timeoutMs,
				)
				const entry: QueueEntry = {
					start: () => {
						cleanup()
						resolve()
					},
				}
				this.pending.push(entry)
				signal?.addEventListener("abort", abort, { once: true })
			})
		} else {
			this.active = true
		}
		try {
			throwIfTransactionCancelled(signal)
			const queueWaitMs = performance.now() - started
			if (queueWaitMs >= timeoutMs) {
				throw new AgentControlTransactionError("Agent control transaction queue wait expired", "ELOCKED")
			}
			return await operation(queueWaitMs)
		} finally {
			const next = this.pending.shift()
			if (next) next.start()
			else {
				this.active = false
				for (const resolve of this.idleWaiters) resolve()
				this.idleWaiters.clear()
			}
		}
	}

	async whenIdle(): Promise<void> {
		if (!this.active) return
		await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
	}
}

/** Cancel only an uncommitted retry wait, without exposing an arbitrary abort reason. */
export async function waitForTransactionRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	throwIfTransactionCancelled(signal)
	await new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer)
			signal?.removeEventListener("abort", abort)
			reject(new AgentControlTransactionError("Agent control transaction replacement was cancelled", "ABORT_ERR"))
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort)
			resolve()
		}, delayMs)
		signal?.addEventListener("abort", abort, { once: true })
	})
}
