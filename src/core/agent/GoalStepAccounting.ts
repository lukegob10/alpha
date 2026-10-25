import type { AgentResponse } from "./AgentResponse"
import type { GoalController } from "./goals/GoalController"
import type { TaskGoalUsageReceipt } from "@alpha-code/types"

export interface GoalAccountingBinding {
	controller: GoalController
	goalId: string
	goalTaskId: string
	controlVersion: number
	requestGeneration: number
}

export interface GoalStepAccounting extends GoalAccountingBinding {
	eventId: string
	startedAt: number
	accountElapsed: boolean
	executionMode?: "code" | "architect"
	inputIncludesCache?: boolean
	responseAccounted?: boolean
	finished?: boolean
	usageReceipt?: TaskGoalUsageReceipt
	elapsedReceipt?: TaskGoalUsageReceipt
	elapsedChargedMs?: number
}

function counter(value: number | undefined): number {
	if (value === undefined) return 0
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid provider goal usage counter")
	return value
}

/** Existing API-protocol semantics determine whether provider input already includes cached input. */
export function goalResponseTokens(response: AgentResponse, inputIncludesCache = true): number {
	let total = 0
	for (const item of response.items) {
		if (item.type !== "usage") continue
		const input = counter(item.inputTokens)
		const cached = counter(item.cacheReadTokens)
		const created = counter(item.cacheWriteTokens)
		const billableInput = inputIncludesCache ? Math.max(0, input - cached) : input + created
		// Reasoning tokens are a subset of output tokens. Re-counting them would
		// make provider choice change a goal's budget semantics.
		total += billableInput + counter(item.outputTokens)
		if (!Number.isSafeInteger(total)) throw new Error("Goal usage exceeds the supported counter range")
	}
	return total
}

export async function accountGoalResponse(
	step: GoalStepAccounting | undefined,
	response: AgentResponse,
): Promise<void> {
	if (!step || step.executionMode === "architect" || step.responseAccounted) return
	step.usageReceipt ??= {
		goalTaskId: step.goalTaskId,
		goalId: step.goalId,
		eventId: `${step.eventId}:usage`,
		tokens: goalResponseTokens(response, step.inputIncludesCache),
		timeMs: step.accountElapsed
			? Math.max(0, Math.trunc(Date.now() - step.startedAt) - (step.elapsedChargedMs ?? 0))
			: 0,
	}
	await step.controller.recordUsage(
		step.usageReceipt.eventId,
		step.usageReceipt.tokens,
		step.usageReceipt.timeMs,
		step.goalId,
	)
	step.responseAccounted = true
	step.elapsedChargedMs = (step.elapsedChargedMs ?? 0) + step.usageReceipt.timeMs
}

/** The root owns elapsed work time; descendant steps contribute tokens only. */
export async function finishGoalStep(step: GoalStepAccounting | undefined, now = Date.now()): Promise<void> {
	if (!step || step.executionMode === "architect" || step.finished) return
	step.elapsedReceipt ??= {
		goalTaskId: step.goalTaskId,
		goalId: step.goalId,
		eventId: `${step.eventId}:elapsed`,
		tokens: 0,
		timeMs: step.accountElapsed ? Math.max(0, Math.trunc(now - step.startedAt) - (step.elapsedChargedMs ?? 0)) : 0,
	}
	await step.controller.recordUsage(step.elapsedReceipt.eventId, 0, step.elapsedReceipt.timeMs, step.goalId)
	step.finished = true
}
