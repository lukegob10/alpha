/**
 * Serializes embedding request starts so concurrent indexing batches do not
 * burst through provider rate limits.
 */
export class EmbeddingRateLimiter {
	private lastRequestStartedAt = 0
	private queue = Promise.resolve()

	constructor(private readonly delayMs: number) {}

	public async wait(): Promise<void> {
		if (this.delayMs <= 0) {
			return
		}

		const next = this.queue.then(async () => {
			const now = Date.now()
			const elapsedMs = now - this.lastRequestStartedAt
			const waitMs = this.lastRequestStartedAt > 0 ? Math.max(0, this.delayMs - elapsedMs) : 0

			if (waitMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, waitMs))
			}

			this.lastRequestStartedAt = Date.now()
		})

		this.queue = next.catch(() => undefined)
		await next
	}
}
