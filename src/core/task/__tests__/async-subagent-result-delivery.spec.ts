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
	const saveAlphaMessages = vi.fn(async () => true)
	const task = Object.assign(Object.create(Task.prototype), {
		taskKind: "primary",
		clineMessages: groups.map((subagentGroup) => ({
			ts: subagentGroup.createdAt,
			type: "say",
			say: "subagent_group",
			subagentGroup,
		})),
		saveAlphaMessages,
	}) as Task

	return { task, saveAlphaMessages }
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

	it("keeps lifecycle controls eager when the durable store contains no managed agents", () => {
		const idle = makeTask([]).task
		Object.assign(idle, {
			providerRef: {
				deref: () => ({ hasManagedAgentLifecycleState: () => false }),
			},
		})

		expect((idle as any).shouldExposeAgentLifecycleTools()).toBe(true)

		idle.clineMessages = makeTask([
			makeGroup({ groupId: "known-group", executionMode: "async", summary: "Known result." }),
		]).task.clineMessages
		expect((idle as any).shouldExposeAgentLifecycleTools()).toBe(true)
	})

	it("keeps a legacy primary handoff child's lifecycle catalog independent of retained activity", () => {
		const legacyChild = makeTask([]).task
		const hasManagedAgentLifecycleState = vi.fn(() => false)
		Object.assign(legacyChild, {
			taskId: "legacy-child",
			rootTaskId: "legacy-parent",
			providerRef: { deref: () => ({ hasManagedAgentLifecycleState }) },
		})

		expect((legacyChild as any).shouldExposeAgentLifecycleTools()).toBe(true)
		expect(hasManagedAgentLifecycleState).not.toHaveBeenCalled()
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
})
