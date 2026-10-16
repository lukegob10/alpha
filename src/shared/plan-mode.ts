export const PROPOSED_PLAN_OPEN_TAG = "<proposed_plan>"
export const PROPOSED_PLAN_CLOSE_TAG = "</proposed_plan>"

export interface PlanModeCommand {
	prompt: string
	rewrittenText: string
}

export interface ProposedPlan {
	content: string
	complete: boolean
}

const USER_MESSAGE_OPEN_TAG = "<user_message>"
const USER_MESSAGE_CLOSE_TAG = "</user_message>"

/**
 * Parse the built-in `/plan` command without claiming similarly named workspace
 * commands. The command is recognized only at the beginning of the complete
 * user message and may carry an inline, multi-line prompt.
 */
export function parsePlanModeCommand(text: string): PlanModeCommand | undefined {
	const trimmed = text.trim()
	const hasUserMessageWrapper = trimmed.startsWith(USER_MESSAGE_OPEN_TAG) && trimmed.endsWith(USER_MESSAGE_CLOSE_TAG)
	const commandText = hasUserMessageWrapper
		? trimmed.slice(USER_MESSAGE_OPEN_TAG.length, -USER_MESSAGE_CLOSE_TAG.length).trim()
		: trimmed

	const match = commandText.match(/^\/plan(?:\s+([\s\S]*))?$/i)
	if (!match) return undefined

	const prompt = (match[1] ?? "").trim()
	return {
		prompt,
		rewrittenText: hasUserMessageWrapper
			? `${USER_MESSAGE_OPEN_TAG}\n${prompt}\n${USER_MESSAGE_CLOSE_TAG}`
			: prompt,
	}
}

/** Parse an exact Plan-mode handoff block, with optional support for streaming content. */
export function parseProposedPlan(text: string, allowIncomplete = false): ProposedPlan | undefined {
	const trimmed = text.trim()
	if (!trimmed.startsWith(PROPOSED_PLAN_OPEN_TAG)) return undefined

	const afterOpen = trimmed.slice(PROPOSED_PLAN_OPEN_TAG.length)
	if (afterOpen.endsWith(PROPOSED_PLAN_CLOSE_TAG)) {
		const content = afterOpen.slice(0, -PROPOSED_PLAN_CLOSE_TAG.length).trim()
		if (!content || content.includes(PROPOSED_PLAN_OPEN_TAG) || content.includes(PROPOSED_PLAN_CLOSE_TAG)) {
			return undefined
		}
		return { content, complete: true }
	}

	if (!allowIncomplete || afterOpen.includes(PROPOSED_PLAN_OPEN_TAG) || afterOpen.includes(PROPOSED_PLAN_CLOSE_TAG)) {
		return undefined
	}
	return { content: afterOpen.trim(), complete: false }
}

export function hasCompleteProposedPlan(text: string): boolean {
	return parseProposedPlan(text)?.complete === true
}

/**
 * Normalize only an explicit complete Plan handoff. Conversational responses and
 * malformed wrappers retain their original text rather than becoming a plan.
 */
export function ensureProposedPlanBlock(text: string): string {
	const plan = parseProposedPlan(text)
	return plan ? `${PROPOSED_PLAN_OPEN_TAG}\n${plan.content}\n${PROPOSED_PLAN_CLOSE_TAG}` : text
}
