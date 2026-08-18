import type { LiveTaskMetadata, SubagentGroupState, SubagentRunState } from "@alpha-code/types"
import { fireEvent, render, screen, within } from "@testing-library/react"

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

const makeGroup = (
	overrides: Partial<SubagentGroupState> & Pick<SubagentGroupState, "groupId" | "parentTaskId">,
): SubagentGroupState => ({
	status: "running",
	createdAt: NOW - 70_000,
	startedAt: NOW - 65_000,
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

const hierarchyGroups = (): SubagentGroupState[] => [
	makeGroup({
		groupId: "group-parent",
		parentTaskId: "root-1",
		agents: [makeAgent({ taskId: "parent-1", nickname: "Cinder", role: "worker" })],
	}),
	makeGroup({
		groupId: "group-child",
		parentTaskId: "parent-1",
		agents: [
			makeAgent({
				taskId: "child-2",
				nickname: "Iris",
				role: "review",
				status: "timed_out",
				phase: undefined,
				completedAt: NOW - 5_000,
				usage: { durationMs: 60_000, inputTokens: 200, outputTokens: 80 },
			}),
		],
	}),
]

describe("ManagedAgentTree", () => {
	it("renders an accessible root-parent-child hierarchy with state, elapsed time, and stop reason", () => {
		render(
			<ManagedAgentTree
				rootTaskId="root-1"
				rootLabel="Release root"
				rootStartedAt={NOW - 120_000}
				groups={hierarchyGroups()}
				now={NOW}
				pathsByTaskId={{
					"parent-1": "/root/cinder",
					"child-2": "/root/cinder/iris",
				}}
				runtimeByTaskId={{
					"child-2": {
						depth: 2,
						maxDepth: 3,
						delegationPolicy: "explicit-only",
						effectiveLimits: { timeoutMs: 60_000, outputTokenLimit: 2_000 },
						stopReason: "output_token_limit",
					},
				}}
			/>,
		)

		const tree = screen.getByRole("tree", { name: "Managed agent hierarchy" })
		const items = within(tree).getAllByRole("treeitem")
		expect(items).toHaveLength(3)
		expect(items[0]).toHaveAttribute("aria-level", "1")
		expect(items[1]).toHaveAttribute("aria-level", "2")
		expect(items[2]).toHaveAttribute("aria-level", "3")
		expect(items[0]).toHaveAccessibleName(/Release root, Root, depth 0/i)
		expect(items[1]).toHaveAccessibleName(/Cinder, Worker, depth 1, Running/i)
		expect(items[2]).toHaveAccessibleName(/Iris, Reviewer, depth 2, Terminal, Timed out/i)

		expect(within(items[1]).getByText("1m 5s")).toBeInTheDocument()
		expect(within(items[2]).getByText("Depth 2 of 3")).toBeInTheDocument()
		expect(within(items[2]).getByText("Delegation explicit only")).toBeInTheDocument()
		expect(within(items[2]).getByText(/Limits: timeout ms 1m · output token limit 2,000/i)).toBeInTheDocument()
		expect(within(items[2]).getByText("Output token limit reached")).toBeInTheDocument()
	})

	it("shows observed capacity and aggregate token/cost budgets without inventing missing values", () => {
		const groups = [
			makeGroup({
				groupId: "running-group",
				parentTaskId: "root-1",
				agents: [makeAgent({ taskId: "running-1" })],
			}),
			makeGroup({
				groupId: "queued-group",
				parentTaskId: "root-1",
				status: "pending",
				agents: [
					makeAgent({
						taskId: "queued-1",
						nickname: "Queue",
						status: "pending",
						phase: "queued",
						startedAt: undefined,
						usage: { durationMs: 0 },
					}),
				],
			}),
		]
		render(
			<ManagedAgentTree
				rootTaskId="root-1"
				groups={groups}
				now={NOW}
				capacityLimit={4}
				tokenBudget={2_000}
				costBudget={2}
				liveTasksById={{
					"root-1": makeLiveTask("root-1", { tokensIn: 200, tokensOut: 100, totalCost: 0.2 }),
					"running-1": makeLiveTask("running-1", { tokensIn: 300, tokensOut: 150, totalCost: 0.3 }),
				}}
			/>,
		)

		expect(screen.getByText("1 of 4 active")).toBeInTheDocument()
		expect(screen.getByText("1 queued · 3 available")).toBeInTheDocument()
		expect(screen.getByText("450 tokens")).toBeInTheDocument()
		expect(screen.getByText("2,000 token budget")).toBeInTheDocument()
		expect(screen.getByText("$0.30")).toBeInTheDocument()
		expect(screen.getByText("$2.00 cost budget")).toBeInTheDocument()
		expect(screen.getByRole("progressbar", { name: "Root-wide capacity: 1 of 4" })).toBeInTheDocument()
		expect(screen.getByRole("progressbar", { name: "Token budget: 450 of 2000" })).toBeInTheDocument()
	})

	it("labels unavailable capacity limits, budgets, usage, and mailbox data as not reported", () => {
		render(<ManagedAgentTree rootTaskId="root-1" groups={hierarchyGroups()} now={NOW} />)

		expect(screen.getByText(/Limit not reported/)).toBeInTheDocument()
		expect(screen.getAllByText("Budget not reported")).toHaveLength(2)
		expect(screen.getByText("Cost not reported")).toBeInTheDocument()
		expect(screen.getByText("Mailbox activity not reported")).toBeInTheDocument()
		expect(screen.getByText("The current runtime snapshot does not expose mailbox events.")).toBeInTheDocument()
	})

	it("distinguishes intentionally unlimited budgets from budgets the runtime did not report", () => {
		render(<ManagedAgentTree rootTaskId="root-1" groups={[]} tokenBudget={null} costBudget={null} now={NOW} />)

		expect(screen.getAllByText("No limit configured")).toHaveLength(2)
		expect(screen.queryByText("Budget not reported")).not.toBeInTheDocument()
	})

	it("renders bounded, timestamped mailbox activity with legible summaries", () => {
		render(
			<ManagedAgentTree
				rootTaskId="root-1"
				groups={[]}
				now={NOW}
				maxVisibleEvents={2}
				activity={[
					{
						id: "old",
						createdAt: NOW - 60_000,
						summary: "Older lifecycle event",
						kind: "lifecycle",
					},
					{
						id: "new",
						createdAt: NOW - 1_000,
						summary: "Worker completed validation",
						kind: "result",
						name: "agent_completed",
						sender: "/root/worker",
						unread: true,
					},
					{
						id: "middle",
						createdAt: NOW - 10_000,
						summary: "Reviewer sent a mailbox note",
						kind: "message",
					},
				]}
			/>,
		)

		const log = screen.getByRole("log", { name: "Managed agent activity" })
		expect(within(log).getByText("Worker completed validation")).toBeInTheDocument()
		expect(within(log).getByText("Reviewer sent a mailbox note")).toBeInTheDocument()
		expect(within(log).queryByText("Older lifecycle event")).not.toBeInTheDocument()
		expect(within(log).getByText("From /root/worker")).toBeInTheDocument()
		expect(within(log).getByLabelText("Unread")).toBeInTheDocument()
		expect(within(log).getAllByRole("time")[0]).toHaveAttribute("datetime", new Date(NOW - 1_000).toISOString())
		expect(screen.getByText("Showing the newest 2 events. 1 older events are not rendered.")).toBeInTheDocument()
	})

	it("exposes cancellation only for cancellable descendants and sends the existing request shape once", () => {
		const onCancelAgent = vi.fn()
		const groups = [
			makeGroup({
				groupId: "live-group",
				parentTaskId: "root-1",
				agents: [makeAgent({ taskId: "live-1", nickname: "Live Worker", role: "worker" })],
			}),
			makeGroup({
				groupId: "done-group",
				parentTaskId: "root-1",
				status: "failed",
				agents: [makeAgent({ taskId: "done-1", nickname: "Done Worker", status: "failed" })],
			}),
		]
		render(<ManagedAgentTree rootTaskId="root-1" groups={groups} now={NOW} onCancelAgent={onCancelAgent} />)

		const stop = screen.getByRole("button", { name: "Stop Live Worker" })
		fireEvent.click(stop)
		fireEvent.click(stop)
		expect(onCancelAgent).toHaveBeenCalledTimes(1)
		expect(onCancelAgent).toHaveBeenCalledWith({
			parentTaskId: "root-1",
			groupId: "live-group",
			subagentTaskId: "live-1",
		})
		expect(screen.getByRole("button", { name: "Stopping Live Worker" })).toBeDisabled()
		expect(screen.queryByRole("button", { name: /Done Worker/ })).not.toHaveAccessibleName(/Stop/)
	})

	it("capability-disables unsupported stop and transcript affordances", () => {
		render(<ManagedAgentTree rootTaskId="root-1" groups={hierarchyGroups().slice(0, 1)} now={NOW} />)

		expect(screen.getByRole("button", { name: "Stop unavailable for Cinder" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Transcript unavailable for Cinder" })).toBeDisabled()
	})

	it("supports roving keyboard focus and collapsing nested branches", () => {
		render(<ManagedAgentTree rootTaskId="root-1" groups={hierarchyGroups()} now={NOW} />)
		const tree = screen.getByRole("tree", { name: "Managed agent hierarchy" })
		let items = within(tree).getAllByRole("treeitem")
		expect(items[0]).toHaveAttribute("tabindex", "0")
		expect(items[1]).toHaveAttribute("tabindex", "-1")

		fireEvent.keyDown(items[0], { key: "ArrowDown" })
		items = within(tree).getAllByRole("treeitem")
		expect(items[1]).toHaveAttribute("tabindex", "0")

		fireEvent.keyDown(items[1], { key: "ArrowLeft" })
		expect(within(tree).getAllByRole("treeitem")).toHaveLength(2)
		expect(screen.getByRole("button", { name: "Expand Cinder" })).toBeInTheDocument()

		fireEvent.keyDown(within(tree).getAllByRole("treeitem")[1], { key: "ArrowRight" })
		expect(within(tree).getAllByRole("treeitem")).toHaveLength(3)
	})

	it("keeps loading, empty, reloaded, and large-tree states safe and bounded", () => {
		const { rerender } = render(<ManagedAgentTree rootTaskId="root-1" isLoading now={NOW} />)
		expect(screen.getByLabelText("Managed agents")).toHaveAttribute("aria-busy", "true")
		expect(screen.getByText("Loading managed agents…")).toBeInTheDocument()

		rerender(<ManagedAgentTree rootTaskId="root-1" groups={[]} reloadedAt={NOW - 5_000} now={NOW} />)
		expect(screen.getByText("No managed descendants")).toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("Restored after reload")

		const groups = Array.from({ length: 6 }, (_, index) =>
			makeGroup({
				groupId: `group-${index}`,
				parentTaskId: "root-1",
				agents: [makeAgent({ taskId: `child-${index}`, nickname: `Agent ${index}` })],
			}),
		)
		rerender(<ManagedAgentTree rootTaskId="root-1" groups={groups} maxVisibleAgents={3} now={NOW} />)
		expect(screen.getAllByRole("treeitem")).toHaveLength(3)
		expect(screen.getByText("Showing 3 of 7 visible nodes. 4 more not rendered.")).toBeInTheDocument()
	})
})
