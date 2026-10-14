/**
 * Serializes embedding request starts so concurrent indexing batches do not
 * burst through provider rate limits.
 */
import type { EmbeddingPriority } from "../interfaces/embedder"
import { nextEmbeddingRequest } from "./embedding-request-queue"
import { t } from "../../../i18n"

type WaitingRequest = {
	priority: EmbeddingPriority
	inputCount: number
	resolve: () => void
	reject: (reason: unknown) => void
	onWait?: (waitMs: number) => void
	cancel: () => void
	cleanup: () => void
}

export class EmbeddingRateLimiter {
	private nextRequestStartedAt = 0
	private cooldownUntil = 0
	private readonly queue: WaitingRequest[] = []
	private timer?: NodeJS.Timeout
	private foregroundRun = 0
	private draining = false

	constructor(private readonly delayMs: number) {}

	public async wait(
		signal?: AbortSignal,
		inputCount = 1,
		onWait?: (waitMs: number) => void,
		priority: EmbeddingPriority = "bulk",
	): Promise<void> {
		signal?.throwIfAborted()
		if (this.queue.length >= 256) throw new Error(t("embeddings:requestQueueFull"))
		return new Promise<void>((resolve, reject) => {
			const request: WaitingRequest = {
				priority,
				inputCount,
				resolve,
				reject,
				onWait,
				cleanup: () => signal?.removeEventListener("abort", request.cancel),
				cancel: () => {
					const index = this.queue.indexOf(request)
					if (index < 0) return
					this.queue.splice(index, 1)
					request.cleanup()
					reject(signal?.reason)
					this.drain()
				},
			}
			this.queue.push(request)
			signal?.addEventListener("abort", request.cancel, { once: true })
			this.drain()
		})
	}

	private drain(): void {
		// Progress callbacks can cancel, defer, or enqueue work synchronously.
		if (this.draining) return
		this.draining = true
		try {
			if (this.timer) clearTimeout(this.timer)
			this.timer = undefined
			while (this.queue.length) {
				const waitMs = Math.max(this.nextRequestStartedAt, this.cooldownUntil) - Date.now()
				if (waitMs > 0) {
					for (const request of [...this.queue]) {
						if (!this.queue.includes(request)) continue
						try {
							request.onWait?.(waitMs)
						} catch (error) {
							const index = this.queue.indexOf(request)
							if (index < 0) continue
							this.queue.splice(index, 1)
							request.cleanup()
							request.reject(error)
						}
					}
					if (this.queue.length) this.timer = setTimeout(() => this.drain(), Math.min(waitMs, 2_147_483_647))
					return
				}
				const [request] = this.queue.splice(nextEmbeddingRequest(this.queue, this.foregroundRun), 1)
				this.foregroundRun = request.priority === "bulk" ? 0 : this.foregroundRun + 1
				this.nextRequestStartedAt = Date.now() + Math.max(0, this.delayMs) * Math.max(1, request.inputCount)
				request.cleanup()
				request.resolve()
			}
		} finally {
			this.draining = false
		}
	}

	/** Provider cooldowns cover all queued requests, including retries and query embeddings. */
	public defer(delayMs: number): void {
		if (Number.isFinite(delayMs) && delayMs > 0) {
			this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delayMs)
			this.drain()
		}
	}
}

export async function waitForEmbeddingDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + delayMs
	do {
		await new Promise<void>((resolve, reject) => {
			signal?.throwIfAborted()
			const onAbort = () => {
				clearTimeout(timer)
				reject(signal!.reason)
			}
			const timer = setTimeout(
				() => {
					signal?.removeEventListener("abort", onAbort)
					resolve()
				},
				Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647),
			)
			signal?.addEventListener("abort", onAbort, { once: true })
		})
	} while (Date.now() < deadline)
}
