import {
	TaskLifecycleState,
	TaskStatus,
	type LiveTaskMetadata,
	type ManagedAgentTreeProjection,
	type SubagentGroupState,
	type SubagentRunState,
} from "@alpha-code/types"
import userEvent from "@testing-library/user-event"
import i18next from "i18next"
import { initReactI18next } from "react-i18next"

import { render, screen, within } from "@/utils/test-utils"
import chat from "@/i18n/locales/en/chat.json"

import { SubagentDock } from "../SubagentDock"

const postMessage = vi.fn()
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: (...args: unknown[]) => postMessage(...args) } }))

const agent = (overrides: Partial<SubagentRunState> = {}): SubagentRunState => ({
	taskId: "child-1",
	nickname: "Maple",
	role: "worker",
	objective: "Improve the chat layout",
	status: "running",
	startedAt: 2,
	usage: { durationMs: 0 },
	...overrides,
})

const group = (overrides: Partial<SubagentGroupState> = {}): SubagentGroupState => ({
	groupId: "group-1",
	parentTaskId: "parent-1",
	status: "running",
	createdAt: 1,
	startedAt: 2,
	agents: [agent()],
	...overrides,
})

const waitingTask = (): LiveTaskMetadata => ({
	id: "child-1",
	status: TaskStatus.Interactive,
	lifecycle: TaskLifecycleState.Waiting,
	isActive: false,
	isStreaming: false,
	isWaitingForInput: true,
	waitingReason: "api_req_failed",
	lastUpdatedAt: 5,
	queueCount: 0,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
})

const projection = (): ManagedAgentTreeProjection => ({
	version: 1,
	rootTaskId: "parent-1",
	observedAt: 5,
	nodes: [
		{
			taskId: "child-1",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
			groupId: "group-1",
			path: "/root/maple",
			nickname: "Maple",
			role: "worker",
			objective: "Improve the chat layout",
			status: "running",
			createdAt: 1,
			updatedAt: 5,
			depth: 1,
			usage: { durationMs: 0 },
		},
		{
			taskId: "nested-1",
			parentTaskId: "child-1",
			rootTaskId: "parent-1",
			groupId: "nested-group",
			path: "/root/maple/iris",
			nickname: "Iris",
			role: "review",
			objective: "Review the layout",
			status: "completed",
			createdAt: 2,
			updatedAt: 5,
			depth: 2,
			usage: { durationMs: 0 },
		},
	],
	activity: [],
	capacity: { active: 1, queued: 0, terminal: 1, limit: 4 },
	budgets: { tokenLimit: null, costLimit: null },
	omittedNodeCount: 0,
	omittedActivityCount: 0,
})

describe("SubagentDock", () => {
	beforeAll(async () => {
		await i18next.use(initReactI18next).init({ lng: "en", resources: { en: { chat } } })
	})
	beforeEach(() => postMessage.mockReset())

	it("expands rows above the fixed toggle with the requested caret direction", async () => {
		const user = userEvent.setup()
		render(<SubagentDock groups={[group()]} parentTaskId="parent-1" />)
		const toggle = screen.getByRole("button", { name: "Show sub-agents" })
		const rows = document.getElementById(toggle.getAttribute("aria-controls")!)!
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(toggle.querySelector(".lucide-chevron-up")).toBeInTheDocument()
		expect(rows).not.toBeVisible()
		expect(rows.nextElementSibling).toBe(toggle)
		await user.click(toggle)
		expect(rows).toBeVisible()
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(toggle.querySelector(".lucide-chevron-down")).toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Hide sub-agents" }))
		expect(rows).not.toBeVisible()
		expect(toggle).toHaveAttribute("aria-expanded", "false")
	})

	it("keeps the menu centered at a fixed compact width in both states, capped by the sidebar", async () => {
		const user = userEvent.setup()
		render(
			<div style={{ width: 240 }}>
				<SubagentDock groups={[group()]} parentTaskId="parent-1" />
			</div>,
		)
		const dock = screen.getByRole("region", { name: "Sub-agents" })
		const toggle = screen.getByRole("button", { name: "Show sub-agents" })
		expect(dock).toHaveStyle({ width: "272px", maxWidth: "100%" })
		expect(dock).toHaveClass("mx-auto", "self-center", "box-border")
		expect(toggle.querySelector(".lucide-bot")).toBeInTheDocument()
		expect(within(toggle).getByText("1 running")).toHaveClass("rounded-full", "shrink-0")
		await user.click(toggle)
		expect(dock).toHaveStyle({ width: "272px", maxWidth: "100%" })
		const rows = document.getElementById(toggle.getAttribute("aria-controls")!)!
		expect(rows).toHaveClass("max-h-[min(240px,32vh)]", "overflow-y-auto", "overflow-x-hidden")
	})

	it("keeps a running-count badge alongside total count, completed rows, and direct navigation", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		const longName = "Maple coordinating a very long repository investigation"
		render(
			<SubagentDock
				groups={[
					group({
						agents: [
							agent({ nickname: longName }),
							agent({ taskId: "child-2", nickname: "Iris", status: "completed", completedAt: 5 }),
						],
					}),
				]}
				parentTaskId="parent-1"
				onShowTask={onShowTask}
			/>,
		)
		const toggle = screen.getByRole("button", { name: "Show sub-agents" })
		expect(within(toggle).getByText("2 sub-agents")).toBeVisible()
		expect(within(toggle).getByText("1 running")).toBeVisible()
		await user.click(toggle)
		const running = screen.getByRole("button", { name: new RegExp(`Open ${longName} · Working`) })
		expect(running.querySelector(".lucide-loader-circle")).toHaveClass("motion-reduce:animate-none")
		expect(within(running).queryByText("Working")).not.toBeInTheDocument()
		expect(within(running).getByText(longName)).toHaveClass("truncate", "min-w-0", "flex-1")
		const completed = screen.getByRole("button", { name: /Open Iris · Completed/ })
		expect(completed).toHaveTextContent("Completed")
		expect(completed.querySelector(".lucide-loader-circle")).not.toBeInTheDocument()
		await user.click(completed)
		expect(onShowTask).toHaveBeenCalledWith("child-2")
		await user.click(screen.getByRole("button", { name: `Actions for ${longName}` }))
		await user.click(screen.getByRole("menuitem", { name: "Open task" }))
		expect(onShowTask).toHaveBeenCalledWith("child-1")
	})

	it("counts only running agents while queued, stopping, and terminal agents retain their own row states", async () => {
		const user = userEvent.setup()
		const statuses: SubagentRunState["status"][] = [
			"running",
			"running",
			"running",
			"pending",
			"pending",
			"pending",
			"cancelling",
			"pending",
			"completed",
			"failed",
		]
		const groups = Array.from({ length: 5 }, (_, groupIndex) =>
			group({
				groupId: `group-${groupIndex}`,
				status: groupIndex === 4 ? "partial" : groupIndex === 3 ? "cancelling" : "running",
				agents: statuses.slice(groupIndex * 2, groupIndex * 2 + 2).map((status, index) =>
					agent({
						taskId: `child-${groupIndex * 2 + index}`,
						nickname: `Agent ${groupIndex * 2 + index}`,
						status,
					}),
				),
			}),
		)
		render(<SubagentDock groups={groups} parentTaskId="parent-1" />)
		const toggle = screen.getByRole("button", { name: "Show sub-agents" })
		expect(within(toggle).getByText("10 sub-agents")).toBeVisible()
		expect(within(toggle).getByText("3 running")).toBeVisible()
		expect(within(toggle).queryByText("8 running")).not.toBeInTheDocument()
		await user.click(toggle)
		for (const label of [/Open Agent 3 · Starting/, /Open Agent 6 · Stopping/]) {
			expect(
				screen.getByRole("button", { name: label }).querySelector(".lucide-loader-circle"),
			).toBeInTheDocument()
		}
		expect(screen.getByRole("button", { name: /Open Agent 8 · Completed/ })).toHaveTextContent("Completed")
		expect(screen.getByRole("button", { name: /Open Agent 9 · Failed/ })).toHaveTextContent("Failed")
	})

	it("keeps a pending approval visible while collapsed and routes review to its originating group", async () => {
		const user = userEvent.setup()
		const pending = group({
			agents: [
				agent({
					pendingApproval: {
						id: "approval-1",
						type: "command",
						operation: "pnpm test",
						scope: "webview-ui",
						createdAt: 4,
					},
				}),
			],
		})
		render(<SubagentDock groups={[pending]} parentTaskId="parent-1" />)
		expect(screen.getByText("1 approval")).toBeVisible()
		expect(screen.getByText("1 running")).toBeVisible()
		expect(screen.queryByText("pnpm test")).not.toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		await user.click(screen.getByRole("button", { name: "Actions for Maple" }))
		await user.click(screen.getByRole("menuitem", { name: "Review request" }))
		expect(screen.getByRole("dialog", { name: "Review Maple's request" })).toHaveTextContent("webview-ui")
		await user.keyboard("{Escape}")
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "respondToSubagentApproval" }))
		expect(screen.getByText("1 approval")).toBeVisible()
		await user.click(screen.getByRole("button", { name: "Actions for Maple" }))
		await user.click(screen.getByRole("menuitem", { name: "Review request" }))
		await user.click(screen.getByRole("button", { name: "Approve" }))
		expect(postMessage).toHaveBeenCalledWith({
			type: "respondToSubagentApproval",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
			approvalId: "approval-1",
			approved: true,
		})
	})

	it("selects the latest canonical group snapshot and does not repeat navigation rows", async () => {
		const user = userEvent.setup()
		const old = group({
			agents: [
				agent({ pendingApproval: { id: "old", type: "command", operation: "old command", createdAt: 3 } }),
			],
		})
		const latest = group({
			status: "completed",
			completedAt: 9,
			agents: [agent({ status: "completed", completedAt: 9 })],
		})
		render(<SubagentDock groups={[old, latest, old]} parentTaskId="parent-1" />)
		expect(screen.queryByText("1 approval")).not.toBeInTheDocument()
		expect(screen.getByText("1 sub-agent")).toBeVisible()
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getAllByRole("button", { name: /Open Maple/ })).toHaveLength(1)
		expect(screen.getByRole("button", { name: /Open Maple · Completed/ })).toBeVisible()
	})

	it("uses current host status and clears stale approval for the same group generation", async () => {
		const user = userEvent.setup()
		const stale = group({
			status: "interrupted",
			completedAt: 4,
			agents: [
				agent({
					status: "interrupted",
					completedAt: 4,
					stopReason: "interrupted",
					error: "An earlier interruption was recovered.",
					pendingApproval: { id: "old", type: "command", operation: "old command", createdAt: 3 },
				}),
			],
		})
		render(<SubagentDock groups={[stale]} projection={projection()} parentTaskId="parent-1" />)
		expect(screen.getByText("1 running")).toBeVisible()
		expect(screen.queryByText("1 approval")).not.toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		const row = screen.getByRole("button", { name: /Open Maple · Working/ })
		expect(row.querySelector(".lucide-loader-circle")).toBeInTheDocument()
		expect(screen.queryByText("Interrupted")).not.toBeInTheDocument()
		expect(screen.queryByText("An earlier interruption was recovered.")).not.toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Actions for Maple" }))
		expect(screen.queryByRole("menuitem", { name: "Review request" })).not.toBeInTheDocument()
	})

	it("closes the same-generation approval dialog when the host clears its request", async () => {
		const user = userEvent.setup()
		const pending = group({
			agents: [
				agent({ pendingApproval: { id: "approval-1", type: "command", operation: "pnpm test", createdAt: 4 } }),
			],
		})
		const projected = projection()
		projected.nodes[0].attention = { kind: "approval", label: "Waiting for command approval" }
		const { rerender } = render(<SubagentDock groups={[pending]} projection={projected} parentTaskId="parent-1" />)
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getByRole("button", { name: /Open Maple · Working · Approval required/ })).toBeVisible()
		await user.click(screen.getByRole("button", { name: "Actions for Maple" }))
		await user.click(screen.getByRole("menuitem", { name: "Review request" }))
		expect(screen.getByRole("dialog", { name: "Review Maple's request" })).toBeVisible()

		rerender(<SubagentDock groups={[pending]} projection={projection()} parentTaskId="parent-1" />)
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(screen.queryByText("Approval required")).not.toBeInTheDocument()
		expect(screen.queryByText("1 approval")).not.toBeInTheDocument()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "respondToSubagentApproval" }))
	})

	it("shows host approval attention without inventing a request ID or approval action", async () => {
		const user = userEvent.setup()
		const projected = projection()
		projected.nodes[0].attention = { kind: "approval", label: "Waiting for command approval" }
		render(<SubagentDock groups={[group()]} projection={projected} parentTaskId="parent-1" />)
		expect(screen.getByText("1 approval")).toBeVisible()
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getByRole("button", { name: /Open Maple · Working · Approval required/ })).toBeVisible()
		await user.click(screen.getByRole("button", { name: "Actions for Maple" }))
		expect(screen.queryByRole("menuitem", { name: "Review request" })).not.toBeInTheDocument()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "respondToSubagentApproval" }))
	})

	it.each([
		["pending_review", "1 change set available"],
		["conflicted", "1 conflict"],
	] as const)("keeps %s distinct in the collapsed attention summary", (status, summary) => {
		render(
			<SubagentDock
				groups={[
					group({
						agents: [
							agent({
								status: "interrupted",
								changeSet: {
									id: "change-1",
									status,
									changedFiles: ["src/index.ts"],
									createdAt: 3,
									updatedAt: 4,
								},
							}),
						],
					}),
				]}
				parentTaskId="parent-1"
			/>,
		)
		expect(screen.getByText(summary)).toBeVisible()
		expect(screen.queryByText("1 approval")).not.toBeInTheDocument()
	})

	it("preserves an older follow-up group's outcome, proposal, and action routing", async () => {
		const user = userEvent.setup()
		const reason = "The earlier run was interrupted before completion."
		const historical = group({
			groupId: "earlier-group",
			status: "interrupted",
			completedAt: 4,
			agents: [
				agent({
					status: "interrupted",
					completedAt: 4,
					error: reason,
					changeSet: {
						id: "earlier-change",
						status: "pending_review",
						changedFiles: ["src/index.ts"],
						createdAt: 3,
						updatedAt: 4,
					},
				}),
			],
		})
		render(<SubagentDock groups={[historical]} projection={projection()} parentTaskId="parent-1" />)
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		const row = screen.getByRole("button", { name: /Open Maple · Interrupted · Changes available/ })
		expect(row).toHaveAccessibleDescription(reason)
		await user.click(screen.getByRole("button", { name: "Actions for Maple" }))
		await user.click(screen.getByRole("menuitem", { name: "Open diff" }))
		expect(postMessage).toHaveBeenCalledWith({
			type: "openSubagentChangeSet",
			taskId: "parent-1",
			groupId: "earlier-group",
			changeSetId: "earlier-change",
		})
	})

	it.each(["approval", "input"] as const)(
		"keeps historical proposals separate from the current group's %s attention for the same task",
		async (kind) => {
			const user = userEvent.setup()
			const historical = group({
				groupId: "earlier-group",
				status: "interrupted",
				completedAt: 4,
				agents: [
					agent({
						status: "interrupted",
						completedAt: 4,
						error: "The earlier run was interrupted.",
						pendingApproval: {
							id: "obsolete",
							type: "command",
							operation: "earlier command",
							createdAt: 3,
						},
						changeSet: {
							id: "earlier-change",
							status: "pending_review",
							changedFiles: ["src/index.ts"],
							createdAt: 3,
							updatedAt: 4,
						},
					}),
				],
			})
			const current = group({
				agents: [
					agent({
						pendingApproval:
							kind === "approval"
								? { id: "current", type: "command", operation: "current command", createdAt: 4 }
								: undefined,
					}),
				],
			})
			const projected = projection()
			projected.nodes[0].attention = {
				kind,
				label: kind === "approval" ? "Approval required" : "Waiting for input",
			}
			render(<SubagentDock groups={[historical, current]} projection={projected} parentTaskId="parent-1" />)
			expect(screen.getByText("1 running")).toBeVisible()
			if (kind === "input") expect(screen.queryByText("1 approval")).not.toBeInTheDocument()
			await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
			const earlierRow = screen.getByRole("button", { name: /Open Maple · Interrupted · Changes available/ })
			expect(earlierRow).toHaveAccessibleDescription("The earlier run was interrupted.")
			expect(earlierRow).not.toHaveTextContent("Approval required")
			expect(earlierRow).not.toHaveTextContent("awaiting input")
			const earlierGroup = earlierRow.closest("section")!
			await user.click(within(earlierGroup).getByRole("button", { name: "Actions for Maple" }))
			expect(screen.queryByRole("menuitem", { name: "Review request" })).not.toBeInTheDocument()
			await user.click(screen.getByRole("menuitem", { name: "Open diff" }))
			expect(postMessage).toHaveBeenCalledWith({
				type: "openSubagentChangeSet",
				taskId: "parent-1",
				groupId: "earlier-group",
				changeSetId: "earlier-change",
			})
			const currentRow = screen.getByRole("button", {
				name:
					kind === "approval"
						? /Open Maple · Working · Approval required/
						: /Open Maple · Working · 1 awaiting input/,
			})
			expect(currentRow).toBeVisible()
			if (kind === "approval") {
				await user.click(
					within(currentRow.closest("section")!).getByRole("button", { name: "Actions for Maple" }),
				)
				await user.click(screen.getByRole("menuitem", { name: "Review request" }))
				expect(screen.getByRole("dialog")).toHaveTextContent("current command")
				await user.click(screen.getByRole("button", { name: "Approve" }))
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "respondToSubagentApproval",
						groupId: "group-1",
						approvalId: "current",
					}),
				)
			}
		},
	)

	it("does not replace a newer completed group boundary with an older host projection", async () => {
		const user = userEvent.setup()
		const completed = group({
			status: "completed",
			completedAt: 9,
			agents: [agent({ status: "completed", completedAt: 9 })],
		})
		render(<SubagentDock groups={[completed]} projection={projection()} parentTaskId="parent-1" />)
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getByRole("button", { name: /Open Maple · Completed/ })).toBeVisible()
		expect(screen.getByText("0 running")).toBeVisible()
	})

	it("keeps projected descendant navigation without activity controls or hidden read effects", async () => {
		const user = userEvent.setup()
		const onShowTask = vi.fn()
		const projected = projection()
		projected.activity = [
			{
				eventId: "activity-1",
				sequence: 1,
				createdAt: 5,
				kind: "result",
				name: "agent_completed",
				senderTaskId: "child-1",
				senderPath: "/root/maple",
				summary: "Layout result delivered",
				unread: true,
			},
		]
		const { rerender } = render(
			<SubagentDock groups={[group()]} projection={projected} parentTaskId="parent-1" onShowTask={onShowTask} />,
		)
		expect(screen.getByText("2 sub-agents")).toBeVisible()
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getAllByRole("button", { name: /Open Maple/ })).toHaveLength(1)
		await user.click(screen.getByRole("button", { name: /Open Iris/ }))
		expect(onShowTask).toHaveBeenCalledWith("nested-1")
		expect(screen.queryByRole("button", { name: /Activity/ })).not.toBeInTheDocument()
		expect(screen.queryByText("Layout result delivered")).not.toBeInTheDocument()
		rerender(<SubagentDock groups={[group()]} projection={projected} parentTaskId="parent-1" isVisible={false} />)
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "markManagedAgentActivityRead" }))
	})

	it("does not render an activity-only zero-agent dock", () => {
		const projected = projection()
		projected.nodes = [
			{
				...projected.nodes[0],
				taskId: "parent-1",
				path: "/root",
				role: "root",
				depth: 0,
				parentTaskId: undefined,
			},
		]
		projected.activity = [
			{
				eventId: "activity-1",
				sequence: 1,
				createdAt: 5,
				kind: "result",
				name: "agent_completed",
				summary: "Earlier result",
				unread: true,
			},
		]
		const { container } = render(<SubagentDock groups={[]} projection={projected} parentTaskId="parent-1" />)
		expect(container).toBeEmptyDOMElement()
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("supports a reloaded projection without transcript groups", async () => {
		const user = userEvent.setup()
		render(<SubagentDock groups={[]} projection={projection()} parentTaskId="parent-1" onShowTask={vi.fn()} />)
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getByRole("button", { name: /Open Maple/ })).toBeVisible()
		expect(screen.getByRole("button", { name: /Open Iris/ })).toBeVisible()
	})

	it.each(["projection", "live metadata"] as const)(
		"keeps grouped input attention from %s visible without duplicate counts or rows",
		async (source) => {
			const user = userEvent.setup()
			const projected = source === "projection" ? projection() : undefined
			if (projected) projected.nodes[0].attention = { kind: "input", label: "Waiting for user input" }
			render(
				<SubagentDock
					groups={[group()]}
					projection={projected}
					liveTasksById={{ "child-1": waitingTask() }}
					parentTaskId="parent-1"
				/>,
			)
			const toggle = screen.getByRole("button", { name: "Show sub-agents" })
			expect(within(toggle).getByText("1 awaiting input")).toBeVisible()
			expect(within(toggle).queryByText("2 awaiting input")).not.toBeInTheDocument()
			await user.click(toggle)
			const row = screen.getByRole("button", { name: /Open Maple.*awaiting input/ })
			expect(within(row).getByText("1 awaiting input")).toBeVisible()
			expect(screen.getAllByRole("button", { name: /Open Maple/ })).toHaveLength(1)
		},
	)

	it("clears grouped input attention when the canonical projection resumes before live metadata refreshes", async () => {
		const user = userEvent.setup()
		const projected = projection()
		projected.nodes[0].attention = { kind: "input", label: "Waiting for user input" }
		const props = {
			groups: [group()],
			parentTaskId: "parent-1",
			liveTasksById: { "child-1": waitingTask() },
		}
		const { rerender } = render(<SubagentDock {...props} projection={projected} />)
		const toggle = screen.getByRole("button", { name: "Show sub-agents" })
		expect(within(toggle).getByText("1 awaiting input")).toBeVisible()
		await user.click(toggle)
		expect(screen.getByRole("button", { name: /Open Maple.*awaiting input/ })).toBeVisible()

		rerender(<SubagentDock {...props} projection={projection()} />)
		expect(screen.queryByText("1 awaiting input")).not.toBeInTheDocument()
		expect(screen.getAllByRole("button", { name: /Open Maple/ })).toHaveLength(1)
		expect(screen.getByRole("button", { name: /Open Maple · Working/ })).toBeVisible()
	})

	it("preserves a newer approval request over an older grouped input hint", async () => {
		const user = userEvent.setup()
		const projected = projection()
		projected.nodes[0].attention = { kind: "input", label: "Waiting for user input" }
		render(
			<SubagentDock
				groups={[
					group({
						agents: [
							agent({
								pendingApproval: {
									id: "approval-1",
									type: "command",
									operation: "pnpm test",
									createdAt: 6,
								},
							}),
						],
					}),
				]}
				projection={projected}
				parentTaskId="parent-1"
			/>,
		)
		expect(screen.getByText("1 approval")).toBeVisible()
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getByRole("button", { name: /Open Maple.*Approval/ })).toBeVisible()
		expect(screen.queryByText("1 awaiting input")).not.toBeInTheDocument()
	})

	it.each([
		[{ kind: "approval", label: "Approval required" }, "1 approval"],
		[{ kind: "input", label: "Review changes" }, "1 awaiting input"],
		[{ kind: "input", label: "What changes should I make?" }, "1 awaiting input"],
		[{ kind: "input", label: "Waiting for input" }, "1 awaiting input"],
	] as const)("keeps projected %s attention visible while collapsed", (attention, summary) => {
		const projected = projection()
		projected.nodes[0].attention = attention
		render(<SubagentDock groups={[]} projection={projected} parentTaskId="parent-1" />)
		expect(screen.getByText(summary)).toBeVisible()
		expect(screen.getByText("1 running")).toBeVisible()
	})
})
