import type { LiveTaskMetadata, SubagentGroupState, SubagentRunState } from "@alpha-code/types"

import { buildManagedAgentTreeModel } from "../managedAgentTreeAdapter"

const NOW = 1_700_000_000_000

const makeAgent = (overrides: Partial<SubagentRunState> = {}): SubagentRunState => ({
	taskId: "child-1",
	nickname: "Maple",
	role: "explore",
	objective: "Map the repository",
	status: "running",
	phase: "working",
	startedAt: NOW - 30_000,
	usage: { durationMs: 30_000, inputTokens: 100, outputTokens: 50 },
	...overrides,
})

const makeGroup = (
	overrides: Partial<SubagentGroupState> & Pick<SubagentGroupState, "groupId" | "parentTaskId">,
): SubagentGroupState => ({
	status: "running",
	createdAt: NOW - 35_000,
	executionMode: "async",
	agents: [makeAgent()],
	...overrides,
})

const makeLiveTask = (id: string, overrides: Partial<LiveTaskMetadata> = {}): LiveTaskMetadata => ({
	id,
	status: "running" as LiveTaskMetadata["status"],
	lifecycle: "running" as LiveTaskMetadata["lifecycle"],
	isActive: false,
	isStreaming: true,
	isWaitingForInput: false,
	lastUpdatedAt: NOW - 1_000,
	queueCount: 0,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...overrides,
})

describe("buildManagedAgentTreeModel", () => {
	it("reconstructs a root-parent-child hierarchy and preserves current group snapshots", () => {
		const original = makeGroup({
			groupId: "group-parent",
			parentTaskId: "root-1",
			agents: [makeAgent({ taskId: "parent-1", nickname: "Parent Worker", role: "worker" })],
		})
		const refreshed = makeGroup({
			...original,
			status: "completed",
			completedAt: NOW - 2_000,
			agents: [
				makeAgent({
					taskId: "parent-1",
					nickname: "Parent Worker",
					role: "worker",
					status: "completed",
					completedAt: NOW - 2_000,
				}),
			],
		})
		const nested = makeGroup({
			groupId: "group-child",
			parentTaskId: "parent-1",
			agents: [makeAgent({ taskId: "child-2", nickname: "Nested Review", role: "review" })],
		})

		const model = buildManagedAgentTreeModel({
			rootTaskId: "root-1",
			groups: [original, refreshed, nested],
			pathsByTaskId: { "parent-1": "/root/parent-worker", "child-2": "/root/parent-worker/nested-review" },
		})

		expect(model.nodes).toHaveLength(3)
		expect(model.nodes[0]).toMatchObject({
			taskId: "root-1",
			role: "root",
			depth: 0,
			path: "/root",
			state: "unknown",
		})
		expect(model.nodes.find((node) => node.taskId === "parent-1")).toMatchObject({
			parentTaskId: "root-1",
			depth: 1,
			status: "completed",
			state: "terminal",
			path: "/root/parent-worker",
		})
		expect(model.nodes.find((node) => node.taskId === "child-2")).toMatchObject({
			parentTaskId: "parent-1",
			depth: 2,
			path: "/root/parent-worker/nested-review",
		})
	})

	it("maps durable depth, policy, limits, and known or unknown terminal stop reasons safely", () => {
		const group = makeGroup({
			groupId: "group-terminal",
			parentTaskId: "root-1",
			status: "failed",
			agents: [makeAgent({ status: "failed", completedAt: NOW - 1_000 })],
		})

		const known = buildManagedAgentTreeModel({
			rootTaskId: "root-1",
			groups: [group],
			runtimeByTaskId: {
				"child-1": {
					path: "/root/maple",
					depth: 3,
					maxDepth: 4,
					stopReason: "root_cost_budget",
					contextManifest: {
						orchestration: {
							ancestry: ["root-1", "parent-1"],
							delegationPolicy: "explicit_only",
							limits: { timeoutMs: 90_000, outputTokenLimit: 2_000 },
						},
					},
				},
			},
		})
		expect(known.nodes[1]).toMatchObject({
			depth: 3,
			maxDepth: 4,
			delegationPolicy: "explicit_only",
			effectiveLimits: { timeoutMs: 90_000, outputTokenLimit: 2_000 },
			stopReason: "Root cost budget reached",
		})

		const unknown = buildManagedAgentTreeModel({
			rootTaskId: "root-1",
			groups: [group],
			runtimeByTaskId: { "child-1": { stopReason: { unexpected: true } } },
		})
		expect(unknown.nodes[1].stopReason).toBe("Runtime stopped this agent; details were not recognized")
	})

	it("aggregates live token and cost usage while keeping absent limits explicitly unknown", () => {
		const model = buildManagedAgentTreeModel({
			rootTaskId: "root-1",
			groups: [makeGroup({ groupId: "group-1", parentTaskId: "root-1" })],
			liveTasksById: {
				"root-1": makeLiveTask("root-1", { tokensIn: 200, tokensOut: 100, totalCost: 0.2 }),
				"child-1": makeLiveTask("child-1", { tokensIn: 300, tokensOut: 150, totalCost: 0.3 }),
			},
			activity: [],
		})

		expect(model.usage).toEqual({
			inputTokens: 300,
			outputTokens: 150,
			totalTokens: 450,
			totalCost: 0.3,
			tokensReported: true,
			costReported: true,
		})
		expect(model.capacity).toMatchObject({ active: 1, queued: 0, terminal: 0, limit: undefined })
		expect(model.budgets).toEqual({ tokenLimit: undefined, costLimit: undefined })
		expect(model.activityReported).toBe(true)
	})

	it("attaches orphaned or cyclic snapshots to the root with collision-safe fallback paths", () => {
		const model = buildManagedAgentTreeModel({
			rootTaskId: "root-1",
			groups: [
				makeGroup({
					groupId: "group-a",
					parentTaskId: "missing-parent",
					agents: [makeAgent({ taskId: "child-a", nickname: "Review API" })],
				}),
				makeGroup({
					groupId: "group-b",
					parentTaskId: "missing-parent",
					agents: [makeAgent({ taskId: "child-b", nickname: "Review API" })],
				}),
			],
		})

		expect(model.nodes[1]).toMatchObject({ parentTaskId: "root-1", path: "/root/review-api" })
		expect(model.nodes[2]).toMatchObject({ parentTaskId: "root-1", path: "/root/review-api-2" })
	})
})
