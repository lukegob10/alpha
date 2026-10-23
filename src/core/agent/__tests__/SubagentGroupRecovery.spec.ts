import type { SubagentGroupState, SubagentRunState } from "@alpha-code/types"

import { reconcileSubagentGroupAfterReload } from "../SubagentGroupRecovery"

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
