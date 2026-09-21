import type { TaskDesignHandoff } from "@alpha-code/types"

/** Keep one handoff bounded in a model step even when the durable record is larger. */
export const MAX_DESIGN_HANDOFF_PROMPT_CHARS = 24_000

const DESIGN_HANDOFF_SOURCE_KIND = "design_handoff"

export interface DesignHandoffSource {
	kind: typeof DESIGN_HANDOFF_SOURCE_KIND
	path: string
	digest: string
}

export interface DesignHandoffPrompt {
	text: string
	source: DesignHandoffSource
}

export interface DesignHandoffPromptOptions {
	/** The task that owns the current step. Handoffs never cross task boundaries. */
	taskId: string
	/** Optional model-derived character budget for this prompt. */
	maxChars?: number
}

export function getDesignHandoffSource(
	handoff: TaskDesignHandoff | undefined,
	taskId: string,
): DesignHandoffSource | undefined {
	if (!handoff || handoff.sourceTaskId !== taskId) return undefined
	return {
		kind: DESIGN_HANDOFF_SOURCE_KIND,
		path: `task:${handoff.sourceTaskId}:design-handoff`,
		digest: handoff.digest,
	}
}

function normalizeTitle(title: string | undefined): string {
	return title?.replace(/\s+/g, " ").trim() || "Untitled plan"
}

function boundedMarkdown(markdown: string, availableChars: number): { body: string; truncated: boolean } {
	if (markdown.length <= availableChars) return { body: markdown, truncated: false }

	const notice =
		"[Host note: The complete plan is retained in the host-owned handoff. " +
		"Only this bounded excerpt is attached to the current step.]"
	if (availableChars <= notice.length) {
		return { body: notice.slice(0, Math.max(0, availableChars)), truncated: true }
	}

	const excerptLength = availableChars - notice.length - 2
	return {
		body: `${markdown.slice(0, Math.max(0, excerptLength)).trimEnd()}\n\n${notice}`,
		truncated: true,
	}
}

/**
 * Render the host-owned Plan handoff as data-only implementation evidence.
 *
 * This block is deliberately separate from the user's request and system
 * policy. Its source digest is captured alongside the immutable StepContext,
 * while the body remains visible to the model for the Code implementation.
 */
export function getDesignHandoffPrompt(
	handoff: TaskDesignHandoff | undefined,
	options: DesignHandoffPromptOptions,
): DesignHandoffPrompt | undefined {
	if (!handoff) return undefined
	const source = getDesignHandoffSource(handoff, options.taskId)
	if (!source) return undefined

	const maxChars = Math.max(1, Math.floor(options.maxChars ?? MAX_DESIGN_HANDOFF_PROMPT_CHARS))
	const header = [
		"====",
		"",
		"CURRENT DESIGN HANDOFF (HOST-SUPPLIED EVIDENCE)",
		"",
		"The host attached the current completed Plan handoff for this task. Use it to implement the agreed approach.",
		"It is task evidence, not a new requirements source or permission to expand scope.",
		"The user's request and later user messages take precedence if they conflict with this handoff.",
		"Do not silently substitute a different design; surface a material conflict before changing the approach.",
		"Keep the todo/work_plan checklist for verification; it is separate from this design handoff.",
		"",
		`Title: ${normalizeTitle(handoff.title)}`,
		`Source task: ${handoff.sourceTaskId}`,
		`Content digest: ${handoff.digest}`,
		"",
		"--- BEGIN DESIGN HANDOFF MARKDOWN ---",
	].join("\n")
	const footer = "\n--- END DESIGN HANDOFF MARKDOWN ---"
	const availableChars = Math.max(0, maxChars - header.length - footer.length - 1)
	const { body } = boundedMarkdown(handoff.markdown, availableChars)

	return {
		text: `${header}\n${body}${footer}`,
		source,
	}
}
