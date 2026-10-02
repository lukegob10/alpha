import { canonicalizeToolName } from "../tools/ToolRegistry"

/**
 * Vertex/Gemini must keep declarations for tools already present in provider
 * history without making historical declarations an execution grant.
 */
export function toolNamesReferencedInHistory(
	history: readonly { role?: string; content?: unknown }[] | undefined,
): string[] {
	const names = new Set<string>()
	if (!history) return []
	for (const message of history) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (!block || typeof block !== "object") continue
			const typed = block as { type?: string; name?: string }
			if (typed.type === "tool_use" && typeof typed.name === "string" && typed.name.trim()) {
				names.add(canonicalizeToolName(typed.name))
			}
		}
	}
	return [...names].sort()
}
