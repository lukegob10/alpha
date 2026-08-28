import type { SubagentGroupState } from "@alpha-code/types"

import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
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
	it("keeps primary lifecycle exposure stable across idle, activity, and transcript reload", () => {
		const idle = makeTask([]).task
		const active = makeTask([
			makeGroup({
				groupId: "managed-group",
				executionMode: "async",
				summary: "Managed result.",
			}),
		]).task

		expect((idle as any).shouldExposeAgentLifecycleTools()).toBe(true)
		expect((active as any).shouldExposeAgentLifecycleTools()).toBe(true)

		active.clineMessages = []
		expect((active as any).shouldExposeAgentLifecycleTools()).toBe(true)

		Object.assign(active, { taskKind: "subagent" })
		expect((active as any).shouldExposeAgentLifecycleTools()).toBe(false)
	})

	it("omits idle lifecycle controls when the durable store confirms there are no managed agents", () => {
		const idle = makeTask([]).task
		Object.assign(idle, {
			providerRef: {
				deref: () => ({ hasManagedAgentLifecycleState: () => false }),
			},
		})

		expect((idle as any).shouldExposeAgentLifecycleTools()).toBe(false)

		idle.clineMessages = makeTask([
			makeGroup({ groupId: "known-group", executionMode: "async", summary: "Known result." }),
		]).task.clineMessages
		expect((idle as any).shouldExposeAgentLifecycleTools()).toBe(true)
	})

	it("keeps durable descendants and mailbox results reachable after transcript compaction and reload", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const first = new AgentControlStore(persistence, () => 1_000)
		await first.initialize()
		await first.ensureRoot({ taskId: "parent-1", status: "running" })
		await first.createAgent({
			taskId: "durable-child",
			parentTaskId: "parent-1",
			nickname: "Durable child",
			role: "explore",
			objective: "Retain lifecycle state across reload",
			status: "running",
		})

		const reloaded = new AgentControlStore(persistence, () => 2_000)
		await reloaded.initialize()
		const compactedTask = makeTask([]).task

		expect(reloaded.getAgent("durable-child", "parent-1")?.status).toBe("interrupted")
		expect(reloaded.readMailbox("parent-1", { rootTaskId: "parent-1" }).entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ senderTaskId: "durable-child" })]),
		)
		expect((compactedTask as any).shouldExposeAgentLifecycleTools()).toBe(true)
	})

	it("keeps terminal reports in lifecycle state without exposing synthetic user content", () => {
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
		const { task } = makeTask([asyncGroup, blockingGroup, legacyGroup])
		asyncGroup.agents[0].usage = {
			durationMs: 21_000,
			rateLimitWaitCount: 2,
			rateLimitWaitMs: 20_000,
			rateLimitIntervalSeconds: 10,
		}

		expect((task as any).getPendingSpawnedSubagentResults()).toEqual([])
		expect(JSON.stringify(task.clineMessages)).toContain("Parser inspection complete.")
		expect(JSON.stringify(task.clineMessages)).toContain('"rateLimitWaitCount":2')
		expect(JSON.stringify(task.clineMessages)).toContain("Already returned by delegate_task.")
	})

	it("does not turn a terminal aggregate update into a user-authored result", () => {
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

		expect((task as any).getPendingSpawnedSubagentResults()).toEqual([])
	})

	it("leaves the next model-facing user content free of child-report injection", () => {
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

		expect(result.pendingResults).toEqual([])
		expect(result.content).toEqual([
			{ type: "text", text: "Parent tool result" },
			{ type: "text", text: "<environment_details>current state</environment_details>" },
		])
		expect(JSON.stringify(result.content)).not.toContain("spawned_subagent_result")
		expect(JSON.stringify(result.content)).not.toContain("Use the confirmed backend finding.")
	})
})
