import type { ApiHandlerSingleCompletionMetadata } from "../index"

export function throwIfSingleCompletionAborted(metadata?: ApiHandlerSingleCompletionMetadata): void {
	metadata?.signal?.throwIfAborted()
}

/** Reject promptly even when a provider or credential source ignores its cancellation signal. */
export async function awaitSingleCompletion<T>(
	operation: PromiseLike<T>,
	metadata?: ApiHandlerSingleCompletionMetadata,
): Promise<T> {
	const signal = metadata?.signal
	if (!signal) return await operation

	let onAbort: (() => void) | undefined
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason)
		if (signal.aborted) {
			onAbort()
		} else {
			signal.addEventListener("abort", onAbort, { once: true })
		}
	})
	try {
		const result = await Promise.race([operation, cancelled])
		throwIfSingleCompletionAborted(metadata)
		return result
	} catch (error) {
		throwIfSingleCompletionAborted(metadata)
		throw error
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort)
	}
}
