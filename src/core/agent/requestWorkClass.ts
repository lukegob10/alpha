/**
 * Host-side request classification for completion and workflow guidance.
 *
 * This heuristic is not an execution-policy boundary. Tool availability comes
 * from the captured mode and policy, independently of request wording.
 */

export type RequestWorkClass = "lookup" | "full"

export type RequestWorkClassReason =
	| "lookup_question"
	| "implementation"
	| "explicit_workflow"
	| "uncertain"
	| "empty"
	| "subagent"

export interface RequestWorkClassDecision {
	class: RequestWorkClass
	reason: RequestWorkClassReason
	/** The request references a named skill. */
	includeSkill: boolean
	/** The request references Alpha Tickets. */
	includeTickets: boolean
	/** The request references MCP resources. */
	includeMcpResources: boolean
}

const WORKFLOW_INTENT_RE =
	/\b(?:spawn(?:_agent)?|delegate(?:\s+to)?\s+(?:a\s+)?(?:sub)?agent|create(?:\s+a)?\s+ticket|file(?:\s+a)?\s+ticket|update(?:\s+a)?\s+ticket|delete(?:\s+a)?\s+ticket|playwright|update[_ ](?:todo[_ ]list|plan)|work[- ]plan)\b/i

const BROWSER_INTERACTION_ACTION_RE =
	/\b(?:use|drive|control|interact|open|navigate|inspect|read|click|type|select|filter|reload|screenshot|scroll|submit|add|test|exercise|verify|check|run|try|fill|enter|search|visit|browse|capture|show|display|render)\b/i
const BROWSER_REFERENCE_RE = /\b(?:browser|web(?:\s+(?:page|site))?|website|site|page|url|link)\b/i
const BROWSER_INFORMATION_QUESTION_RE =
	/^(?:how\s+(?:do|can|would|should)\s+(?:i|we|you)\b|(?:can|could)\s+you\s+(?:tell|show|explain)\b|(?:what|which)\s+(?:(?:integrated\s+)?browser(?:\s+(?:tools?|actions?|capabilities))?|tools?)\b|(?:can|could|do|does|is|are)\s+(?!you\b|we\b)[\w'-]+\b[\s\S]{0,120}\b(?:browser|web(?:\s+(?:page|site))?|website|site|page|url|link)\b)/i
const BROWSER_ACTION_REQUEST_RE =
	/(?:^|[.!?;\n]\s*)(?:(?:please|then|also|now|let's)\s+)*(?:(?:can|could|would)\s+you\s+|(?:i|we)\s+(?:want|need)\s+(?:you\s+to|to)\s+|(?:i|we)(?:'d| would)\s+like\s+to\s+)?(?:drive|control|interact|open|navigate|inspect|read|click|type|select|filter|reload|screenshot|scroll|submit|add|test|exercise|verify|check|run|try|fill|enter|search|visit|browse|capture|show|display|render)\b/i
const BROWSER_USE_REQUEST_RE =
	/(?:^|[.!?;\n]\s*)(?:(?:please|then|also|now|let's)\s+)*(?:(?:can|could|would)\s+you\s+|(?:i|we)\s+(?:want|need)\s+(?:you\s+to|to)\s+|(?:i|we)(?:'d| would)\s+like\s+to\s+)?use\b[\s\S]{0,100}\b(?:browser|web(?:\s+(?:page|site))?|website|site|page|url|link)\b/i

function hasBrowserInteractionIntent(text: string): boolean {
	return (
		BROWSER_INTERACTION_ACTION_RE.test(text) &&
		BROWSER_REFERENCE_RE.test(text) &&
		(!BROWSER_INFORMATION_QUESTION_RE.test(text) ||
			BROWSER_ACTION_REQUEST_RE.test(text) ||
			BROWSER_USE_REQUEST_RE.test(text))
	)
}

const CROSS_TASK_ACTION_RE =
	/\b(?:launch|start|create|open|spin\s+up|send|message|steer|stop|cancel|wait\s+for|check\s+on|list)\b(?:\s+[\w-]+){0,5}\s+(?:threads?|chats?|tasks?|sub-?agents?|agents?)\b/i
const HOW_TO_QUESTION_RE =
	/^(?:how\s+(?:do|can|would|should)\s+(?:i|we|you)|can\s+you\s+(?:tell|show|explain)\s+me\s+how)\b/i

const NAMED_SKILL_RE =
	/\b(?:use|load|follow|apply)\s+(?:the\s+)?[\w.-]+\s+skill\b|\b(?:create|author)\s+(?:a\s+)?skill\b|\bSKILL\.md\b/i

const TICKET_INTENT_RE = /\btickets?\b|\b[A-Z]{2,4}(?:\s*(?:[-#]|number\s*)\s*)?(?:\d{1,10}|one)\b/i

const MCP_RESOURCE_INTENT_RE = /\bmcp\b|\bresource(?:s|\s+templates?)?\b/i

const IMPLEMENTATION_LEAD_RE =
	/(?:^|[.!?;\n]\s*)(?:(?:please|then|also|now|let's)\s+)*(?:(?:can|could|would|will)\s+you\s+|(?:i|we)\s+(?:want|need)\s+(?:you\s+to|to)\s+|(?:i|we)(?:'d| would)\s+like\s+(?:you\s+to|to)\s+)?(?:implement|fix|add|create|write|edit|delete|remove|rename|refactor|migrate|update|patch|install|change)\b/i

const IMPLEMENTATION_ASK_RE =
	/\bplease\s+(?:implement|fix|add|create|write|edit|delete|remove|rename|refactor|update|change)\b|\b(?:implement|refactor|migrate)\b|\band\s+(?:then\s+)?(?:fix|implement|change|edit|add|write)\b/i

const LOOKUP_QUESTION_RE =
	/^(?:where|what|which|does|do|is|are|can|could|who|how(?:\s+does|\s+is|\s+are)?)\b|\bwhere\s+(?:is|are|does|do|the)\b|\btell me (?:where|what|which|how)\b|\bwhat\s+file\b|\bwhich\s+file\b|\bdoes\s+this\s+(?:repo|repository|codebase|project|tree|workspace)\s+contain\b|\b(?:locate|find)\s+(?:the\s+)?(?:file|definition|declaration|symbol|function|class|constant|path)\b/i

const TICKET_OR_SKILL_READ_LEAD_RE =
	/^(?:please\s+)?(?:read|list|open)\s+(?:the\s+)?tickets?\b|^(?:please\s+)?(?:use|load|follow|apply)\s+(?:the\s+)?[\w.-]+\s+skill\b/i

const READ_ONLY_CONSTRAINT_RE =
	/\bdo\s+not\s+(?:change|edit|write|modify|mutate)\b|\bleave\s+(?:the\s+)?(?:files|workspace|repo)\s+unchanged\b/i

export function classifyRequestWorkClass(
	userRequestText: string | undefined,
	options: { taskKind?: "primary" | "subagent" } = {},
): RequestWorkClassDecision {
	if (options.taskKind === "subagent") {
		return {
			class: "full",
			reason: "subagent",
			includeSkill: false,
			includeTickets: false,
			includeMcpResources: false,
		}
	}

	const text = (userRequestText ?? "").trim()
	if (!text) {
		return {
			class: "full",
			reason: "empty",
			includeSkill: false,
			includeTickets: false,
			includeMcpResources: false,
		}
	}

	const includeSkill = NAMED_SKILL_RE.test(text)
	const includeTickets = TICKET_INTENT_RE.test(text)
	const includeMcpResources = MCP_RESOURCE_INTENT_RE.test(text)

	if (
		WORKFLOW_INTENT_RE.test(text) ||
		hasBrowserInteractionIntent(text) ||
		(CROSS_TASK_ACTION_RE.test(text) && !HOW_TO_QUESTION_RE.test(text)) ||
		(includeSkill && /\b(?:create|author)\s+(?:a\s+)?skill\b/i.test(text))
	) {
		return { class: "full", reason: "explicit_workflow", includeSkill, includeTickets, includeMcpResources }
	}

	if (IMPLEMENTATION_LEAD_RE.test(text) || IMPLEMENTATION_ASK_RE.test(text)) {
		return { class: "full", reason: "implementation", includeSkill, includeTickets, includeMcpResources }
	}

	if (
		LOOKUP_QUESTION_RE.test(text) ||
		READ_ONLY_CONSTRAINT_RE.test(text) ||
		TICKET_OR_SKILL_READ_LEAD_RE.test(text)
	) {
		return { class: "lookup", reason: "lookup_question", includeSkill, includeTickets, includeMcpResources }
	}

	return { class: "full", reason: "uncertain", includeSkill, includeTickets, includeMcpResources }
}

interface RequestMessage {
	role: string
	content: unknown
	agent_message_id?: string
	input_origin?: "human" | "agent"
	hook_prompt?: unknown
	isSummary?: boolean
	isTruncationMarker?: boolean
}

export function extractUserRequestText(
	messages: readonly RequestMessage[] | undefined,
	fallbackTaskText?: string,
): string | undefined {
	if (messages) {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.role !== "user") continue
			// Provider roles include tool/agent/hook input. Only human instructions
			// may authorize work; retain the last real human request and revocation.
			if (
				message.agent_message_id !== undefined ||
				message.input_origin === "agent" ||
				message.hook_prompt !== undefined ||
				message.isSummary ||
				message.isTruncationMarker
			)
				continue
			if (isToolResultOnly(message.content)) continue
			const extracted = normalizeUserRequestText(textFromContent(message.content))
			if (extracted) return extracted
		}
		// Once history exists, an older metadata objective cannot stand in for
		// missing human provenance (for example after compaction of a revocation).
		if (messages.length > 0) return undefined
	}
	const fallback = normalizeUserRequestText(fallbackTaskText ?? "")
	return fallback || undefined
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	const parts: string[] = []
	for (const block of content) {
		if (!block || typeof block !== "object") continue
		const typed = block as { type?: string; text?: string }
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text)
	}
	return parts.join("\n")
}

function isToolResultOnly(content: unknown): boolean {
	if (!Array.isArray(content) || content.length === 0) return false
	return content.every(
		(block) => block && typeof block === "object" && (block as { type?: string }).type === "tool_result",
	)
}

function normalizeUserRequestText(text: string): string {
	// Historical agent continuations predate structured provenance. Read their
	// host wrapper conservatively, including a continuation mixed with tool data.
	if (/<agent_message(?:\s|>)/i.test(text)) return ""
	const withoutEnvironment = stripEnvironmentDetails(text).trim()
	const opening = /<user_message>/i.exec(withoutEnvironment)
	if (!opening) return withoutEnvironment
	const contentStart = opening.index + opening[0].length
	const closingTag = /<\/user_message>/gi
	closingTag.lastIndex = contentStart
	const closing = closingTag.exec(withoutEnvironment)
	return closing ? withoutEnvironment.slice(contentStart, closing.index).trim() : withoutEnvironment
}

function stripEnvironmentDetails(text: string): string {
	const parts: string[] = []
	let cursor = 0
	let openIndex: number | undefined
	// Scan fixed delimiters once. Searching for a closing tag from every unmatched
	// opening tag would revisit the remaining input and block the extension host.
	for (const match of text.matchAll(/<\/?environment_details>/gi)) {
		if (match[0][1] !== "/") {
			openIndex ??= match.index
		} else if (openIndex !== undefined) {
			parts.push(text.slice(cursor, openIndex))
			cursor = match.index + match[0].length
			openIndex = undefined
		}
	}
	parts.push(text.slice(cursor))
	return parts.join("")
}
