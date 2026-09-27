import { canonicalizeToolName } from "../tools/ToolRegistry"
import { classifyRequestWorkClass, type RequestWorkClassDecision } from "./requestWorkClass"

/**
 * Keep fresh lookup requests on the current exec_command schema. Legacy
 * file/search tools remain available only for saved provider-history replay.
 */
export const LOOKUP_CORE_TOOL_NAMES = ["exec_command", "request_user_input", "request_user_input_async"] as const

export const LOOKUP_SKILL_TOOL_NAMES = ["skill"] as const
export const LOOKUP_MCP_RESOURCE_TOOL_NAMES = [
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
] as const
export const LOOKUP_TICKET_TOOL_NAMES = [
	"list_tickets",
	"read_ticket",
	"create_ticket",
	"update_ticket",
	"delete_ticket",
] as const

export function resolveLookupToolNames(decision: RequestWorkClassDecision): ReadonlySet<string> | undefined {
	if (decision.class !== "lookup") return undefined
	// Catalog narrowing compares canonical policy names, while these constants
	// use the current provider-facing schema names (notably exec_command).
	const names = new Set<string>(LOOKUP_CORE_TOOL_NAMES.map(canonicalizeToolName))
	if (decision.includeSkill) {
		for (const name of LOOKUP_SKILL_TOOL_NAMES) names.add(canonicalizeToolName(name))
	}
	if (decision.includeMcpResources) {
		for (const name of LOOKUP_MCP_RESOURCE_TOOL_NAMES) names.add(canonicalizeToolName(name))
	}
	if (decision.includeTickets) {
		for (const name of LOOKUP_TICKET_TOOL_NAMES) names.add(canonicalizeToolName(name))
	}
	return names
}

export function requestWorkClassCacheKey(userRequestText: string | undefined, taskKind?: "primary" | "subagent") {
	const decision = classifyRequestWorkClass(userRequestText, { taskKind })
	return {
		class: decision.class,
		reason: decision.reason,
		includeSkill: decision.includeSkill,
		includeTickets: decision.includeTickets,
		includeMcpResources: decision.includeMcpResources,
	}
}

/**
 * Vertex/Gemini must keep declarations for tools already present in provider
 * history. Fresh lookup steps have none of those names.
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
