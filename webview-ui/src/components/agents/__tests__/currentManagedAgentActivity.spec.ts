import type { ClineMessage, SubagentGroupState } from "@alpha-code/types"

import { buildCurrentManagedAgentActivity } from "../currentManagedAgentActivity"

const group: SubagentGroupState = {
	groupId: "group-1",
	parentTaskId: "root-1",
	status: "running",
	createdAt: 1_000,
	agents: [
		{
			taskId: "child-1",
			nickname: "Maple",
			role: "worker",
			objective: "Implement the UI",
			status: "running",
			phase: "working",
			phaseStartedAt: 2_000,
			usage: { durationMs: 1_000 },
		},
	],
}

describe("buildCurrentManagedAgentActivity", () => {
	it("adapts agent snapshots and mailbox counts into legible timestamped summaries", () => {
		const messages: ClineMessage[] = [
			{ ts: 1_000, type: "say", say: "subagent_group", subagentGroup: group },
			{
				ts: 3_000,
				type: "say",
				say: "tool",
				text: JSON.stringify({
					tool: "agentLifecycle",
					agentAction: "list_agents",
					lifecycleStatus: "completed",
					agentCount: 2,
					mailboxUnreadCount: 1,
				}),
			},
		]

		expect(buildCurrentManagedAgentActivity(messages)).toEqual([
			expect.objectContaining({
				createdAt: 3_000,
				summary: "Agent snapshot: 2 agents, 1 unread mailbox update",
				unread: true,
			}),
			expect.objectContaining({
				createdAt: 2_000,
				taskId: "child-1",
				summary: "Maple is running · working",
			}),
		])
	})

	it("ignores malformed and unrelated tool rows without throwing", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "tool", text: "{" },
			{ ts: 2, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile" }) },
		]

		expect(buildCurrentManagedAgentActivity(messages)).toEqual([])
	})
})
