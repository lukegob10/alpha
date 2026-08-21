import type { SubagentGroupState, SubagentRunState } from "@alpha-code/types"
import userEvent from "@testing-library/user-event"

import { act, fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import { SubagentGroupCard } from "../SubagentGroupCard"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (...args: unknown[]) => postMessage(...args) } }))

const makeGroup = (overrides: Partial<SubagentGroupState> = {}): SubagentGroupState => ({
	groupId: "group-1",
	parentTaskId: "parent-1",
	status: "running",
	createdAt: 1_000,
	startedAt: 1_100,
	agents: [
		{
			taskId: "child-1",
			nickname: "Maple",
			role: "explore",
			objective: "Map the parser lifecycle",
			status: "running",
			startedAt: 1_100,
			usage: { durationMs: 0 },
		},
		{
			taskId: "child-2",
			nickname: "Nova",
			role: "review",
			objective: "Review cancellation behavior",
			status: "pending",
			usage: { durationMs: 0 },
		},
	],
	...overrides,
})

const makeWorkerGroup = (agentOverrides: Partial<SubagentRunState> = {}): SubagentGroupState =>
	makeGroup({
		status: "completed",
		completedAt: 5_000,
		agents: [
			{
				taskId: "worker-1",
				nickname: "Maple",
				role: "worker",
				objective: "Edit the parser",
				writeScope: ["src/parser"],
				status: "completed",
				changedFiles: ["src/parser/index.ts"],
				changeSet: {
					id: "change-1",
					status: "pending_review",
					changedFiles: ["src/parser/index.ts"],
					createdAt: 4_000,
					updatedAt: 5_000,
				},
				usage: { durationMs: 3_900 },
				...agentOverrides,
			},
		],
	})

const sendChangeSetCapability = (
	allowed: boolean,
	reason: string,
	state: "available" | "busy" | "unavailable" = allowed ? "available" : "busy",
	actionOverrides: Partial<
		Record<"apply" | "discard", { allowed: boolean; state: "available" | "busy" | "unavailable"; reason: string }>
	> = {},
) => {
	const baseCapability = { allowed, state, reason }
	return act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "subagentChangeSetActionCapability",
					subagentChangeSetActionCapability: {
						taskId: "parent-1",
						groupId: "group-1",
						changeSetId: "change-1",
						allowed,
						state,
						reason,
						actions: {
							apply: baseCapability,
							discard: baseCapability,
							...actionOverrides,
						},
					},
				},
			}),
		)
	})
}

const openActions = async (user: ReturnType<typeof userEvent.setup>, nickname: string) => {
	await user.click(screen.getByRole("button", { name: `Actions for ${nickname}` }))
}

describe("SubagentGroupCard", () => {
	beforeEach(() => postMessage.mockReset())

	it("renders active agents as compact task rows without verbose trace detail", () => {
		render(<SubagentGroupCard group={makeGroup()} parentTaskId="parent-1" />)

		expect(screen.getByRole("region", { name: "2 sub-agent tasks" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /Open Maple · Working/i })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /Open Nova · Starting/i })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /expand|collapse sub-agent/i })).not.toBeInTheDocument()
		expect(screen.queryByText("Map the parser lifecycle")).not.toBeInTheDocument()
		expect(screen.queryByText(/tokens|pacing|write scope|isolated worktree/i)).not.toBeInTheDocument()
	})

	it("opens running, queued, and terminal agents with the exact task id", async () => {
		const user = userEvent.setup()
		const completed = makeGroup({
			status: "completed",
			agents: [{ ...makeGroup().agents[0], status: "completed", completedAt: 2_000 }, makeGroup().agents[1]],
		})
		render(<SubagentGroupCard group={completed} parentTaskId="parent-1" />)

		await user.click(screen.getByRole("button", { name: /Open Maple/i }))
		await user.click(screen.getByRole("button", { name: /Open Nova/i }))
		expect(postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-1" })
		expect(postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-2" })
	})

	it("keeps group cancellation in a compact overflow menu", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeGroup()} parentTaskId="parent-1" />)

		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Stop all" }))
		expect(postMessage).toHaveBeenCalledWith({
			type: "cancelSubagentGroup",
			taskId: "parent-1",
			groupId: "group-1",
		})
	})

	it("sends a bounded, trimmed steering instruction from the agent menu", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeGroup()} parentTaskId="parent-1" />)
		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Steer" }))

		const textarea = screen.getByRole("textbox", { name: "Steering instruction for Maple" })
		fireEvent.change(textarea, { target: { value: `  ${"x".repeat(2_050)}  ` } })
		await user.click(screen.getByRole("button", { name: "Send steering" }))

		expect(postMessage).toHaveBeenCalledWith({
			type: "steerSubagent",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
			text: "x".repeat(2_000),
		})
	})

	it("cancels one active agent without cancelling its sibling", async () => {
		const user = userEvent.setup()
		const runningAgent = makeGroup().agents[0]
		const { rerender } = render(<SubagentGroupCard group={makeGroup()} parentTaskId="parent-1" />)
		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Stop" }))

		expect(postMessage).toHaveBeenCalledWith({
			type: "cancelSubagent",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
		})
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ subagentTaskId: "child-2" }))

		rerender(
			<SubagentGroupCard
				group={makeGroup({
					status: "completed",
					agents: [{ ...runningAgent, status: "cancelled", completedAt: 2_000 }],
				})}
				parentTaskId="parent-1"
			/>,
		)
		rerender(<SubagentGroupCard group={makeGroup({ agents: [runningAgent] })} parentTaskId="parent-1" />)
		await openActions(user, "Maple")
		expect(screen.getByRole("menuitem", { name: "Stop" })).not.toHaveAttribute("data-disabled")
	})

	it("only offers steering once an agent is running", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeGroup()} parentTaskId="parent-1" />)
		await openActions(user, "Nova")
		expect(screen.queryByRole("menuitem", { name: "Steer" })).not.toBeInTheDocument()
	})

	it.each([
		["failed", "Failed"],
		["blocked", "Blocked"],
		["interrupted", "Interrupted"],
		["timed_out", "Timed out"],
		["cancelled", "Cancelled"],
	] as const)("keeps %s status visible and accessible", (status, label) => {
		render(
			<SubagentGroupCard
				group={makeGroup({
					status: status === "blocked" ? "failed" : status,
					agents: [{ ...makeGroup().agents[0], status }],
				})}
				parentTaskId="parent-1"
			/>,
		)
		expect(screen.getByRole("button", { name: new RegExp(`Open Maple · ${label}`, "i") })).toHaveTextContent(label)
	})

	it("shows a truthful unavailable state for a prepared child that never launched", async () => {
		const user = userEvent.setup()
		const error =
			"The prepared sub-agent was never launched before the extension reloaded. Start a new spawn request to retry."
		render(
			<SubagentGroupCard
				group={makeGroup({
					status: "cancelled",
					agents: [
						{
							...makeGroup().agents[1],
							nickname: "approval_child",
							status: "cancelled",
							stopReason: "never_launched",
							error,
							completedAt: 2_000,
						},
					],
				})}
				parentTaskId="parent-1"
			/>,
		)

		const task = screen.getByRole("button", { name: /approval_child task unavailable · Cancelled/i })
		expect(task).toBeDisabled()
		expect(screen.getByText(error)).toBeVisible()
		expect(screen.queryByRole("button", { name: "Actions for approval_child" })).not.toBeInTheDocument()

		await user.click(task)
		expect(postMessage).not.toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-2" })
	})

	it("shows review attention while keeping Worker internals out of the trace", () => {
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)

		expect(screen.getByRole("button", { name: /Open Maple · Completed · Review/i })).toHaveTextContent("Review")
		expect(screen.queryByText("src/parser/index.ts")).not.toBeInTheDocument()
		expect(screen.queryByText("src/parser")).not.toBeInTheDocument()
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "requestSubagentChangeSetActionCapability",
				taskId: "parent-1",
				groupId: "group-1",
				changeSetId: "change-1",
			}),
		)
	})

	it("routes diff review and confirms Apply from the overflow menu", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		sendChangeSetCapability(true, "Ready")
		await openActions(user, "Maple")

		await user.click(screen.getByRole("menuitem", { name: "Open diff" }))
		expect(postMessage).toHaveBeenCalledWith({
			type: "openSubagentChangeSet",
			taskId: "parent-1",
			groupId: "group-1",
			changeSetId: "change-1",
		})

		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Apply changes" }))
		expect(screen.getByRole("dialog", { name: "Apply Worker changes?" })).toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Confirm apply" }))
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "applySubagentChangeSet",
				taskId: "parent-1",
				groupId: "group-1",
				changeSetId: "change-1",
				requestId: expect.stringMatching(/^apply:change-1:/),
			}),
		)
	})

	it("provider capability disables mutation actions during active parent work", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		sendChangeSetCapability(false, "Pause the parent first")
		await openActions(user, "Maple")

		expect(screen.getByRole("menuitem", { name: "Apply changes" })).toHaveAttribute("data-disabled")
		expect(screen.getByRole("menuitem", { name: "Discard" })).toHaveAttribute("data-disabled")
		expect(screen.getByText("Pause the parent first")).toBeInTheDocument()
	})

	it("keeps Discard available when a terminal parent can no longer Apply", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		sendChangeSetCapability(false, "The parent task has already completed.", "unavailable", {
			discard: {
				allowed: true,
				state: "available",
				reason: "The completed parent can still discard this quarantined proposal.",
			},
		})
		await openActions(user, "Maple")

		expect(screen.getByRole("menuitem", { name: "Apply changes" })).toHaveAttribute("data-disabled")
		expect(screen.getByRole("menuitem", { name: "Discard" })).not.toHaveAttribute("data-disabled")
		expect(screen.getByText("Apply unavailable: The parent task has already completed.")).toBeInTheDocument()

		await user.click(screen.getByRole("menuitem", { name: "Discard" }))
		expect(screen.getByRole("dialog", { name: "Discard Worker changes?" })).toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Confirm discard" }))
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "discardSubagentChangeSet",
				taskId: "parent-1",
				groupId: "group-1",
				changeSetId: "change-1",
				requestId: expect.stringMatching(/^discard:change-1:/),
			}),
		)
	})

	it("revalidates provider capability before confirming an external mutation", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		sendChangeSetCapability(true, "Ready")
		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Apply changes" }))

		sendChangeSetCapability(false, "The parent resumed work")

		expect(screen.getByRole("button", { name: "Confirm apply" })).toBeDisabled()
		expect(screen.getByRole("status")).toHaveTextContent("The parent resumed work")
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "applySubagentChangeSet" }))
	})

	it("prevents duplicate Apply while a provider request is pending and surfaces failure", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		sendChangeSetCapability(true, "Ready")
		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Apply changes" }))
		await user.click(screen.getByRole("button", { name: "Confirm apply" }))

		const applyRequest = postMessage.mock.calls
			.map(([message]) => message as { type?: string; requestId?: string })
			.find((message) => message.type === "applySubagentChangeSet")
		expect(applyRequest?.requestId).toBeDefined()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "subagentChangeSetActionResult",
						requestId: "stale-request",
						subagentChangeSetActionResult: {
							action: "apply",
							taskId: "parent-1",
							groupId: "group-1",
							changeSetId: "change-1",
							success: false,
							message: "Stale result must be ignored.",
						},
					},
				}),
			)
		})
		expect(screen.queryByText("Stale result must be ignored.")).not.toBeInTheDocument()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "subagentChangeSetActionResult",
						requestId: applyRequest!.requestId,
						subagentChangeSetActionResult: {
							action: "apply",
							taskId: "parent-1",
							groupId: "group-1",
							changeSetId: "change-1",
							success: false,
							message: "Parent files changed; review the conflict.",
						},
					},
				}),
			)
		})

		expect(screen.getByRole("alert")).toHaveTextContent("Parent files changed")
		expect(
			postMessage.mock.calls.filter(
				([message]) => (message as { type?: string }).type === "applySubagentChangeSet",
			),
		).toHaveLength(1)
	})

	it("cancels Discard confirmation without submitting it", async () => {
		const user = userEvent.setup()
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		sendChangeSetCapability(true, "Ready")
		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Discard" }))
		await user.click(screen.getByRole("button", { name: "Cancel" }))

		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "Discard Worker changes?" })).not.toBeInTheDocument(),
		)
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "discardSubagentChangeSet" }))
	})

	it("keeps command approval behind an explicit compact attention flow", async () => {
		const user = userEvent.setup()
		const group = makeGroup({
			agents: [
				{
					...makeGroup().agents[0],
					pendingApproval: {
						id: "approval-1",
						type: "command",
						operation: "pnpm test --filter core",
						scope: "workspace",
						createdAt: 2_000,
					},
				},
			],
		})
		render(<SubagentGroupCard group={group} parentTaskId="parent-1" />)

		expect(screen.getByRole("button", { name: /Open Maple · Working · Approval/i })).toHaveTextContent("Approval")
		expect(screen.queryByText("pnpm test --filter core")).not.toBeInTheDocument()
		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Review request" }))
		expect(screen.getByRole("dialog", { name: "Review Maple's request" })).toHaveTextContent(
			"pnpm test --filter core",
		)
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

	it("closes an approval dialog when a newer snapshot resolves the request", async () => {
		const user = userEvent.setup()
		const pendingAgent = {
			...makeGroup().agents[0],
			pendingApproval: {
				id: "approval-1",
				type: "command" as const,
				operation: "pnpm test",
				createdAt: 2_000,
			},
		}
		const { rerender } = render(
			<SubagentGroupCard group={makeGroup({ agents: [pendingAgent] })} parentTaskId="parent-1" />,
		)
		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Review request" }))

		rerender(
			<SubagentGroupCard
				group={makeGroup({ agents: [{ ...pendingAgent, pendingApproval: undefined }] })}
				parentTaskId="parent-1"
			/>,
		)

		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "Review Maple's request" })).not.toBeInTheDocument(),
		)
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "respondToSubagentApproval" }))
	})

	it("closes steering when the selected agent is no longer running", async () => {
		const user = userEvent.setup()
		const runningAgent = makeGroup().agents[0]
		const { rerender } = render(
			<SubagentGroupCard group={makeGroup({ agents: [runningAgent] })} parentTaskId="parent-1" />,
		)
		await openActions(user, "Maple")
		await user.click(screen.getByRole("menuitem", { name: "Steer" }))

		rerender(
			<SubagentGroupCard
				group={makeGroup({
					status: "completed",
					agents: [{ ...runningAgent, status: "completed", completedAt: 3_000 }],
				})}
				parentTaskId="parent-1"
			/>,
		)

		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Steer Maple" })).not.toBeInTheDocument())
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "steerSubagent" }))
	})
})
