import {
	subagentGroupStateSchema,
	subagentLifecycleEventSchema,
	subagentSpawnHandleSchema,
	toolNamesSchema,
} from "../index.js"

const makeRun = (overrides: Record<string, unknown> = {}) => ({
	taskId: "child-1",
	nickname: "Ada",
	role: "explore",
	objective: "Map the relevant implementation.",
	status: "running",
	phase: "working",
	startedAt: 20,
	usage: { durationMs: 5 },
	...overrides,
})

const makeEvent = (type: "started" | "status" | "completed", snapshot: Record<string, unknown>) => ({
	eventId: `event-${type}`,
	sequence: 1,
	runId: "child-1:1",
	type,
	taskId: "child-1",
	groupId: "group-1",
	parentTaskId: "parent-1",
	occurredAt: 25,
	snapshot,
})

describe("asynchronous sub-agent contracts", () => {
	it("accepts a stable, nonterminal spawn handle", () => {
		expect(
			subagentSpawnHandleSchema.safeParse({
				taskId: "child-1",
				runId: "child-1:1",
				groupId: "group-1",
				parentTaskId: "parent-1",
				path: "/root/ada",
				nickname: "Ada",
				role: "explore",
				status: "pending",
				createdAt: 10,
			}).success,
		).toBe(true)
	})

	it("rejects a completed run masquerading as a spawn handle", () => {
		const result = subagentSpawnHandleSchema.safeParse({
			taskId: "child-1",
			runId: "child-1:1",
			groupId: "group-1",
			parentTaskId: "parent-1",
			path: "/root/ada",
			nickname: "Ada",
			role: "explore",
			status: "completed",
			createdAt: 10,
		})

		expect(result.success).toBe(false)
	})

	it.each([
		makeEvent("started", makeRun()),
		makeEvent("status", makeRun({ status: "cancelling", phase: "waiting" })),
		makeEvent(
			"completed",
			makeRun({
				status: "completed",
				phase: undefined,
				summary: "Mapped the implementation.",
				completedAt: 30,
			}),
		),
	])("accepts a $type lifecycle snapshot", (event) => {
		expect(subagentLifecycleEventSchema.safeParse(event).success).toBe(true)
	})

	it("keeps active and terminal notifications distinct", () => {
		const terminalStatusEvent = makeEvent(
			"status",
			makeRun({ status: "failed", error: "Runner failed", completedAt: 30 }),
		)
		const activeCompletionEvent = makeEvent("completed", makeRun({ status: "running", completedAt: 30 }))

		expect(subagentLifecycleEventSchema.safeParse(terminalStatusEvent).success).toBe(false)
		expect(subagentLifecycleEventSchema.safeParse(activeCompletionEvent).success).toBe(false)
	})

	it("rejects a lifecycle envelope for a different snapshot task", () => {
		const result = subagentLifecycleEventSchema.safeParse(
			makeEvent("started", makeRun({ taskId: "different-child" })),
		)

		expect(result.success).toBe(false)
	})

	it("continues to parse the persisted bounded group shape", () => {
		const legacyGroup = {
			groupId: "group-1",
			parentTaskId: "parent-1",
			toolCallId: "call-1",
			status: "running",
			createdAt: 10,
			startedAt: 20,
			agents: [makeRun()],
		}

		expect(subagentGroupStateSchema.safeParse(legacyGroup).success).toBe(true)
	})

	it("persists asynchronous parent-result delivery metadata", () => {
		const group = subagentGroupStateSchema.parse({
			groupId: "group-1",
			parentTaskId: "parent-1",
			executionMode: "async",
			status: "completed",
			createdAt: 10,
			completedAt: 30,
			agents: [
				makeRun({
					status: "completed",
					phase: undefined,
					summary: "Mapped the implementation.",
					completedAt: 30,
					resultDeliveredAt: 35,
				}),
			],
		})

		expect(group.executionMode).toBe("async")
		expect(group.agents[0]?.resultDeliveredAt).toBe(35)
	})

	it("persists compact configured pacing metrics with a run", () => {
		const group = subagentGroupStateSchema.parse({
			groupId: "group-1",
			parentTaskId: "parent-1",
			status: "completed",
			createdAt: 10,
			completedAt: 30,
			agents: [
				makeRun({
					status: "completed",
					phase: undefined,
					completedAt: 30,
					usage: {
						durationMs: 20_000,
						rateLimitWaitCount: 2,
						rateLimitWaitMs: 20_000,
						rateLimitIntervalSeconds: 10,
					},
				}),
			],
		})

		expect(group.agents[0]?.usage.rateLimitWaitCount).toBe(2)
	})

	it("publishes spawn_agent as a tool name without removing delegate_task", () => {
		expect(toolNamesSchema.safeParse("spawn_agent").success).toBe(true)
		expect(toolNamesSchema.safeParse("delegate_task").success).toBe(true)
	})
})
