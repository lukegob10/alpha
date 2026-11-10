import type { ApiMessage } from "./apiMessages"
import type { AgentResponseItem } from "../agent/AgentResponse"
import { snapshotGeminiResponse, snapshotVscodeLmThinking } from "@alpha-code/types"

export const MAX_SAMPLED_AGENT_MAIL_IDS = 100

/** Empty framing and usage are not evidence that regular inference produced semantic output. */
export function hasAgentMailSamplingEvidence(items: readonly AgentResponseItem[]): boolean {
	return items.some((item) => {
		if (item.type === "text") return item.text.trim().length > 0
		if (item.type === "tool_call") return !!(item.id.trim() && item.name.trim() && !item.argumentParseError)
		if (item.type !== "reasoning") return false
		if (item.text.trim() || item.signature?.trim() || item.encryptedContent?.trim() || item.redactedData?.trim())
			return true
		const thinking = item.vscodeLmThinking && snapshotVscodeLmThinking(item.vscodeLmThinking)
		if (
			thinking &&
			((typeof thinking.value === "string"
				? thinking.value.trim().length > 0
				: thinking.value.some((text) => text.trim().length > 0)) ||
				(thinking.metadata && Object.keys(thinking.metadata).length > 0))
		)
			return true
		const gemini = item.geminiResponse && snapshotGeminiResponse(item.geminiResponse)
		return !!gemini?.parts.some(
			(part) => part.text?.trim() || part.thoughtSignature?.trim() || part.functionCall?.name.trim(),
		)
	})
}

/** Mailbox ACK means durable delivery, not model consumption. Legacy mail has no sampling proof. */
export function getPendingAgentMailIds(history: readonly ApiMessage[]): Set<string> {
	const sampled = new Set(
		history.flatMap((message) => (message.role === "assistant" ? (message.sampled_agent_message_ids ?? []) : [])),
	)
	return new Set(
		history.flatMap((message) =>
			message.role === "user" &&
			message.input_origin === "agent" &&
			message.agent_message_id &&
			!sampled.has(message.agent_message_id)
				? [message.agent_message_id]
				: [],
		),
	)
}
