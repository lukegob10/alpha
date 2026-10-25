import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "./apiMessages"
import { getToolCallId, getToolResultId, sanitizeToolUseId } from "../../utils/tool-id"

/** Keep a retained historical call paired without replaying output the user deliberately removed. */
export function replaceDeliberatelyRemovedToolResults(previous: ApiMessage[], retained: ApiMessage[]): ApiMessage[] {
	const history = retained.slice()
	const previousIndices = new Map(previous.map((message, index) => [message, index]))
	for (let index = 0; index < history.length; index++) {
		const assistant = history[index]
		if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) continue
		const previousIndex =
			previousIndices.get(assistant) ??
			previous.findIndex(
				(message) =>
					message.role === "assistant" &&
					(message.content === assistant.content ||
						(assistant.ts !== undefined && message.ts === assistant.ts)),
			)
		if (previousIndex < 0) continue
		const originalResult = previous[previousIndex + 1]
		if (originalResult?.role !== "user" || !Array.isArray(originalResult.content)) continue
		const following = history[index + 1]
		const followingContent =
			following?.role === "user"
				? Array.isArray(following.content)
					? following.content
					: [{ type: "text" as const, text: following.content }]
				: []
		const originalIds = new Set(
			originalResult.content
				.filter((block) => block.type === "tool_result")
				.map((block) => sanitizeToolUseId(getToolResultId(block) ?? "")),
		)
		const retainedIds = new Set(
			followingContent
				.filter((block) => block.type === "tool_result")
				.map((block) => sanitizeToolUseId(getToolResultId(block) ?? "")),
		)
		const removedResults: Anthropic.ToolResultBlockParam[] = assistant.content
			.map(getToolCallId)
			.filter((id): id is string => id !== undefined)
			.filter((id) => originalIds.has(sanitizeToolUseId(id)) && !retainedIds.has(sanitizeToolUseId(id)))
			.map((id) => ({
				type: "tool_result",
				tool_use_id: id,
				is_error: true,
				content:
					"The tool result was deliberately removed by a conversation rewind. Its prior output is unavailable.",
			}))
		if (removedResults.length === 0) continue
		if (following?.role === "user") {
			history[index + 1] = { ...following, content: [...removedResults, ...followingContent] }
		} else {
			history.splice(index + 1, 0, {
				role: "user",
				input_origin: "agent",
				ts: assistant.ts,
				content: removedResults,
			})
		}
	}
	return history
}
