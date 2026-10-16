import type { ManagedAgentTreeProjection, SubagentGroupState, SubagentRunState } from "@alpha-code/types"
import userEvent from "@testing-library/user-event"
import i18next from "i18next"
import { initReactI18next } from "react-i18next"

import { render, screen } from "@/utils/test-utils"
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

	it("keeps projected descendants and activity origin labels alongside action rows", async () => {
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
		render(
			<SubagentDock groups={[group()]} projection={projected} parentTaskId="parent-1" onShowTask={onShowTask} />,
		)
		expect(screen.getByText("2 sub-agents")).toBeVisible()
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getAllByRole("button", { name: /Open Maple/ })).toHaveLength(1)
		await user.click(screen.getByRole("button", { name: /Open Iris/ }))
		expect(onShowTask).toHaveBeenCalledWith("nested-1")
		await user.click(screen.getByRole("button", { name: /Activity/ }))
		expect(screen.getByRole("dialog")).toHaveTextContent("Maple")
		expect(screen.getByRole("dialog")).toHaveTextContent("Layout result delivered")
	})

	it("supports a reloaded projection without transcript groups", async () => {
		const user = userEvent.setup()
		render(<SubagentDock groups={[]} projection={projection()} parentTaskId="parent-1" onShowTask={vi.fn()} />)
		await user.click(screen.getByRole("button", { name: "Show sub-agents" }))
		expect(screen.getByRole("button", { name: /Open Maple/ })).toBeVisible()
		expect(screen.getByRole("button", { name: /Open Iris/ })).toBeVisible()
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
		expect(screen.queryByText("1 running")).not.toBeInTheDocument()
	})
})
