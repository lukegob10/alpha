/**
 * Serializes embedding request starts so concurrent indexing batches do not
 * burst through provider rate limits.
 */
export class EmbeddingRateLimiter {
	private nextRequestStartedAt = 0
	private cooldownUntil = 0
	private queue = Promise.resolve()

	constructor(private readonly delayMs: number) {}

	public async wait(signal?: AbortSignal, inputCount = 1): Promise<void> {
		signal?.throwIfAborted()
		const next = this.queue.then(async () => {
			while (true) {
				signal?.throwIfAborted()
				const waitMs = Math.max(this.nextRequestStartedAt, this.cooldownUntil) - Date.now()
				if (waitMs <= 0) break
				// A concurrent 429 can extend the cooldown while this timer is pending.
				await waitForEmbeddingDelay(Math.min(waitMs, 2_147_483_647), signal)
			}
			this.nextRequestStartedAt = Date.now() + Math.max(0, this.delayMs) * Math.max(1, inputCount)
		})

		this.queue = next.catch(() => undefined)
		if (!signal) return next
		// A cancelled caller need not wait for unrelated callers ahead of it.
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(signal.reason)
			signal.addEventListener("abort", onAbort, { once: true })
			void next.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
		})
	}

	/** Provider cooldowns cover all queued requests, including retries and query embeddings. */
	public defer(delayMs: number): void {
		if (Number.isFinite(delayMs) && delayMs > 0) {
			this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delayMs)
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
