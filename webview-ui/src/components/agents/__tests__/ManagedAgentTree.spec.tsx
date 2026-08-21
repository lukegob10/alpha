import type { ManagedAgentTreeProjection, SubagentGroupState, SubagentRunState } from "@alpha-code/types"
import userEvent from "@testing-library/user-event"
import { render, screen, within } from "@testing-library/react"

import { ManagedAgentTree } from "../ManagedAgentTree"

const NOW = 1_700_000_000_000

const makeAgent = (overrides: Partial<SubagentRunState> = {}): SubagentRunState => ({
	taskId: "child-1",
	nickname: "Maple",
	role: "explore",
	objective: "Map the repository structure and report ownership boundaries.",
	status: "running",
	phase: "working",
	startedAt: NOW - 65_000,
	usage: { durationMs: 65_000, inputTokens: 100, outputTokens: 50 },
	...overrides,
})

const makeGroup = (agent: SubagentRunState): SubagentGroupState => ({
	groupId: `group-${agent.taskId}`,
	parentTaskId: "root-1",
	status: agent.status === "pending" || agent.status === "running" ? agent.status : "completed",
	createdAt: NOW - 70_000,
	startedAt: NOW - 65_000,
	executionMode: "async",
	agents: [agent],
})

const hierarchyProjection = (): ManagedAgentTreeProjection => ({
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
			objective: "Coordinate managed descendants",
			status: "running",
			createdAt: NOW - 120_000,
			updatedAt: NOW - 1_000,
			startedAt: NOW - 120_000,
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
			objective: "Build the bridge",
			status: "running",
			phase: "working",
			createdAt: NOW - 70_000,
			updatedAt: NOW - 1_000,
			startedAt: NOW - 65_000,
			depth: 1,
			usage: { durationMs: 64_000, inputTokens: 100, outputTokens: 50, cost: 0.1 },
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
			createdAt: NOW - 65_000,
			updatedAt: NOW - 5_000,
			startedAt: NOW - 65_000,
			finishedAt: NOW - 5_000,
			depth: 2,
			stopReason: "output_token_limit",
			usage: { durationMs: 60_000, inputTokens: 200, outputTokens: 80, cost: 0.2 },
		},
	],
	activity: [
		{
			eventId: "mail-1",
			sequence: 1,
			createdAt: NOW - 500,
			kind: "result",
			name: "agent_completed",
			summary: "Detailed mailbox payload that must stay hidden",
			unread: true,
		},
	],
	capacity: { active: 1, queued: 0, terminal: 1, limit: 4 },
	budgets: { tokenLimit: 2_000, costLimit: 2 },
	omittedNodeCount: 0,
	omittedActivityCount: 0,
})

describe("ManagedAgentTree", () => {
	it("renders one compact, horizontally scrollable task strip without repeating the root or dashboard detail", () => {
		render(<ManagedAgentTree rootTaskId="root-1" projection={hierarchyProjection()} onShowTask={vi.fn()} />)

		const region = screen.getByRole("region", { name: "Sub-agent tasks" })
		const list = within(region).getByRole("list")
		expect(within(list).getAllByRole("listitem")).toHaveLength(2)
		expect(within(region).queryByText("Release root")).not.toBeInTheDocument()
		expect(
			within(region).getByRole("button", { name: /Open Cinder · Working · worker · \/root\/cinder/i }),
		).toBeInTheDocument()
		expect(
			within(region).getByRole("button", {
				name: /Open Iris · Timed out · review · \/root\/cinder\/iris · nested level 2/i,
			}),
		).toBeInTheDocument()
		expect(list).toHaveClass("overflow-x-auto")

		for (const unwanted of [
			"Aggregate tokens",
			"Aggregate cost",
			"Mailbox & activity",
			"Root-wide capacity",
			"Build the bridge",
			"Detailed mailbox payload that must stay hidden",
		]) {
			expect(screen.queryByText(unwanted, { exact: false })).not.toBeInTheDocument()
		}
	})

	it("opens active and nested tasks with the exact task id", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		render(<ManagedAgentTree rootTaskId="root-1" projection={hierarchyProjection()} onShowTask={onShowTask} />)

		await user.click(screen.getByRole("button", { name: /Open Cinder/i }))
		await user.click(screen.getByRole("button", { name: /Open Iris/i }))
		expect(onShowTask.mock.calls).toEqual([["parent-1"], ["child-2"]])
	})

	it("renders task links as native keyboard-focusable buttons", () => {
		const onShowTask = vi.fn()
		render(<ManagedAgentTree rootTaskId="root-1" projection={hierarchyProjection()} onShowTask={onShowTask} />)

		const task = screen.getByRole("button", { name: /Open Cinder/i })
		expect(task).toHaveAttribute("type", "button")
		expect(task).toHaveProperty("tabIndex", 0)
	})

	it("surfaces only compact actionable attention from group state", () => {
		const reviewAgent = makeAgent({
			taskId: "worker-1",
			nickname: "Worker",
			role: "worker",
			status: "completed",
			changeSet: {
				id: "change-1",
				status: "pending_review",
				changedFiles: ["src/index.ts"],
				createdAt: NOW,
				updatedAt: NOW,
			},
		})
		const approvalAgent = makeAgent({
			taskId: "approval-1",
			nickname: "Approval",
			pendingApproval: {
				id: "approval",
				type: "command",
				operation: "pnpm test",
				createdAt: NOW,
			},
		})

		render(
			<ManagedAgentTree
				rootTaskId="root-1"
				groups={[makeGroup(reviewAgent), makeGroup(approvalAgent)]}
				onShowTask={vi.fn()}
			/>,
		)

		expect(screen.getByRole("button", { name: /Open Worker · Completed · Review/i })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /Open Approval · Working · Approval/i })).toBeInTheDocument()
		expect(screen.queryByText("pnpm test")).not.toBeInTheDocument()
	})

	it("clears attention when a newer snapshot no longer requires action", () => {
		const approvalAgent = makeAgent({
			pendingApproval: {
				id: "approval",
				type: "command",
				operation: "pnpm test",
				createdAt: NOW - 1_000,
			},
		})
		const resolvedAgent = makeAgent({ phaseStartedAt: NOW })

		render(
			<ManagedAgentTree
				rootTaskId="root-1"
				groups={[makeGroup(approvalAgent), makeGroup(resolvedAgent)]}
				onShowTask={vi.fn()}
			/>,
		)

		const task = screen.getByRole("button", { name: /Open Maple · Working/i })
		expect(task).not.toHaveTextContent("Approval")
	})

	it("keeps loading and error state to one compact line", () => {
		const { rerender } = render(<ManagedAgentTree rootTaskId="root-1" isLoading onShowTask={vi.fn()} />)
		expect(screen.getByRole("region", { name: "Sub-agent tasks" })).toHaveAttribute("aria-busy", "true")
		expect(screen.getByText("Updating")).toBeInTheDocument()

		rerender(<ManagedAgentTree rootTaskId="root-1" errorMessage="Registry unavailable" onShowTask={vi.fn()} />)
		expect(screen.getByRole("alert")).toHaveTextContent("Unavailable")
		expect(screen.getByRole("alert")).toHaveAttribute("title", "Registry unavailable")
	})

	it("bounds very large trees without expanding vertically", () => {
		const groups = Array.from({ length: 6 }, (_, index) =>
			makeGroup(makeAgent({ taskId: `child-${index}`, nickname: `Agent ${index}` })),
		)
		render(<ManagedAgentTree rootTaskId="root-1" groups={groups} maxVisibleAgents={3} onShowTask={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(3)
		expect(screen.getByText("+3")).toHaveAttribute("title", "3 additional sub-agent tasks")
	})

	it("disables navigation only when the host does not expose it", () => {
		render(<ManagedAgentTree rootTaskId="root-1" projection={hierarchyProjection()} />)
		expect(screen.getByRole("button", { name: /Cinder task unavailable/i })).toBeDisabled()
	})

	it("keeps status readable without relying on dot color", () => {
		render(<ManagedAgentTree rootTaskId="root-1" projection={hierarchyProjection()} onShowTask={vi.fn()} />)
		expect(screen.getByRole("button", { name: /Open Cinder · Working/i })).toHaveTextContent("Working")
		expect(screen.getByRole("button", { name: /Open Iris · Timed out/i })).toHaveTextContent("Timed out")
	})

	it("keeps completed status visible without relying on dot color", () => {
		const projection = hierarchyProjection()
		projection.nodes[2].status = "completed"
		render(<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={vi.fn()} />)

		expect(screen.getByRole("button", { name: /Open Iris · Completed/i })).toHaveTextContent("Completed")
	})

	it("does not render an empty strip", () => {
		const { container } = render(<ManagedAgentTree rootTaskId="root-1" groups={[]} onShowTask={vi.fn()} />)
		expect(container).toBeEmptyDOMElement()
	})
})
