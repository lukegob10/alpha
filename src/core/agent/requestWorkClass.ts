/**
 * Host-side request classification for catalog narrowing.
 *
 * Uncertain requests keep the full authorized Code-mode surface. This is not a
 * hidden model call and must not overfit to one repository or one user story.
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
	/** Advertise `skill` on an otherwise lookup-sized catalog. */
	includeSkill: boolean
	/** Advertise ticket read tools on an otherwise lookup-sized catalog. */
	includeTickets: boolean
}

const USER_MESSAGE_RE = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/i
const ENVIRONMENT_DETAILS_RE = /<environment_details>[\s\S]*?<\/environment_details>/gi

const WORKFLOW_INTENT_RE =
	/\b(?:spawn(?:_agent)?|delegate(?:\s+to)?\s+(?:a\s+)?(?:sub)?agent|create(?:\s+a)?\s+ticket|file(?:\s+a)?\s+ticket|update(?:\s+a)?\s+ticket|delete(?:\s+a)?\s+ticket|open(?:\s+the)?\s+browser|screenshot(?:\s+the)?\s+page|navigate(?:\s+the)?\s+page|playwright|update_todo_list|work[- ]plan)\b/i

const NAMED_SKILL_RE =
	/\b(?:use|load|follow|apply)\s+(?:the\s+)?[\w.-]+\s+skill\b|\b(?:create|author)\s+(?:a\s+)?skill\b|\bSKILL\.md\b/i

const NAMED_TICKET_RE = /\b(?:read|list|open)\s+(?:the\s+)?tickets?\b|\bticket\s+[A-Za-z]{2,}-\d+\b/i

const IMPLEMENTATION_LEAD_RE =
	/^(?:please\s+)?(?:implement|fix|add|create|write|edit|delete|remove|rename|refactor|migrate|update|patch|install|change)\b/i

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
		return { class: "full", reason: "subagent", includeSkill: false, includeTickets: false }
	}

	const text = (userRequestText ?? "").trim()
	if (!text) {
		return { class: "full", reason: "empty", includeSkill: false, includeTickets: false }
	}

	const includeSkill = NAMED_SKILL_RE.test(text)
	const includeTickets = NAMED_TICKET_RE.test(text)

	if (WORKFLOW_INTENT_RE.test(text) || (includeSkill && /\b(?:create|author)\s+(?:a\s+)?skill\b/i.test(text))) {
		return { class: "full", reason: "explicit_workflow", includeSkill, includeTickets }
	}

	if (IMPLEMENTATION_LEAD_RE.test(text) || IMPLEMENTATION_ASK_RE.test(text)) {
		return { class: "full", reason: "implementation", includeSkill, includeTickets }
	}

	if (
		LOOKUP_QUESTION_RE.test(text) ||
		READ_ONLY_CONSTRAINT_RE.test(text) ||
		TICKET_OR_SKILL_READ_LEAD_RE.test(text)
	) {
		return { class: "lookup", reason: "lookup_question", includeSkill, includeTickets }
	}

	return { class: "full", reason: "uncertain", includeSkill, includeTickets }
}

export function extractUserRequestText(
	messages: readonly { role: string; content: unknown }[] | undefined,
	fallbackTaskText?: string,
): string | undefined {
	if (messages) {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.role !== "user") continue
			if (isToolResultOnly(message.content)) continue
			const extracted = normalizeUserRequestText(textFromContent(message.content))
			if (extracted) return extracted
		}
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
	const withoutEnvironment = text.replace(ENVIRONMENT_DETAILS_RE, "").trim()
	const wrapped = withoutEnvironment.match(USER_MESSAGE_RE)
	return (wrapped ? wrapped[1] : withoutEnvironment).trim()
}
