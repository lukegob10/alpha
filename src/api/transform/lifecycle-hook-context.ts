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

/** Native Messages, Gemini and VS Code LM have no chronological developer role. */
export function getLifecycleHookContextFallback(message: unknown): string | undefined {
	const context = getLifecycleHookDeveloperContext(message)
	if (context === undefined || !isRecord(message) || !isRecord(message.hook_prompt)) return undefined
	// Codex be765f1 preserves lifecycle output as developer context. Retain its
	// position and validated origin on hosts that only expose user/model messages.
	return `<developer_context source="lifecycle_hook" event="${message.hook_prompt.event}">\n${context}\n</developer_context>`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}
