import { createHash } from "node:crypto"

import { MAX_DESIGN_HANDOFF_CHARS, type TaskDesignHandoff } from "@alpha-code/types"

import { parseProposedPlan } from "../../shared/plan-mode"

export function createDesignHandoff(text: string, taskId: string): TaskDesignHandoff | undefined {
	const plan = parseProposedPlan(text)
	if (!plan?.complete || plan.content.length > MAX_DESIGN_HANDOFF_CHARS) return undefined
	const heading = plan.content.match(/^#{1,6}\s+(.+?)(?:\s+#+)?(?:\r?\n|$)/)?.[1]?.trim()
	return {
		...(heading ? { title: heading.slice(0, 500) } : {}),
		markdown: plan.content,
		sourceTaskId: taskId,
		digest: createHash("sha256").update(plan.content).digest("hex"),
		updatedAt: Date.now(),
	}
}
