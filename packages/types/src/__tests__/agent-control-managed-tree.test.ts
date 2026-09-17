import { MAX_MANAGED_AGENT_TREE_ACTIVITY, managedAgentTreeProjectionSchema } from "../managed-agent-tree.js"

const usage = { inputTokens: 10, outputTokens: 5, cost: 0.02, durationMs: 1_000 }

const root = {
	taskId: "root-1",
	rootTaskId: "root-1",
	path: "/root",
	nickname: "Root task",
	role: "root",
	objective: "Coordinate the release",
	status: "running",
	createdAt: 1,
	updatedAt: 3,
	startedAt: 1,
	depth: 0,
	usage,
}

describe("managed-agent live-tree projection", () => {
	it("parses a bounded nested registry projection without raw manifests or report bodies", () => {
		const projection = managedAgentTreeProjectionSchema.parse({
			version: 1,
			rootTaskId: "root-1",
			observedAt: 4,
			reloadedAt: 3,
			nodes: [
				root,
				{
					...root,
					taskId: "child-1",
					parentTaskId: "root-1",
					groupId: "group-1",
					path: "/root/maple",
					nickname: "Maple",
					role: "review",
					status: "completed",
					depth: 1,
					maxDepth: 3,
					delegationPolicy: "explicit-only",
					stopReason: "completed",
					finishedAt: 3,
				},
			],
			activity: [
				{
					eventId: "event-1",
					sequence: 1,
					createdAt: 3,
					senderTaskId: "child-1",
					senderPath: "/root/maple",
					kind: "result",
					name: "agent_completed",
					summary: "Agent completed",
					unread: true,
				},
			],
			capacity: { active: 0, queued: 0, terminal: 1, limit: 2 },
			budgets: { tokenLimit: null, costLimit: null },
			omittedNodeCount: 0,
			omittedActivityCount: 0,
		})

		expect(projection.nodes[1]).toMatchObject({ depth: 1, path: "/root/maple" })
		expect(projection.nodes[1]).not.toHaveProperty("contextManifest")
		expect(projection.activity[0]).not.toHaveProperty("payload")
	})

	it("rejects raw runtime manifests and unbounded activity", () => {
		expect(() =>
			managedAgentTreeProjectionSchema.parse({
				version: 1,
				rootTaskId: "root-1",
				observedAt: 4,
				nodes: [{ ...root, contextManifest: { secret: "must not cross the bridge" } }],
				activity: [],
				capacity: { active: 0, queued: 0, terminal: 0, limit: 2 },
				budgets: { tokenLimit: null, costLimit: null },
				omittedNodeCount: 0,
				omittedActivityCount: 0,
			}),
		).toThrow()

		const activity = Array.from({ length: MAX_MANAGED_AGENT_TREE_ACTIVITY + 1 }, (_, index) => ({
			eventId: `event-${index}`,
			sequence: index + 1,
			createdAt: index,
			kind: "lifecycle",
			name: "updated",
			summary: "Updated",
			unread: false,
		}))
		expect(() =>
			managedAgentTreeProjectionSchema.parse({
				version: 1,
				rootTaskId: "root-1",
				observedAt: 4,
				nodes: [root],
				activity,
				capacity: { active: 0, queued: 0, terminal: 0, limit: 2 },
				budgets: { tokenLimit: null, costLimit: null },
				omittedNodeCount: 0,
				omittedActivityCount: 1,
			}),
		).toThrow()
	})

	it("rejects inconsistent root identity and descendant capacity counts", () => {
		expect(() =>
			managedAgentTreeProjectionSchema.parse({
				version: 1,
				rootTaskId: "root-1",
				observedAt: 4,
				nodes: [{ ...root, rootTaskId: "other-root" }],
				activity: [],
				capacity: { active: 1, queued: 0, terminal: 0, limit: 2 },
				budgets: { tokenLimit: null, costLimit: null },
				omittedNodeCount: 0,
				omittedActivityCount: 0,
			}),
		).toThrow()
	})
})
