import { strict as assert } from "node:assert"
import type { AlphaMessage } from "@alpha-code/types"

export function assistantVisibleText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.flatMap((part) => {
			assert.ok(part && typeof part === "object" && !Array.isArray(part))
			const block = part as Record<string, unknown>
			// Reasoning and tool payloads are persisted evidence, not the visible assistant answer.
			return block.type === "text" && typeof block.text === "string" ? [block.text] : []
		})
		.join("\n")
}

export function finalAssistantResponse(history: unknown): { text: string; toolCallCount: number } {
	if (!Array.isArray(history)) return { text: "", toolCallCount: 0 }
	const assistant = [...history]
		.reverse()
		.find(
			(message): message is Record<string, unknown> =>
				message !== null &&
				typeof message === "object" &&
				!Array.isArray(message) &&
				message.role === "assistant",
		)
	if (!assistant) return { text: "", toolCallCount: 0 }
	const toolCallCount = Array.isArray(assistant.content)
		? assistant.content.filter(
				(block) =>
					block !== null && typeof block === "object" && !Array.isArray(block) && block.type === "tool_use",
			).length
		: 0
	return {
		// Text accompanying tool intent is commentary; the paired completion
		// receipt determines whether that intent became an accepted answer.
		text: toolCallCount === 0 ? assistantVisibleText(assistant.content) : "",
		toolCallCount,
	}
}

export function isUnansweredCommandReview(
	message: Pick<AlphaMessage, "type" | "ask" | "partial" | "isAnswered" | "text">,
): boolean {
	return (
		message.type === "ask" && message.ask === "command" && message.partial !== true && message.isAnswered !== true
	)
}
