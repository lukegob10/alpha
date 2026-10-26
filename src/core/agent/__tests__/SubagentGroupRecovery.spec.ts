import type { SubagentGroupState, SubagentRunState } from "@alpha-code/types"

import { aggregateSubagentGroupTerminalStatus, reconcileSubagentGroupAfterReload } from "../SubagentGroupRecovery"

const createAgent = (taskId: string, overrides: Partial<SubagentRunState> = {}): SubagentRunState => ({
	taskId,
	nickname: taskId,
	role: "review",
	objective: "Review task recovery",
	status: "completed",
	summary: `Findings from ${taskId}`,
	stopReason: "completed",
	startedAt: 2,
	completedAt: 5,
	usage: { durationMs: 3 },
	...overrides,
})

const createGroup = (overrides: Partial<SubagentGroupState> = {}): SubagentGroupState => ({
	groupId: "group",
	parentTaskId: "parent",
	executionMode: "blocking",
	status: "running",
	createdAt: 1,
	startedAt: 2,
	agents: [createAgent("first"), createAgent("second")],
	...overrides,
})

describe("reconcileSubagentGroupAfterReload", () => {
	it.each(["pending", "running", "cancelling"] as const)(
		"preserves completed child outcomes when the %s aggregate was not committed before reload",
		(status) => {
			const group = createGroup({ status })
			const agents = structuredClone(group.agents)
			const getStopReason = vi.fn()

			expect(reconcileSubagentGroupAfterReload(group, 10, getStopReason)).toBe(true)

			expect(group.status).toBe("completed")
			expect(group.completedAt).toBe(10)
			expect(group.agents).toEqual(agents)
			expect(getStopReason).not.toHaveBeenCalled()
			const recovered = structuredClone(group)
			expect(reconcileSubagentGroupAfterReload(group, 20, getStopReason)).toBe(false)
			expect(group).toEqual(recovered)
		},
	)

	it("recovers a legacy completed group without an execution-mode marker", () => {
		const group = createGroup({ executionMode: undefined, startedAt: undefined, completedAt: 8 })

		expect(reconcileSubagentGroupAfterReload(group, 10)).toBe(true)

		expect(group.status).toBe("completed")
		expect(group.completedAt).toBe(8)
	})

	it.each<{
		name: string
		executionMode?: SubagentGroupState["executionMode"]
		statuses: SubagentRunState["status"][]
		expected: SubagentGroupState["status"]
	}>([
		{ name: "failed", executionMode: "blocking", statuses: ["failed", "failed"], expected: "failed" },
		{ name: "cancelled", executionMode: "blocking", statuses: ["cancelled", "cancelled"], expected: "cancelled" },
		{ name: "timed out", executionMode: "blocking", statuses: ["timed_out", "timed_out"], expected: "timed_out" },
		{ name: "mixed failures", executionMode: "blocking", statuses: ["failed", "cancelled"], expected: "failed" },
		{ name: "blocked", executionMode: "blocking", statuses: ["blocked"], expected: "failed" },
		{ name: "interrupted blocking", executionMode: "blocking", statuses: ["interrupted"], expected: "failed" },
		{ name: "legacy failure", statuses: ["failed"], expected: "failed" },
		{ name: "partial failure", executionMode: "blocking", statuses: ["completed", "failed"], expected: "partial" },
		{
			name: "partial cancellation",
			executionMode: "blocking",
			statuses: ["completed", "cancelled"],
			expected: "partial",
		},
		{
			name: "partial timeout",
			executionMode: "blocking",
			statuses: ["completed", "timed_out"],
			expected: "partial",
		},
		{ name: "async failure", executionMode: "async", statuses: ["failed"], expected: "failed" },
		{ name: "async blocked", executionMode: "async", statuses: ["blocked"], expected: "failed" },
		{ name: "async cancellation", executionMode: "async", statuses: ["cancelled"], expected: "cancelled" },
		{ name: "async timeout", executionMode: "async", statuses: ["timed_out"], expected: "timed_out" },
		{ name: "async interruption", executionMode: "async", statuses: ["interrupted"], expected: "interrupted" },
	])(
		"recovers a durable $name aggregate without changing terminal children",
		({ executionMode, statuses, expected }) => {
			const group = createGroup({
				executionMode,
				completedAt: 8,
				agents: statuses.map((status, index) =>
					createAgent(`child-${index}`, { status, stopReason: undefined }),
				),
			})
			const agents = structuredClone(group.agents)
			const getStopReason = vi.fn()

			expect(reconcileSubagentGroupAfterReload(group, 10, getStopReason)).toBe(true)

			expect(group.status).toBe(expected)
			expect(group.completedAt).toBe(8)
			expect(group.agents).toEqual(agents)
			expect(getStopReason).not.toHaveBeenCalled()
			const recovered = structuredClone(group)
			expect(reconcileSubagentGroupAfterReload(group, 20, getStopReason)).toBe(false)
			expect(group).toEqual(recovered)
		},
	)

	it("preserves an asynchronous denial after its presentation status was normalized to failed", () => {
		const group = createGroup({
			executionMode: "async",
			agents: [createAgent("denied", { status: "failed", stopReason: "authority_denied" })],
		})
		const agents = structuredClone(group.agents)

		expect(reconcileSubagentGroupAfterReload(group, 10)).toBe(true)
		expect(group.status).toBe("cancelled")
		expect(group.agents).toEqual(agents)
	})

	it("retains interruption recovery when a child did not finish", () => {
		const finished = createAgent("finished")
		const persistedFinished = structuredClone(finished)
		const unfinished = createAgent("unfinished", {
			status: "running",
			summary: undefined,
			stopReason: undefined,
			completedAt: undefined,
			phase: "working",
			phaseStartedAt: 3,
		})
		const group = createGroup({ agents: [finished, unfinished] })

		expect(reconcileSubagentGroupAfterReload(group, 10, () => "orphaned")).toBe(true)

		expect(group.status).toBe("interrupted")
		expect(group.agents[0]).toEqual(persistedFinished)
		expect(group.agents[1]).toMatchObject({ status: "interrupted", stopReason: "orphaned", completedAt: 10 })
		expect(group.agents[1].phase).toBeUndefined()
		expect(group.agents[1].phaseStartedAt).toBeUndefined()
	})

	it("retains cancellation recovery for prepared children that never launched", () => {
		const group = createGroup({
			status: "pending",
			executionMode: undefined,
			startedAt: undefined,
			agents: [
				createAgent("unlaunched", {
					status: "pending",
					summary: undefined,
					stopReason: undefined,
					startedAt: undefined,
					completedAt: undefined,
				}),
			],
		})

		expect(reconcileSubagentGroupAfterReload(group, 10)).toBe(true)

		expect(group.status).toBe("cancelled")
		expect(group.agents[0]).toMatchObject({ status: "cancelled", stopReason: "never_launched" })
	})

	it("leaves an already-terminal group unchanged", () => {
		const group = createGroup({ status: "completed", completedAt: 6 })
		const persisted = structuredClone(group)

		expect(reconcileSubagentGroupAfterReload(group, 10)).toBe(false)
		expect(group).toEqual(persisted)
	})
})

describe("aggregateSubagentGroupTerminalStatus", () => {
	it.each([
		["async", "cancelled"],
		["blocking", "failed"],
	] as const)("retains the %s denial outcome used by live finalization", (executionMode, expected) => {
		expect(aggregateSubagentGroupTerminalStatus([{ status: "denied" }], executionMode)).toBe(expected)
	})

	it("rejects an active group rather than inventing a terminal aggregate", () => {
		expect(() => aggregateSubagentGroupTerminalStatus([{ status: "running" }])).toThrow("active sub-agent")
	})
})
