import { getToolCallId, getToolResultId, ToolHistoryError } from "../../utils/tool-id"

/**
 * Validate the stable provider-history protocol without discarding open-ended
 * provider metadata. Incomplete tool transactions remain valid here: recovery
 * owns pairing after the transcript has been loaded.
 */
export function invalidPersistedApiMessages(value: unknown): string | undefined {
	if (!Array.isArray(value)) return "history must be an array"
	for (const [messageIndex, candidate] of value.entries()) {
		const location = `message ${messageIndex}`
		if (!isRecord(candidate)) return `${location} must be an object`
		if (
			candidate.input_origin !== undefined &&
			candidate.input_origin !== "human" &&
			candidate.input_origin !== "agent"
		) {
			return `${location} has invalid input provenance`
		}
		if (
			candidate.queued_message_ids !== undefined &&
			(!Array.isArray(candidate.queued_message_ids) ||
				candidate.queued_message_ids.length > 100 ||
				candidate.queued_message_ids.some((id) => !hasNonemptyId(id) || id.length > 256))
		) {
			return `${location} has invalid queued input receipts`
		}
		if ("hook_prompt" in candidate && !isHookPromptProvenance(candidate.hook_prompt)) {
			return `${location} has invalid hook prompt provenance`
		}
		if (candidate.reasoning_details !== undefined && !Array.isArray(candidate.reasoning_details)) {
			return `${location} has invalid reasoning details`
		}
		if (candidate.reasoning_content !== undefined && typeof candidate.reasoning_content !== "string") {
			return `${location} has invalid reasoning content`
		}
		if (candidate.type === "reasoning") {
			const problem = invalidReasoningRecord(candidate, true)
			if (problem) return `${location} ${problem}`
			if (candidate.role === undefined) continue
		}
		if (candidate.role !== "user" && candidate.role !== "assistant") return `${location} has an invalid role`
		if (typeof candidate.content === "string") continue
		if (!Array.isArray(candidate.content)) return `${location} has invalid content`
		for (const [blockIndex, block] of candidate.content.entries()) {
			const blockLocation = `${location} block ${blockIndex}`
			if (!isRecord(block) || typeof block.type !== "string" || block.type.length === 0) {
				return `${blockLocation} must be a typed object`
			}
			try {
				getToolCallId(block)
				getToolResultId(block)
			} catch (error) {
				if (error instanceof ToolHistoryError) return `${blockLocation} has conflicting tool IDs`
				throw error
			}
			switch (block.type) {
				case "text":
					if (typeof block.text !== "string") return `${blockLocation} has invalid text`
					break
				case "reasoning": {
					const problem = invalidReasoningRecord(block, false)
					if (problem) return `${blockLocation} ${problem}`
					break
				}
				case "thinking":
					if (typeof block.thinking !== "string") return `${blockLocation} has invalid thinking text`
					if (!hasNonemptyId(block.signature)) return `${blockLocation} has an invalid thinking signature`
					break
				case "redacted_thinking":
					if (typeof block.data !== "string") return `${blockLocation} has invalid redacted thinking`
					break
				case "thoughtSignature":
					if (!hasNonemptyId(block.thoughtSignature))
						return `${blockLocation} has an invalid thought signature`
					break
				case "tool_use":
					if (typeof block.id !== "string" || block.id.length === 0)
						return `${blockLocation} has an invalid tool ID`
					if (typeof block.name !== "string" || block.name.length === 0) {
						return `${blockLocation} has an invalid tool name`
					}
					// Freeform provider tools may persist a string instead of JSON arguments.
					if (!("input" in block)) return `${blockLocation} has missing tool input`
					break
				case "tool_result":
					if (!hasNonemptyId(block.tool_use_id) && !hasNonemptyId(block.tool_call_id)) {
						return `${blockLocation} has an invalid tool result ID`
					}
					if (
						block.content !== undefined &&
						block.content !== null &&
						typeof block.content !== "string" &&
						!Array.isArray(block.content)
					) {
						return `${blockLocation} has invalid tool result content`
					}
					break
				case "tool_call":
					if (!hasNonemptyId(block.id) && !hasNonemptyId(block.tool_call_id)) {
						return `${blockLocation} has an invalid tool call ID`
					}
					break
			}
		}
	}
	return undefined
}

/** Known continuity fields must be replayable; provider-specific extra fields remain opaque. */
function invalidReasoningRecord(value: Record<string, unknown>, requireEncrypted: boolean): string | undefined {
	if ((requireEncrypted || value.encrypted_content !== undefined) && !hasNonemptyId(value.encrypted_content)) {
		return "must contain encrypted reasoning"
	}
	if (value.text !== undefined && typeof value.text !== "string") return "has invalid reasoning text"
	if (!requireEncrypted && value.text === undefined && value.encrypted_content === undefined) {
		return "must contain reasoning text or encrypted reasoning"
	}
	if (value.id !== undefined && typeof value.id !== "string") return "has an invalid reasoning ID"
	if (value.summary !== undefined && !Array.isArray(value.summary)) return "has an invalid reasoning summary"
	if (value.signature !== undefined && typeof value.signature !== "string")
		return "has an invalid reasoning signature"
	return undefined
}

function isHookPromptProvenance(value: unknown): boolean {
	if (!isRecord(value) || (value.event !== "Stop" && value.event !== "SubagentStop")) return false
	if (!Array.isArray(value.fragments) || value.fragments.length === 0) return false
	return value.fragments.every(
		(fragment) =>
			isRecord(fragment) &&
			hasNonemptyId(fragment.hook_run_id) &&
			typeof fragment.text === "string" &&
			fragment.text.trim().length > 0,
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasNonemptyId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0
}
