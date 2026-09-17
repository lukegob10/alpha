import {
	agentApprovalIdSchema,
	agentEventIdSchema,
	agentLifecycleAssistantReasoningItemSchema,
	agentLifecycleEventSchema,
	agentLifecycleItemSchema,
	agentLifecycleProgressItemSchema,
	agentLifecycleSnapshotSchema,
	agentLifecycleToolCallItemSchema,
	agentLifecycleToolResultItemSchema,
	agentRunIdSchema,
	agentStepIdSchema,
	agentTaskIdSchema,
	agentTurnIdSchema,
	agentTurnStatusSchema,
	agentLifecyclePhaseSchema,
} from "../index.js"

describe("agent lifecycle contracts", () => {
	it("validates all opaque lifecycle identifiers without imposing provider formats", () => {
		for (const schema of [
			agentTaskIdSchema,
			agentRunIdSchema,
			agentTurnIdSchema,
			agentStepIdSchema,
			agentEventIdSchema,
			agentApprovalIdSchema,
		]) {
			expect(schema.safeParse("provider/native-id_1").success).toBe(true)
			expect(schema.safeParse("").success).toBe(false)
			expect(schema.safeParse("   ").success).toBe(false)
		}
	})

	it("keeps turn statuses and phases provider-neutral", () => {
		expect(agentTurnStatusSchema.options).toEqual(["in_progress", "completed", "interrupted", "failed"])
		expect(agentLifecyclePhaseSchema.safeParse("executing").success).toBe(true)
		expect(agentLifecyclePhaseSchema.safeParse("provider_internal_state").success).toBe(false)
	})

	it("accepts normalized assistant reasoning but rejects provider payloads", () => {
		expect(
			agentLifecycleAssistantReasoningItemSchema.safeParse({
				itemId: "item-reasoning",
				type: "assistant_reasoning",
				text: "I will inspect the repository.",
			}).success,
		).toBe(true)

		expect(
			agentLifecycleAssistantReasoningItemSchema.safeParse({
				itemId: "item-reasoning",
				type: "assistant_reasoning",
				text: "normalized",
				providerPayload: { signature: "must-not-persist" },
			}).success,
		).toBe(false)
	})

	it("discriminates tool calls, results, progress, and every other item kind", () => {
		const items = [
			{ itemId: "user-1", type: "user", text: "Inspect this" },
			{ itemId: "assistant-1", type: "assistant_text", text: "I will inspect it." },
			{ itemId: "reasoning-1", type: "assistant_reasoning", text: "Plan" },
			{
				itemId: "call-item-1",
				type: "tool_call",
				toolCallId: "call-1",
				name: "read_file",
				arguments: { path: "README.md" },
			},
			{
				itemId: "result-item-1",
				type: "tool_result",
				toolCallId: "call-1",
				status: "completed",
				output: "contents",
			},
			{ itemId: "approval-1", type: "approval", approvalId: "approval-1", status: "requested" },
			{ itemId: "usage-1", type: "usage", inputTokens: 3, outputTokens: 4 },
			{ itemId: "error-1", type: "error", message: "A normalized error" },
			{ itemId: "compaction-1", type: "compaction", status: "completed" },
			{ itemId: "progress-1", type: "progress", message: "Working" },
		] as const

		for (const item of items) expect(agentLifecycleItemSchema.safeParse(item).success).toBe(true)
		expect(agentLifecycleToolCallItemSchema.safeParse(items[3]).success).toBe(true)
		expect(agentLifecycleToolResultItemSchema.safeParse(items[4]).success).toBe(true)
		expect(
			agentLifecycleItemSchema.safeParse({
				itemId: "missing-output",
				type: "tool_result",
				toolCallId: "call-1",
				status: "completed",
			}).success,
		).toBe(false)
		expect(agentLifecycleItemSchema.safeParse({ itemId: "missing-progress", type: "progress" }).success).toBe(false)
		expect(agentLifecycleProgressItemSchema.safeParse({ itemId: "progress", type: "progress" }).success).toBe(false)
	})

	it("requires a versioned, correlated event envelope shape", () => {
		const event = {
			version: 1,
			eventId: "event-1",
			sequence: 1,
			taskId: "task-1",
			runId: "run-1",
			turnId: "turn-1",
			occurredAt: 100,
			correlationId: "run-1",
			causationId: "event-0",
			type: "phase_changed",
			payload: { phase: "planning" },
		}

		expect(agentLifecycleEventSchema.safeParse(event).success).toBe(true)
		expect(agentLifecycleEventSchema.safeParse({ ...event, version: 2 }).success).toBe(false)
		expect(agentLifecycleEventSchema.safeParse({ ...event, sequence: 1.5 }).success).toBe(false)
		expect(agentLifecycleEventSchema.safeParse({ ...event, payload: { phase: "provider_phase" } }).success).toBe(
			false,
		)
	})

	it("validates snapshot receipt continuity and terminal metadata", () => {
		const base = {
			version: 1,
			taskId: "task-1",
			runId: "run-1",
			turnId: "turn-1",
			status: "in_progress",
			phase: "queued",
			lastSequence: 0,
			items: [],
			steps: [],
			acceptedToolCallIds: [],
			terminalToolCallIds: [],
			processedEvents: [],
		} as const

		expect(agentLifecycleSnapshotSchema.safeParse(base).success).toBe(true)
		expect(
			agentLifecycleSnapshotSchema.safeParse({
				...base,
				status: "completed",
				terminalEventId: "event-1",
				terminalAt: 100,
				lastSequence: 1,
				processedEvents: [{ eventId: "event-1", sequence: 1, fingerprint: "digest" }],
			}).success,
		).toBe(true)
		expect(
			agentLifecycleSnapshotSchema.safeParse({
				...base,
				status: "completed",
				lastSequence: 1,
				processedEvents: [{ eventId: "event-1", sequence: 1, fingerprint: "digest" }],
			}).success,
		).toBe(false)
	})
})
