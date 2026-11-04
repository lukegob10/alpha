import { isHookPromptProvenance } from "../../core/task-persistence/validatePersistedApiMessages"

/** Codex 67f0994b uses developer context for lifecycle output and user input for Stop continuations. */
export function getLifecycleHookDeveloperContext(message: unknown): string | undefined {
	if (
		!isRecord(message) ||
		message.role !== "user" ||
		message.input_origin !== "agent" ||
		message.isSummary ||
		message.isTruncationMarker ||
		message.agent_message_id !== undefined ||
		message.queued_message_ids !== undefined
	)
		return undefined
	const provenance = message.hook_prompt
	if (
		!isHookPromptProvenance(provenance) ||
		provenance.event === "Stop" ||
		provenance.event === "SubagentStop" ||
		provenance.fragments.some(({ hook_run_id }) => !hook_run_id.trim())
	)
		return undefined

	let content: string
	if (typeof message.content === "string") content = message.content
	else if (Array.isArray(message.content)) {
		const parts: string[] = []
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return undefined
			parts.push(part.text)
		}
		content = parts.join("")
	} else return undefined

	// Provenance cannot grant authority to a human message or unrelated tool output.
	return content === provenance.fragments.map(({ text }) => text).join("\n\n") ? content : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}
