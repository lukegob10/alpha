import type { GraderContext, GraderPlugin, GraderResult, UsagePolicyGraderSpec } from "../types"
import { evidenceFromText } from "../evidence"
import { validateTraceEvidence } from "../validation"

export class UsagePolicyGrader implements GraderPlugin<UsagePolicyGraderSpec> {
	readonly type = "usage-policy" as const

	async execute(
		spec: UsagePolicyGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		validateTraceEvidence(context.trace)
		const modelCalls = context.trace.filter(({ type }) => type === "agent.turn.model_request_started").length
		const startedCalls = context.trace.filter(
			({ type }) => type === "agent.turn.tool_call" || type === "agent.turn.verification_started",
		).length
		let observedResults = 0
		const unannotatedResults = new Map<string, number>()
		for (const { type, payload } of context.trace) {
			const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined
			if (type === "agent.turn.tool_result") {
				observedResults++
				if (typeof record?.name === "string" && record.name.length > 0)
					unannotatedResults.set(record.name, (unannotatedResults.get(record.name) ?? 0) + 1)
			} else if (type === "agent.turn.verification_result") {
				// Canonical scheduler annotations only deduplicate an observed result for the same tool.
				// Legacy provider-history projections use this event as the command's sole receipt.
				const name = typeof record?.toolName === "string" ? record.toolName : undefined
				const prior = name === undefined ? 0 : (unannotatedResults.get(name) ?? 0)
				if (name !== undefined && prior > 0) unannotatedResults.set(name, prior - 1)
				else observedResults++
			}
		}
		const toolCalls = Math.max(startedCalls, observedResults)
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
			evidence: [
				evidenceFromText(
					`${spec.id}:usage`,
					"report",
					JSON.stringify({ modelCalls, toolCalls, costUsd }),
					"application/json",
				),
			],
		}
	}
}

function readCost(usage: unknown): number {
	if (!usage || typeof usage !== "object") throw new Error("Missing grader cost evidence")
	const value = (usage as Record<string, unknown>).costUsd ?? (usage as Record<string, unknown>).totalCost
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		throw new Error("Missing or invalid grader cost evidence")
	return value
}
