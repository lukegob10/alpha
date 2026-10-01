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
		if (candidate.type === "reasoning" && candidate.role === undefined) {
			if (typeof candidate.encrypted_content !== "string" || candidate.encrypted_content.length === 0) {
				return `${location} must contain encrypted reasoning`
			}
			if (candidate.id !== undefined && typeof candidate.id !== "string")
				return `${location} has an invalid reasoning ID`
			if (candidate.summary !== undefined && !Array.isArray(candidate.summary)) {
				return `${location} has an invalid reasoning summary`
			}
			continue
		}
		if (candidate.role !== "user" && candidate.role !== "assistant") return `${location} has an invalid role`
		if (typeof candidate.content === "string") continue
		if (!Array.isArray(candidate.content)) return `${location} has invalid content`
		for (const [blockIndex, block] of candidate.content.entries()) {
			const blockLocation = `${location} block ${blockIndex}`
			if (!isRecord(block) || typeof block.type !== "string" || block.type.length === 0) {
				return `${blockLocation} must be a typed object`
			}
			switch (block.type) {
				case "text":
					if (typeof block.text !== "string") return `${blockLocation} has invalid text`
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
