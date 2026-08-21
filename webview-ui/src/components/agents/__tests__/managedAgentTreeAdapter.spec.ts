import type {
	LiveTaskMetadata,
	ManagedAgentTreeProjection,
	SubagentGroupState,
	SubagentRunState,
} from "@alpha-code/types"

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

const makeProjection = (): ManagedAgentTreeProjection => ({
	version: 1,
	rootTaskId: "root-1",
	observedAt: NOW,
	reloadedAt: NOW - 500,
	nodes: [
		{
			taskId: "root-1",
			rootTaskId: "root-1",
			path: "/root",
			nickname: "Release root",
			role: "root",
			objective: "Coordinate the release",
			status: "running",
			createdAt: NOW - 120_000,
			updatedAt: NOW - 1_000,
			depth: 0,
			usage: { durationMs: 119_000 },
		},
		{
			taskId: "parent-1",
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			groupId: "group-parent",
			path: "/root/cinder",
			nickname: "Cinder",
			role: "worker",
			objective: "Implement the bridge",
			status: "running",
			phase: "working",
			createdAt: NOW - 70_000,
			updatedAt: NOW - 2_000,
			startedAt: NOW - 65_000,
			depth: 1,
			usage: { durationMs: 63_000, inputTokens: 300, outputTokens: 150, cost: 0.3 },
		},
		{
			taskId: "child-2",
			rootTaskId: "root-1",
			parentTaskId: "parent-1",
			groupId: "group-child",
			path: "/root/cinder/iris",
			nickname: "Iris",
			role: "review",
			objective: "Review the bridge",
			status: "timed_out",
			createdAt: NOW - 60_000,
			updatedAt: NOW - 5_000,
			startedAt: NOW - 58_000,
			finishedAt: NOW - 5_000,
			depth: 2,
			stopReason: "output_token_limit",
			usage: { durationMs: 53_000, inputTokens: 200, outputTokens: 80, cost: 0.2 },
			attention: { kind: "input", label: "Waiting for user input" },
		},
	],
	activity: [],
	capacity: { active: 1, queued: 0, terminal: 1, limit: 4 },
	budgets: { tokenLimit: 2_000, costLimit: 2 },
	omittedNodeCount: 0,
	omittedActivityCount: 0,
})

describe("buildManagedAgentTreeModel", () => {
	it("reconstructs nested fallback paths from the latest group snapshots", () => {
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
		})

		expect(model.nodes).toHaveLength(2)
		expect(model.nodes.find((node) => node.taskId === "parent-1")).toMatchObject({
			parentTaskId: "root-1",
			depth: 1,
			status: "completed",
			path: "/root/parent-worker",
		})
		expect(model.nodes.find((node) => node.taskId === "child-2")).toMatchObject({
			parentTaskId: "parent-1",
			depth: 2,
			path: "/root/parent-worker/nested-review",
		})
	})

	it("prefers the authoritative durable projection and omits its root", () => {
		const model = buildManagedAgentTreeModel({
			rootTaskId: "root-1",
			projection: makeProjection(),
			groups: [makeGroup({ groupId: "stale-group", parentTaskId: "root-1" })],
		})

		expect(model.nodes.map((node) => node.taskId)).toEqual(["parent-1", "child-2"])
		expect(model.nodes[1]).toEqual({
			taskId: "child-2",
			parentTaskId: "parent-1",
			path: "/root/cinder/iris",
			nickname: "Iris",
			role: "review",
			status: "timed_out",
			depth: 2,
			attention: "Waiting for user input",
		})
		expect(model.omittedNodeCount).toBe(0)
	})

	it("surfaces fallback live-task input attention without copying dashboard metadata", () => {
		const model = buildManagedAgentTreeModel({
			rootTaskId: "root-1",
			groups: [makeGroup({ groupId: "group-1", parentTaskId: "root-1" })],
			liveTasksById: {
				"child-1": makeLiveTask("child-1", {
					isWaitingForInput: true,
					waitingReason: "Choose a recovery action",
				}),
			},
		})

		expect(model.nodes[0]).toMatchObject({
			taskId: "child-1",
			attention: "Choose a recovery action",
		})
		expect(model).toEqual({ nodes: model.nodes, omittedNodeCount: 0 })
	})

	it("attaches orphaned or cyclic snapshots to collision-safe root paths", () => {
		const model = buildManagedAgentTreeModel({
			rootTaskId: "root-1",
			groups: [
				makeGroup({
					groupId: "group-a",
					parentTaskId: "child-b",
					agents: [makeAgent({ taskId: "child-a", nickname: "Review API" })],
				}),
				makeGroup({
					groupId: "group-b",
					parentTaskId: "child-a",
					agents: [makeAgent({ taskId: "child-b", nickname: "Review API" })],
				}),
			],
		})

		expect(model.nodes[0]).toMatchObject({ parentTaskId: "root-1", path: "/root/review-api" })
		expect(model.nodes[1]).toMatchObject({ parentTaskId: "root-1", path: "/root/review-api-2" })
	})
})
