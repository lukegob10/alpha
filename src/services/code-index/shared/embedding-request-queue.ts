import type { EmbeddingPriority } from "../interfaces/embedder"
import { t } from "../../../i18n"

const MAX_PENDING_REQUESTS = 256
const priorities: Record<EmbeddingPriority, number> = { query: 0, incremental: 1, bulk: 2 }

/** FIFO within a lane; every eighth foreground admission gives the oldest waiter a chance. */
export function nextEmbeddingRequest<T extends { priority: EmbeddingPriority }>(
	requests: readonly T[],
	foregroundRun: number,
): number {
	if (foregroundRun >= 8) return 0
	let next = 0
	for (let index = 1; index < requests.length; index++) {
		if (priorities[requests[index].priority] < priorities[requests[next].priority]) next = index
	}
	return next
}

type PendingRequest = {
	priority: EmbeddingPriority
	start: () => void
	cancel: () => void
}

/** One provider-instance boundary for all consumers, with search capacity and bounded edit fan-out. */
export class EmbeddingRequestQueue {
	private readonly pending: PendingRequest[] = []
	private active = 0
	private background = 0
	private incremental = 0
	private foregroundRun = 0
	private readonly backgroundLimit: number

	constructor(private readonly concurrency: number) {
		if (!Number.isInteger(concurrency) || concurrency < 2)
			throw new Error("Embedding concurrency must be at least two")
		// Reserve a slot only in larger pools; small pools retain bulk throughput and prioritize the next free slot.
		this.backgroundLimit = concurrency > 8 ? concurrency - 1 : concurrency
	}

	run<T>(priority: EmbeddingPriority, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(signal.reason)
		if (this.pending.length >= MAX_PENDING_REQUESTS)
			return Promise.reject(new Error(t("embeddings:requestQueueFull")))
		return new Promise<T>((resolve, reject) => {
			const request: PendingRequest = {
				priority,
				cancel: () => {
					const index = this.pending.indexOf(request)
					if (index < 0) return
					this.pending.splice(index, 1)
					signal?.removeEventListener("abort", request.cancel)
					reject(signal?.reason)
					this.drain()
				},
				start: () => {
					signal?.removeEventListener("abort", request.cancel)
					this.active++
					if (priority !== "query") this.background++
					if (priority === "incremental") this.incremental++
					void Promise.resolve()
						.then(operation)
						.then(resolve, reject)
						.finally(() => {
							this.active--
							if (priority !== "query") this.background--
							if (priority === "incremental") this.incremental--
							this.drain()
						})
				},
			}
			this.pending.push(request)
			signal?.addEventListener("abort", request.cancel, { once: true })
			this.drain()
		})
	}

	private drain(): void {
		while (this.active < this.concurrency) {
			const eligible = this.pending.filter(
				(request) =>
					request.priority === "query" ||
					(this.background < this.backgroundLimit &&
						(request.priority !== "incremental" || this.incremental < 2)),
			)
			if (!eligible.length) return
			const request = eligible[nextEmbeddingRequest(eligible, this.foregroundRun)]
			this.foregroundRun = request.priority === "bulk" ? 0 : this.foregroundRun + 1
			this.pending.splice(this.pending.indexOf(request), 1)
			request.start()
		}
	}
}
