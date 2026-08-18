import type { SubagentGroupState } from "@alpha-code/types"

import { Task } from "../Task"

const makeGroup = ({
	groupId,
	executionMode,
	groupStatus = "completed",
	agentStatus = "completed",
	summary,
}: {
	groupId: string
	executionMode?: "blocking" | "async"
	groupStatus?: SubagentGroupState["status"]
	agentStatus?: SubagentGroupState["agents"][number]["status"]
	summary: string
}): SubagentGroupState => ({
	groupId,
	parentTaskId: "parent-1",
	executionMode,
	status: groupStatus,
	createdAt: 1,
	completedAt: groupStatus === "completed" ? 2 : undefined,
	agents: [
		{
			taskId: `${groupId}-child`,
			nickname: "Ada",
			role: "explore",
			objective: "Inspect the parser",
			status: agentStatus,
			summary,
			completedAt: 2,
			usage: { durationMs: 1 },
		},
	],
})

const makeTask = (groups: SubagentGroupState[]) => {
	const saveClineMessages = vi.fn(async () => true)
	const task = Object.assign(Object.create(Task.prototype), {
		taskKind: "primary",
		clineMessages: groups.map((subagentGroup) => ({
			ts: subagentGroup.createdAt,
			type: "say",
			say: "subagent_group",
			subagentGroup,
		})),
		saveClineMessages,
	}) as Task

	return { task, saveClineMessages }
}

describe("Task asynchronous sub-agent result delivery", () => {
	it("delivers only async terminal reports and persists exactly-once state", async () => {
		const asyncGroup = makeGroup({
			groupId: "async-group",
			executionMode: "async",
			summary: "Parser inspection complete.",
		})
		const blockingGroup = makeGroup({
			groupId: "blocking-group",
			executionMode: "blocking",
			summary: "Already returned by delegate_task.",
		})
		const legacyGroup = makeGroup({
			groupId: "legacy-group",
			summary: "Legacy blocking result.",
		})
		const { task, saveClineMessages } = makeTask([asyncGroup, blockingGroup, legacyGroup])
		asyncGroup.agents[0].usage = {
			durationMs: 21_000,
			rateLimitWaitCount: 2,
			rateLimitWaitMs: 20_000,
			rateLimitIntervalSeconds: 10,
		}

		const pending = (task as any).getPendingSpawnedSubagentResults()

		expect(pending).toHaveLength(1)
		expect(pending[0].taskId).toBe("async-group-child")
		expect(pending[0].block.text).toContain("Parser inspection complete.")
		expect(pending[0].block.text).toContain('"rateLimitWaitCount": 2')
		expect(pending[0].block.text).not.toContain("Already returned by delegate_task.")
		expect(task.hasUndeliveredSpawnedSubagentResults()).toBe(true)

		await (task as any).markSpawnedSubagentResultsDelivered([pending[0].taskId])

		expect(asyncGroup.agents[0].resultDeliveredAt).toEqual(expect.any(Number))
		expect(saveClineMessages).toHaveBeenCalledOnce()
		expect((task as any).getPendingSpawnedSubagentResults()).toEqual([])
		expect(task.hasUndeliveredSpawnedSubagentResults()).toBe(false)
	})

	it("waits for the aggregate terminal write before exposing a child report", () => {
		const group = makeGroup({
			groupId: "racing-group",
			executionMode: "async",
			groupStatus: "running",
			summary: "Child finished before the group write.",
		})
		const { task } = makeTask([group])

		expect((task as any).getPendingSpawnedSubagentResults()).toEqual([])

		group.status = "completed"
		group.completedAt = 3

		expect((task as any).getPendingSpawnedSubagentResults()).toHaveLength(1)
	})

	it("places the terminal report in the next model-facing user content", () => {
		const group = makeGroup({
			groupId: "injected-group",
			executionMode: "async",
			summary: "Use the confirmed backend finding.",
		})
		const { task } = makeTask([group])

		const result = (task as any).buildUserContentWithPendingSpawnedSubagentResults(
			[{ type: "text", text: "Parent tool result" }],
			"<environment_details>current state</environment_details>",
		)

		expect(result.pendingResults.map(({ taskId }: { taskId: string }) => taskId)).toEqual(["injected-group-child"])
		expect(result.content).toEqual([
			{ type: "text", text: "Parent tool result" },
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("Use the confirmed backend finding."),
			}),
			{ type: "text", text: "<environment_details>current state</environment_details>" },
		])
	})
})
