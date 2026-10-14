import { describe, expect, it } from "vitest"

import { buildAgentTurnTelemetryProperties } from "../AgentTurnTelemetry"

describe("buildAgentTurnTelemetryProperties", () => {
	it("records response calls, batches, parallelism, duration, retries, and coercions", () => {
		const properties = buildAgentTurnTelemetryProperties(
			{
				items: [
					{ type: "text", text: "Inspecting" },
					{ type: "tool_call", id: "1", name: "read_file", arguments: {} },
					{ type: "error", message: "bad args", callId: "2", toolName: "list_files" },
				],
				text: "Inspecting",
				reasoning: "",
				toolCalls: [{ type: "tool_call", id: "1", name: "read_file", arguments: {} }],
			},
			{ batchSize: 2, parallelBatchCount: 1, parallelToolCount: 2, durationMs: 42 },
			3,
			0,
		)

		expect(properties).toEqual({
			toolCallCount: 1,
			malformedToolCallCount: 1,
			batchSize: 2,
			parallelBatchCount: 1,
			parallelToolCount: 2,
			executionDurationMs: 42,
			approvalRequestCount: 0,
			approvalDeniedCount: 0,
			approvalCancelledCount: 0,
			supersededAskCount: 0,
			completedToolResultCount: 0,
			outputTruncatedCount: 0,
			retries: 3,
			noToolCoercions: 0,
			toolCallNames: ["read_file", "list_files"],
		})
	})

	it("records a normal no-tool response without coercing it", () => {
		const properties = buildAgentTurnTelemetryProperties(
			{ items: [{ type: "text", text: "Done" }], text: "Done", reasoning: "", toolCalls: [] },
			{ batchSize: 0, parallelBatchCount: 0, durationMs: 0 },
			0,
		)

		expect(properties.toolCallCount).toBe(0)
		expect(properties.malformedToolCallCount).toBe(0)
		expect(properties.noToolCoercions).toBe(0)
		expect(properties.completedToolResultCount).toBe(0)
		expect(properties.outputTruncatedCount).toBe(0)
	})
})
