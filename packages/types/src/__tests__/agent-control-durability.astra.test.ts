import { agentControlStateSchema, agentRecordSchema, closedAgentTombstoneSchema } from "../agent-control.js"
import { createSubagentEffectiveLimits, resolveSubagentOrchestrationSettings } from "../subagent-orchestration.js"

const tombstone = {
	taskId: "closed-child",
	path: "/root/child",
	parentTaskId: "root",
	rootTaskId: "root",
	status: "completed",
	closedAt: 2_000,
}

describe("managed-agent durability metadata compatibility", () => {
	it.each([1, 2])("reads version %s tombstones without new accounting metadata", (version) => {
		const state = agentControlStateSchema.parse({
			version,
			updatedAt: 2_000,
			nextSequence: 1,
			agents: [],
			tombstones: [tombstone],
			mailbox: [],
			mailboxCursors: {},
		})
		expect(state.version).toBe(2)
		expect(state.tombstones).toEqual([tombstone])
	})

	it("retains validated closed spend and optional follow-up receipt identity", () => {
		expect(
			closedAgentTombstoneSchema.parse({ ...tombstone, budgetUsage: { tokens: 50_000, cost: 5 } }),
		).toMatchObject({ budgetUsage: { tokens: 50_000, cost: 5 } })
		const record = {
			...tombstone,
			nickname: "Child",
			role: "review",
			objective: "Inspect",
			createdAt: 1,
			updatedAt: 2,
		}
		expect(agentRecordSchema.parse(record).pendingFollowupEventId).toBeUndefined()
		expect(agentRecordSchema.parse({ ...record, pendingFollowupEventId: "receipt-1" }).pendingFollowupEventId).toBe(
			"receipt-1",
		)
		expect(agentRecordSchema.safeParse({ ...record, pendingFollowupEventId: "" }).success).toBe(false)
	})

	it.each([null, 50_000])("retains the complete frozen orchestration with a %s token ceiling", (rootTokenBudget) => {
		const orchestration = {
			ancestry: { rootTaskId: "root", parentTaskId: "root", depth: 1, maxDepth: 3 },
			delegationPolicy: {
				policy: "explicit-only",
				source: "default",
				authorization: "session-policy",
				explicitUserRequest: false,
			},
			limits: createSubagentEffectiveLimits(
				resolveSubagentOrchestrationSettings({
					subagentRootTokenBudget: rootTokenBudget,
					subagentRootCostBudget: null,
					subagentRoleTimeoutsMs: { explore: 15_000, review: 20_000, worker: 30_000 },
				}),
				"review",
				3,
			),
		}
		expect(closedAgentTombstoneSchema.parse({ ...tombstone, orchestration }).orchestration).toEqual(orchestration)
		expect(
			closedAgentTombstoneSchema.safeParse({
				...tombstone,
				orchestration: { ...orchestration, limits: { ...orchestration.limits, rootCostBudget: -1 } },
			}).success,
		).toBe(false)
	})

	it.each([
		{ tokens: -1, cost: 0 },
		{ tokens: 0, cost: -1 },
		{ tokens: Infinity, cost: 0 },
		{ tokens: 0, cost: NaN },
	])("rejects invalid closed usage %j", (budgetUsage) => {
		expect(closedAgentTombstoneSchema.safeParse({ ...tombstone, budgetUsage }).success).toBe(false)
	})
})
