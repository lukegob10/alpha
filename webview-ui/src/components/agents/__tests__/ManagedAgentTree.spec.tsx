import type { ManagedAgentTreeProjection, SubagentGroupState, SubagentRunState } from "@alpha-code/types"
import userEvent from "@testing-library/user-event"
import i18next from "i18next"
import { initReactI18next } from "react-i18next"
import { render, screen, within } from "@testing-library/react"
import { vscode } from "@/utils/vscode"
import chat from "@/i18n/locales/en/chat.json"

import { ManagedAgentTree } from "../ManagedAgentTree"
import * as managedAgentTreeAdapter from "../managedAgentTreeAdapter"
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

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

const wideProjection = (): ManagedAgentTreeProjection => {
	const projection = hierarchyProjection()
	const child = projection.nodes[1]
	projection.nodes = [
		projection.nodes[0],
		...Array.from({ length: 100 }, (_, index) => ({
			...child,
			taskId: `child-${index}`,
			path: `/root/agent-${index}`,
			nickname: `Agent ${index}`,
		})),
	]
	projection.activity = Array.from({ length: 100 }, (_, index) => ({
		...projection.activity[0],
		eventId: `mail-${index}`,
		sequence: index + 1,
		senderTaskId: "child-99",
		recipientTaskId: "child-99",
		summary: `Activity ${index}`,
	}))
	return projection
}

describe("ManagedAgentTree", () => {
	beforeAll(async () => {
		await i18next
			.use(initReactI18next)
			.init({ lng: "en", resources: { en: { chat: { subagentRow: chat.subagentRow } } } })
	})
	beforeEach(() => vi.mocked(vscode.postMessage).mockClear())
	it.each(["pending", "failed"] as const)("does not turn advisory %s evidence into required attention", (status) => {
		const agent = makeAgent({
			status: "completed",
			role: "worker",
			parentVerification: {
				status,
				blocking: false,
				obligationCount: 1,
				unresolvedCount: 0,
				changeSetId: "change-1",
				updatedAt: NOW,
				message: "Optional command evidence.",
			},
		})
		render(<ManagedAgentTree rootTaskId="root-1" groups={[makeGroup(agent)]} onShowTask={vi.fn()} />)
		expect(screen.getByRole("button", { name: /Open Maple · Completed/i })).toBeEnabled()
		expect(screen.queryByText("Verify")).not.toBeInTheDocument()
		expect(screen.queryByText("Fix")).not.toBeInTheDocument()
	})

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

	it("does not offer navigation for a child that failed before task creation", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		const projection = hierarchyProjection()
		projection.nodes[2].status = "failed"
		projection.nodes[2].stopReason = "never_launched"
		render(<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={onShowTask} />)

		const task = screen.getByRole("button", { name: /Iris task unavailable · Failed/i })
		expect(task).toBeDisabled()
		await user.click(task)
		expect(onShowTask).not.toHaveBeenCalled()
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

		expect(screen.getByRole("button", { name: /Open Worker · Completed · Changes available/i })).toBeInTheDocument()
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

	it.each(["Review these changes", "Should this operation require approval?"])(
		"preserves typed input attention when its label says %s",
		(label) => {
			const projection = hierarchyProjection()
			projection.nodes[1].attention = { kind: "input", label }
			render(<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={vi.fn()} />)
			const row = screen.getByRole("button", { name: /Open Cinder · Working · Input/ })
			expect(row).toHaveTextContent("Input")
			expect(row).not.toHaveTextContent("Approval required")
			expect(row).not.toHaveTextContent("Changes available")
		},
	)

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
		expect(screen.getByRole("button", { name: "agentNavigation.more" })).toHaveTextContent("+3")
	})
	it("opens agents beyond the compact limit through a keyboard-focusable button", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		const groups = Array.from({ length: 4 }, (_, index) =>
			makeGroup(makeAgent({ taskId: `child-${index}`, nickname: `Agent ${index}` })),
		)
		render(<ManagedAgentTree rootTaskId="root-1" groups={groups} maxVisibleAgents={1} onShowTask={onShowTask} />)
		const overflow = screen.getByRole("button", { name: "agentNavigation.more" })
		expect(overflow).toHaveProperty("tabIndex", 0)
		expect(overflow).toHaveAttribute("type", "button")
		await user.click(overflow)
		const dialog = screen.getByRole("dialog", { name: "agentNavigation.title" })
		await user.click(within(dialog).getByRole("button", { name: /Open Agent 3/i }))
		expect(onShowTask).toHaveBeenCalledWith("child-3")
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
	})
	it("marks the displayed activity cursor and keeps human unread independent of runtime delivery", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		const projection = hierarchyProjection()
		projection.activity[0] = {
			...projection.activity[0],
			senderTaskId: "parent-1",
			recipientTaskId: "child-2",
			pendingDelivery: true,
		}
		const { rerender } = render(
			<ManagedAgentTree rootTaskId="root-1" projection={projection} isVisible={false} onShowTask={onShowTask} />,
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		await user.click(screen.getByRole("button", { name: "agentActivity.open" }))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		rerender(<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={onShowTask} />)
		const dialog = screen.getByRole("dialog", { name: "agentActivity.title" })
		expect(within(dialog).getByText("Cinder")).toBeInTheDocument()
		expect(within(dialog).getByText("agentActivity.pending")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
		await user.click(within(dialog).getByRole("button", { name: "agentActivity.markRead" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "markManagedAgentActivityRead",
			taskId: "root-1",
			activitySequence: 1,
		})
		await user.click(within(dialog).getByRole("button", { name: "agentActivity.openNamed" }))
		expect(onShowTask).toHaveBeenCalledWith("child-2")
	})

	it("disables navigation only when the host does not expose it", () => {
		render(<ManagedAgentTree rootTaskId="root-1" projection={hierarchyProjection()} />)
		expect(screen.getByRole("button", { name: /Cinder task unavailable/i })).toBeDisabled()
	})

	it("closes existing toolbar activity when the presentation changes to the dock", async () => {
		const user = userEvent.setup()
		const projection = hierarchyProjection()
		const onShowTask = vi.fn()
		const { rerender } = render(
			<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={onShowTask} />,
		)
		await user.click(screen.getByRole("button", { name: "agentActivity.open" }))
		expect(screen.getByRole("dialog", { name: "agentActivity.title" })).toBeVisible()
		rerender(
			<ManagedAgentTree
				rootTaskId="root-1"
				projection={projection}
				onShowTask={onShowTask}
				presentation="dock"
			/>,
		)
		expect(screen.queryByRole("dialog", { name: "agentActivity.title" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "agentActivity.open" })).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
		await user.click(screen.getByRole("button", { name: /Open Cinder/ }))
		expect(onShowTask).toHaveBeenCalledWith("parent-1")
		rerender(<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={onShowTask} />)
		expect(screen.queryByRole("dialog", { name: "agentActivity.title" })).not.toBeInTheDocument()
	})

	it("does not render an empty nested dock strip for activity from already represented agents", () => {
		const { container } = render(
			<ManagedAgentTree
				rootTaskId="root-1"
				projection={hierarchyProjection()}
				presentation="dock"
				excludeTaskIds={new Set(["parent-1", "child-2"])}
			/>,
		)
		expect(container).toBeEmptyDOMElement()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("retains dock overflow navigation while omitting activity", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		render(
			<ManagedAgentTree
				rootTaskId="root-1"
				projection={hierarchyProjection()}
				presentation="dock"
				maxVisibleAgents={1}
				onShowTask={onShowTask}
			/>,
		)
		expect(screen.queryByRole("button", { name: "agentActivity.open" })).not.toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "agentNavigation.more" }))
		const dialog = screen.getByRole("dialog", { name: "agentNavigation.title" })
		await user.click(within(dialog).getByRole("button", { name: /Open Iris/ }))
		expect(onShowTask).toHaveBeenCalledWith("child-2")
	})

	it("retains omitted-descendant overflow when group cards already show every known row", async () => {
		const user = userEvent.setup()
		const projection = hierarchyProjection()
		projection.activity = []
		projection.omittedNodeCount = 2
		render(
			<ManagedAgentTree
				rootTaskId="root-1"
				projection={projection}
				presentation="dock"
				excludeTaskIds={new Set(["parent-1", "child-2"])}
			/>,
		)
		expect(screen.getByRole("button", { name: "agentNavigation.more" })).toHaveTextContent("+2")
		await user.click(screen.getByRole("button", { name: "agentNavigation.more" }))
		expect(screen.getByRole("dialog", { name: "agentNavigation.title" })).toHaveTextContent(
			"agentNavigation.omitted",
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps status readable without relying on dot color", () => {
		render(<ManagedAgentTree rootTaskId="root-1" projection={hierarchyProjection()} onShowTask={vi.fn()} />)
		expect(screen.getByRole("button", { name: /Open Cinder · Working/i })).toHaveTextContent("Working")
		expect(screen.getByRole("button", { name: /Open Iris · Timed out/i })).toHaveTextContent("Timed out")
	})

	it("uses a compact spinner and readable terminal state for dock-only descendants", () => {
		render(
			<ManagedAgentTree
				rootTaskId="root-1"
				projection={hierarchyProjection()}
				onShowTask={vi.fn()}
				presentation="dock"
			/>,
		)
		const running = screen.getByRole("button", { name: /Open Cinder · Working/i })
		expect(running.querySelector(".lucide-loader-circle")).toHaveClass("motion-reduce:animate-none")
		expect(running).not.toHaveTextContent("Working")
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

	it("defers 100 overflow rows until their existing dialog mounts", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		const projection = wideProjection()
		const model = managedAgentTreeAdapter.buildManagedAgentTreeModel({ rootTaskId: "root-1", projection })
		let nicknameReads = 0
		let overflowOnlyNicknameReads = 0
		for (const [index, node] of model.nodes.entries()) {
			const nickname = node.nickname
			Object.defineProperty(node, "nickname", {
				get: () => {
					nicknameReads += 1
					if (index >= 24) overflowOnlyNicknameReads += 1
					return nickname
				},
			})
		}
		const buildModel = vi.spyOn(managedAgentTreeAdapter, "buildManagedAgentTreeModel").mockReturnValue(model)
		try {
			render(<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={onShowTask} />)
			expect(nicknameReads).toBe(24)
			expect(overflowOnlyNicknameReads).toBe(0)
			expect(screen.getAllByRole("listitem")).toHaveLength(24)

			await user.click(screen.getByRole("button", { name: "agentNavigation.more" }))
			// Opening can replay the visible strip. Off-strip rows measure only the mounted overflow pass.
			expect(overflowOnlyNicknameReads).toBe(76)
			const dialog = screen.getByRole("dialog", { name: "agentNavigation.title" })
			expect(within(dialog).getAllByRole("listitem")).toHaveLength(100)
			await user.click(within(dialog).getByRole("button", { name: /Open Agent 99/i }))
			expect(onShowTask).toHaveBeenCalledWith("child-99")
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		} finally {
			buildModel.mockRestore()
		}
	})

	it("defers hidden activity details and indexes 100 activity targets in one node pass", async () => {
		const user = userEvent.setup()
		const projection = wideProjection()
		let taskIdReads = 0
		let summaryReads = 0
		for (const node of projection.nodes) {
			const taskId = node.taskId
			Object.defineProperty(node, "taskId", {
				get: () => {
					taskIdReads += 1
					return taskId
				},
			})
		}
		for (const event of projection.activity) {
			const summary = event.summary
			Object.defineProperty(event, "summary", {
				get: () => {
					summaryReads += 1
					return summary
				},
			})
		}

		render(<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={vi.fn()} />)
		expect(summaryReads).toBe(0)
		expect(taskIdReads).toBeLessThanOrEqual(projection.nodes.length * 4)

		taskIdReads = 0
		await user.click(screen.getByRole("button", { name: "agentActivity.open" }))
		expect(summaryReads).toBe(100)
		expect(taskIdReads).toBeLessThanOrEqual(projection.nodes.length * 2)
		const dialog = screen.getByRole("dialog", { name: "agentActivity.title" })
		expect(within(dialog).getAllByRole("listitem")).toHaveLength(100)
		expect(within(dialog).getByText("Activity 99")).toBeInTheDocument()
	})

	it("refreshes mounted activity names, routing callbacks, and the displayed read cursor together", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		const updatedOnShowTask = vi.fn()
		const projection = hierarchyProjection()
		projection.activity[0] = {
			...projection.activity[0],
			senderTaskId: "parent-1",
			recipientTaskId: "child-2",
		}
		const { rerender } = render(
			<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={onShowTask} />,
		)
		await user.click(screen.getByRole("button", { name: "agentActivity.open" }))

		const refreshed = {
			...projection,
			nodes: projection.nodes.map((node) => ({ ...node, nickname: `${node.nickname} refreshed` })),
			activity: [
				{
					...projection.activity[0],
					sequence: 7,
					senderTaskId: "child-2",
					recipientTaskId: "parent-1",
					summary: "Refreshed activity",
				},
			],
		}
		rerender(<ManagedAgentTree rootTaskId="root-1" projection={refreshed} onShowTask={updatedOnShowTask} />)
		const dialog = screen.getByRole("dialog", { name: "agentActivity.title" })
		expect(within(dialog).getByText("Iris refreshed")).toBeInTheDocument()
		expect(within(dialog).getByText("Refreshed activity")).toBeInTheDocument()
		await user.click(within(dialog).getByRole("button", { name: "agentActivity.markRead" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "markManagedAgentActivityRead",
			taskId: "root-1",
			activitySequence: 7,
		})
		await user.click(within(dialog).getByRole("button", { name: "agentActivity.openNamed" }))
		expect(updatedOnShowTask).toHaveBeenCalledTimes(1)
		expect(updatedOnShowTask).toHaveBeenCalledWith("parent-1")
		expect(onShowTask).not.toHaveBeenCalled()
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
	})

	it("retains the first activity identity if a stale projection repeats a task", async () => {
		const user = userEvent.setup()
		const projection = hierarchyProjection()
		projection.nodes.push({ ...projection.nodes[0], nickname: "Duplicate root" })
		projection.activity[0] = { ...projection.activity[0], senderTaskId: "root-1", recipientTaskId: "root-1" }
		render(<ManagedAgentTree rootTaskId="root-1" projection={projection} onShowTask={vi.fn()} />)
		await user.click(screen.getByRole("button", { name: "agentActivity.open" }))
		const dialog = screen.getByRole("dialog", { name: "agentActivity.title" })
		expect(within(dialog).getByText("Release root")).toBeInTheDocument()
		expect(within(dialog).queryByText("Duplicate root")).not.toBeInTheDocument()
	})

	it.each(["agentNavigation.more", "agentActivity.open"])("resets %s when the root changes", async (buttonName) => {
		const user = userEvent.setup()
		const projection = hierarchyProjection()
		const onShowTask = vi.fn()
		const { rerender } = render(
			<ManagedAgentTree
				rootTaskId="root-1"
				projection={projection}
				maxVisibleAgents={1}
				onShowTask={onShowTask}
			/>,
		)
		await user.click(screen.getByRole("button", { name: buttonName }))
		expect(screen.getByRole("dialog")).toBeVisible()
		const otherProjection = {
			...projection,
			rootTaskId: "other-root",
			nodes: projection.nodes.map((node) => ({
				...node,
				rootTaskId: "other-root",
				taskId: node.role === "root" ? "other-root" : node.taskId,
				parentTaskId: node.parentTaskId === "root-1" ? "other-root" : node.parentTaskId,
			})),
		}
		rerender(
			<ManagedAgentTree
				rootTaskId="other-root"
				projection={otherProjection}
				maxVisibleAgents={1}
				onShowTask={onShowTask}
			/>,
		)
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(onShowTask).not.toHaveBeenCalled()
	})
})
