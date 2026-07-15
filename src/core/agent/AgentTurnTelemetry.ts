import type { AgentResponse } from "./AgentResponse"

export interface AgentTurnTelemetryMetrics {
	batchSize: number
	parallelBatchCount: number
	parallelToolCount?: number
	durationMs: number
	approvalRequestCount?: number
	approvalDeniedCount?: number
	approvalCancelledCount?: number
	supersededAskCount?: number
	completedToolResultCount?: number
	outputTruncatedCount?: number
}

export interface AgentTurnTelemetryProperties {
	toolCallCount: number
	batchSize: number
	parallelBatchCount: number
	parallelToolCount: number
	executionDurationMs: number
	approvalRequestCount: number
	approvalDeniedCount: number
	approvalCancelledCount: number
	supersededAskCount: number
	completedToolResultCount: number
	outputTruncatedCount: number
	retries: number
	noToolCoercions: number
	toolCallNames: string[]
}

export function buildAgentTurnTelemetryProperties(
	response: AgentResponse,
	metrics: AgentTurnTelemetryMetrics,
	retries: number,
	noToolCoercions = 0,
): AgentTurnTelemetryProperties {
	const toolCallNames = response.items.flatMap((item) => {
		if (item.type === "tool_call") {
			return [item.name]
		}
		if (item.type === "error" && item.toolName) {
			return [item.toolName]
		}
		return []
	})

	return {
		toolCallCount: metrics.batchSize,
		batchSize: metrics.batchSize,
		parallelBatchCount: metrics.parallelBatchCount,
		parallelToolCount: metrics.parallelToolCount ?? 0,
		executionDurationMs: metrics.durationMs,
		approvalRequestCount: metrics.approvalRequestCount ?? 0,
		approvalDeniedCount: metrics.approvalDeniedCount ?? 0,
		approvalCancelledCount: metrics.approvalCancelledCount ?? 0,
		supersededAskCount: metrics.supersededAskCount ?? 0,
		completedToolResultCount: metrics.completedToolResultCount ?? 0,
		outputTruncatedCount: metrics.outputTruncatedCount ?? 0,
		retries,
		noToolCoercions,
		toolCallNames,
	}
}
