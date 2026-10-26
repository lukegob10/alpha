import type { AlphaMessage } from "@alpha-code/types"

/** Cache only the selected projection, so activity metadata does not retain large tool bodies. */
export function createMessagePayloadSelector<T>(
	select: (payload: Record<string, unknown> | undefined) => T,
): (message: AlphaMessage) => T {
	const completed = new WeakMap<AlphaMessage, { text: string | undefined; value: T }>()
	return (message) => {
		const cached = message.partial === true ? undefined : completed.get(message)
		if (cached && cached.text === message.text) return cached.value

		let parsed: unknown
		try {
			parsed = JSON.parse(message.text || "{}")
		} catch {
			parsed = undefined
		}
		const payload =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: undefined
		const value = select(payload)
		// Host updates replace message objects. The source guard also handles legacy
		// mutable callers; partial messages are never retained between stream ticks.
		if (message.partial !== true) completed.set(message, { text: message.text, value })
		return value
	}
}
