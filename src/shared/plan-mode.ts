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
 * Normalize a provider's terminal Plan response to the stable UI/protocol
 * boundary. Prompting remains responsible for plan quality; the host owns the
 * exact outer contract so providers cannot accidentally leak the tags as prose.
 */
export function ensureProposedPlanBlock(text: string): string {
	const exactPlan = parseProposedPlan(text)
	if (exactPlan) {
		return `${PROPOSED_PLAN_OPEN_TAG}\n${exactPlan.content}\n${PROPOSED_PLAN_CLOSE_TAG}`
	}

	const trimmed = text.trim()
	const openIndex = trimmed.indexOf(PROPOSED_PLAN_OPEN_TAG)
	const closeIndex =
		openIndex >= 0 ? trimmed.indexOf(PROPOSED_PLAN_CLOSE_TAG, openIndex + PROPOSED_PLAN_OPEN_TAG.length) : -1
	let content =
		openIndex >= 0 && closeIndex >= 0
			? trimmed.slice(openIndex + PROPOSED_PLAN_OPEN_TAG.length, closeIndex)
			: trimmed

	// Providers occasionally echo the wrapper or add a preamble. The host owns
	// this protocol boundary, so retain the first complete plan body and remove
	// any nested/stray wrappers before rendering or persistence.
	content = content.split(PROPOSED_PLAN_OPEN_TAG).join("").split(PROPOSED_PLAN_CLOSE_TAG).join("").trim()

	if (!content) {
		content = "# Plan\n\nNo implementation plan was provided."
	}

	return `${PROPOSED_PLAN_OPEN_TAG}\n${content}\n${PROPOSED_PLAN_CLOSE_TAG}`
}
