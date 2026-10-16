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

export function isUnansweredCommandReview(
	message: Pick<AlphaMessage, "type" | "ask" | "partial" | "isAnswered" | "text">,
): boolean {
	return (
		message.type === "ask" && message.ask === "command" && message.partial !== true && message.isAnswered !== true
	)
}
