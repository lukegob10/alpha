import { classifyRequestWorkClass, type RequestWorkClassDecision } from "./requestWorkClass"

/**
 * Lookup-sized native names. Workflow tools stay in the product; they are omitted
 * from the advertised/callable surface of a classified lookup step.
 */
export const LOOKUP_CORE_TOOL_NAMES = [
	"read_file",
	"search_files",
	"list_files",
	"shell",
	"ask_followup_question",
] as const

export const LOOKUP_OPTIONAL_TOOL_NAMES = ["codebase_search"] as const
export const LOOKUP_SKILL_TOOL_NAMES = ["skill"] as const
export const LOOKUP_TICKET_TOOL_NAMES = ["list_tickets", "read_ticket"] as const

export function resolveLookupToolNames(decision: RequestWorkClassDecision): ReadonlySet<string> | undefined {
	if (decision.class !== "lookup") return undefined
	const names = new Set<string>(LOOKUP_CORE_TOOL_NAMES)
	for (const name of LOOKUP_OPTIONAL_TOOL_NAMES) names.add(name)
	if (decision.includeSkill) {
		for (const name of LOOKUP_SKILL_TOOL_NAMES) names.add(name)
	}
	if (decision.includeTickets) {
		for (const name of LOOKUP_TICKET_TOOL_NAMES) names.add(name)
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
	}
}
