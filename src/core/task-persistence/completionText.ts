import type { ClineMessage } from "@alpha-code/types"

type CompletionMessage = Pick<ClineMessage, "type" | "ask" | "say" | "text" | "partial">

const nonEmptyText = (message: CompletionMessage): string | undefined => {
	if (message.partial === true || typeof message.text !== "string" || message.text.trim().length === 0) {
		return undefined
	}

	return message.text
}

const isCompletionBoundary = (message: CompletionMessage): boolean =>
	message.type === "ask" && message.ask === "completion_result"

const findCompletionTextInTurn = (
	messages: readonly CompletionMessage[],
	startIndex: number,
	stopAtCompletionBoundary: boolean,
): string | undefined => {
	let latestAssistantText: string | undefined

	for (let index = startIndex; index >= 0; index--) {
		const message = messages[index]
		if (stopAtCompletionBoundary && isCompletionBoundary(message)) {
			break
		}

		if (message.type !== "say") {
			continue
		}

		const text = nonEmptyText(message)
		if (!text) {
			continue
		}

		if (message.say === "completion_result") {
			return text
		}

		if (message.say === "text" && latestAssistantText === undefined) {
			latestAssistantText = text
		}
	}

	return latestAssistantText
}

/**
 * Returns the final assistant text from the latest completed task turn.
 *
 * A completion ask is a lifecycle boundary, not necessarily content. Explicit
 * `completion_result` messages are authoritative when present; provider-neutral
 * plain assistant text is the fallback for hosts that finish without that tool.
 */
export function getLatestTaskCompletionText(messages: readonly CompletionMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const boundary = messages[index]
		if (!isCompletionBoundary(boundary)) {
			continue
		}

		// Older persisted tasks may have stored the result on the ask itself.
		const legacyBoundaryText = nonEmptyText(boundary)
		if (legacyBoundaryText) {
			return legacyBoundaryText
		}

		return findCompletionTextInTurn(messages, index - 1, true)
	}

	// Be tolerant of older/incomplete histories that predate the boundary ask.
	return findCompletionTextInTurn(messages, messages.length - 1, false)
}
