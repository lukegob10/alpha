const MAX_THREAD_RESPONSE_BYTES = 8_000
const contentKeys = new Set(["text", "title", "summary", "message", "preview", "result", "objective", "error"])

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function shortenContent(value: unknown, limit: number): unknown {
	if (Array.isArray(value)) return value.map((item) => shortenContent(item, limit))
	if (!isObject(value)) return value
	const result: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value)) {
		if (contentKeys.has(key) && typeof item === "string" && Array.from(item).length > limit) {
			result[key] = Array.from(item).slice(0, limit).join("")
			result.truncated = true
		} else {
			result[key] = shortenContent(item, limit)
		}
	}
	return result
}

/** Bound structured responses without cutting JSON, protocol identities, or pagination cursors. */
export function serializeThreadResult(value: unknown, maxOutputChars?: number): string {
	const fits = (text: string) =>
		Buffer.byteLength(text, "utf8") <= MAX_THREAD_RESPONSE_BYTES &&
		(maxOutputChars === undefined || text.length <= Math.max(0, maxOutputChars))
	const original = JSON.stringify(value)
	if (original === undefined) throw new Error("The thread response is not serializable")
	if (fits(original)) return original
	const compact = structuredClone(value)
	if (!isObject(compact)) throw new Error("Thread response metadata exceeds the output budget")
	compact.truncated = true
	if (Array.isArray(compact.turns)) {
		compact.turns = compact.turns.map((turn: unknown) => {
			if (!isObject(turn) || !Array.isArray(turn.items)) return turn
			const lastAnswer = [...turn.items]
				.reverse()
				.find((item: unknown) => isObject(item) && item.type === "agentMessage")
			return { ...turn, items: lastAnswer ? [lastAnswer] : [], truncated: true }
		})
		if (isObject(compact.thread)) compact.thread = { id: compact.thread.id, status: compact.thread.status }
	} else if (Array.isArray(compact.threads)) {
		// Preserve every entry so pagination still identifies the same page.
		compact.threads = compact.threads.map((thread: unknown) => {
			if (!isObject(thread)) return thread
			return {
				id: thread.id,
				kind: thread.kind,
				title: thread.title,
				summary: thread.summary,
				status: thread.status,
				truncated: true,
			}
		})
	} else if (Array.isArray(compact.polls)) {
		compact.polls = compact.polls.map((poll: unknown) => {
			if (!isObject(poll)) return poll
			return { ...poll, latestToolMarker: null, truncated: true }
		})
	}
	let low = 0
	let high = MAX_THREAD_RESPONSE_BYTES
	let best: string | undefined
	while (low <= high) {
		const limit = Math.floor((low + high) / 2)
		const text = JSON.stringify(shortenContent(compact, limit))
		if (fits(text)) {
			best = text
			low = limit + 1
		} else {
			high = limit - 1
		}
	}
	if (best === undefined) throw new Error("Thread response metadata exceeds the output budget")
	return best
}
