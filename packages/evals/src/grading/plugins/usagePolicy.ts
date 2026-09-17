import type { GraderContext, GraderPlugin, GraderResult, UsagePolicyGraderSpec } from "../types"

export class UsagePolicyGrader implements GraderPlugin<UsagePolicyGraderSpec> {
	readonly type = "usage-policy" as const

	async execute(
		spec: UsagePolicyGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		const modelCalls = context.trace.filter(({ type }) => type === "agent.turn.model_request_started").length
		const toolCalls = context.trace.filter(({ type }) => type === "agent.turn.tool_result").length
		const costUsd = readCost(context.usage)
		const diagnostics: GraderResult["diagnostics"] = []
		if (modelCalls > spec.maxModelCalls)
			diagnostics.push({
				code: "model_call_budget_exceeded",
				message: `${modelCalls} exceeds ${spec.maxModelCalls}`,
				severity: "error",
			})
		if (toolCalls > spec.maxToolCalls)
			diagnostics.push({
				code: "tool_call_budget_exceeded",
				message: `${toolCalls} exceeds ${spec.maxToolCalls}`,
				severity: "error",
			})
		if (costUsd > spec.maxCostUsd)
			diagnostics.push({
				code: "cost_budget_exceeded",
				message: `${costUsd} exceeds ${spec.maxCostUsd}`,
				severity: "error",
			})
		return {
			graderId: spec.id,
			graderVersion: spec.version,
			type: spec.type,
			status: diagnostics.length ? "failed" : "passed",
			hardGate: spec.hardGate,
			failureClass: spec.failureClass,
			diagnostics,
			evidence: [],
		}
	}
}

function readCost(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0
	const value = (usage as Record<string, unknown>).costUsd ?? (usage as Record<string, unknown>).totalCost
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}
