import type { SubagentGroupState, SubagentRunState } from "@alpha-code/types"

import { act, fireEvent, render, screen } from "@/utils/test-utils"

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
) =>
	act(() => {
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
					},
				},
			}),
		)
	})

describe("SubagentGroupCard", () => {
	beforeEach(() => postMessage.mockReset())

	it("renders active agents expanded with aggregate progress and cancellation", () => {
		render(<SubagentGroupCard group={makeGroup()} parentTaskId="parent-1" />)

		expect(screen.getByRole("region", { name: "2 sub-agents" })).toBeInTheDocument()
		expect(screen.getByText("0/2 finished", { exact: false })).toBeInTheDocument()
		expect(screen.getByText("Maple · Explorer")).toBeInTheDocument()
		expect(screen.getByText("Nova · Reviewer")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Cancel sub-agent group" }))
		expect(postMessage).toHaveBeenCalledWith({
			type: "cancelSubagentGroup",
			taskId: "parent-1",
			groupId: "group-1",
		})
	})

	it("preserves a manual collapse choice across live state updates", () => {
		const { rerender } = render(<SubagentGroupCard group={makeGroup()} />)
		fireEvent.click(screen.getByRole("button", { name: "Collapse sub-agent group" }))
		expect(screen.queryByText("Maple · Explorer")).not.toBeInTheDocument()

		const updated = makeGroup({
			agents: makeGroup().agents.map((agent, index) =>
				index === 0 ? { ...agent, status: "completed", summary: "Parser mapped" } : agent,
			),
		})
		rerender(<SubagentGroupCard group={updated} />)

		expect(screen.getByRole("button", { name: "Expand sub-agent group" })).toBeInTheDocument()
		expect(screen.queryByText("Maple · Explorer")).not.toBeInTheDocument()
	})

	it("sends a bounded, trimmed steering instruction to the selected running agent", () => {
		render(<SubagentGroupCard group={makeGroup()} parentTaskId="parent-1" />)

		fireEvent.click(screen.getByRole("button", { name: "Steer Maple" }))

		expect(screen.getByRole("dialog", { name: "Steer Maple" })).toBeInTheDocument()
		const instruction = screen.getByRole("textbox", { name: "Steering instruction for Maple" })
		expect(instruction).toHaveAttribute("maxlength", "2000")
		expect(screen.getByRole("button", { name: "Send steering" })).toBeDisabled()

		fireEvent.change(instruction, { target: { value: "   Focus on parser cancellation boundaries.   " } })
		fireEvent.click(screen.getByRole("button", { name: "Send steering" }))

		expect(postMessage).toHaveBeenCalledWith({
			type: "steerSubagent",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
			text: "Focus on parser cancellation boundaries.",
		})
		expect(screen.queryByRole("dialog", { name: "Steer Maple" })).not.toBeInTheDocument()
	})

	it("cancels one active agent without cancelling its sibling", () => {
		render(<SubagentGroupCard group={makeGroup()} parentTaskId="parent-1" />)

		fireEvent.click(screen.getByRole("button", { name: "Cancel Maple" }))

		expect(postMessage).toHaveBeenCalledWith({
			type: "cancelSubagent",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
		})
		expect(screen.getByRole("button", { name: "Cancelling Maple" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Cancel Nova" })).toBeEnabled()
	})

	it("only offers steering once an agent is running", () => {
		render(<SubagentGroupCard group={makeGroup()} />)

		expect(screen.getByRole("button", { name: "Steer Maple" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Steer Nova" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Cancel Nova" })).toBeInTheDocument()
	})

	it("reopens completed groups collapsed and exposes completed transcripts", () => {
		const group = makeGroup({
			status: "completed",
			completedAt: 5_000,
			agents: makeGroup().agents.map((agent) => ({
				...agent,
				status: "completed",
				summary: `${agent.nickname} findings`,
				completedAt: 5_000,
				usage: { durationMs: 3_900 },
			})),
		})
		render(<SubagentGroupCard group={group} />)

		expect(screen.queryByText("Maple · Explorer")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))
		fireEvent.click(screen.getByRole("button", { name: "Open transcript for Maple" }))

		expect(postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-1" })
	})

	it("shows configured pacing waits in terminal agent performance", () => {
		const group = makeGroup({
			status: "completed",
			completedAt: 25_000,
			agents: [
				{
					...makeGroup().agents[0],
					status: "completed",
					completedAt: 25_000,
					usage: {
						durationMs: 24_000,
						rateLimitWaitCount: 2,
						rateLimitWaitMs: 20_000,
						rateLimitIntervalSeconds: 10,
					},
				},
			],
		})
		render(<SubagentGroupCard group={group} />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))

		expect(screen.getByText("Configured request pacing: 2 pacing waits · 20s")).toBeInTheDocument()
	})

	it("shows terminal failure reasons and an interrupted retry path", () => {
		const group = makeGroup({
			status: "interrupted",
			completedAt: 5_000,
			agents: [
				{
					...makeGroup().agents[0],
					status: "interrupted",
					error: "Extension reloaded",
					completedAt: 5_000,
				},
			],
		})
		render(<SubagentGroupCard group={group} />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))

		expect(screen.getByText("Extension reloaded")).toBeInTheDocument()
		expect(screen.getByText(/run this delegation again/i)).toBeInTheDocument()
	})

	it("shows a blocked agent as an expected terminal outcome", () => {
		const group = makeGroup({
			status: "failed",
			completedAt: 5_000,
			agents: [
				{
					...makeGroup().agents[0],
					status: "blocked",
					summary: "The requested artifact is not present in the repository.",
					completedAt: 5_000,
				},
			],
		})
		render(<SubagentGroupCard group={group} />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))

		expect(screen.getByLabelText("blocked")).toBeInTheDocument()
		expect(screen.getByText("The requested artifact is not present in the repository.")).toBeInTheDocument()
	})

	it("shows the prepared profile and an explicit parent fallback warning", () => {
		const group = makeGroup({
			agents: [
				{
					...makeGroup().agents[0],
					modelRoute: {
						source: "role",
						resolution: "fallback",
						profileId: "parent-id",
						profileName: "Parent",
						provider: "anthropic",
						modelId: "parent-model",
						requestedProfileId: "deleted-id",
						fallbackReason: "missing",
					},
				},
			],
		})

		render(<SubagentGroupCard group={group} />)

		expect(screen.getByText(/Using parent profile/)).toHaveTextContent(
			"Using parent profile · Parent · anthropic · parent-model",
		)
	})

	it.each([
		["starting" as const, "Starting"],
		["working" as const, "Working"],
		["waiting" as const, "Configured request delay"],
		["steering" as const, "Applying steering"],
		["reporting" as const, "Preparing report"],
		["finalizing" as const, "Finalizing"],
	])("renders the %s lifecycle phase without changing terminal status", (phase, label) => {
		const group = makeGroup({
			agents: [
				{
					...makeGroup().agents[0],
					status: "running",
					phase,
					phaseStartedAt: 1_200,
				},
			],
		})
		render(<SubagentGroupCard group={group} />)

		expect(screen.getByText(label)).toBeInTheDocument()
		expect(screen.getByLabelText(label)).toBeInTheDocument()
	})

	it("renders a host-confirmed cancelling state and disables repeated cancellation", () => {
		const group = makeGroup({
			agents: [
				{
					...makeGroup().agents[0],
					status: "cancelling",
					phase: "working",
				},
			],
		})

		render(<SubagentGroupCard group={group} />)

		expect(screen.getByLabelText("cancelling")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Cancelling Maple" })).toBeDisabled()
		expect(screen.queryByRole("button", { name: "Steer Maple" })).not.toBeInTheDocument()
	})

	it("renders worker scope, routes approvals, and exposes quarantined change actions", () => {
		const group = makeGroup({
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
					verification: [{ label: "Targeted tests", status: "passed" }],
					changeSet: {
						id: "change-1",
						status: "pending_review",
						changedFiles: ["src/parser/index.ts"],
						createdAt: 4_000,
						updatedAt: 5_000,
					},
					usage: { durationMs: 3_900 },
				},
			],
		})
		render(<SubagentGroupCard group={group} parentTaskId="parent-1" />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))
		sendChangeSetCapability(true, "The parent is paused for your review.")

		expect(screen.getByText("Maple · Worker")).toBeInTheDocument()
		expect(screen.getByText("Write scope: src/parser")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /open diff/i }))
		fireEvent.click(screen.getByRole("button", { name: /apply changes/i }))
		expect(screen.getByRole("dialog", { name: "Apply Worker changes?" })).toBeInTheDocument()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "applySubagentChangeSet" }))
		fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }))

		expect(postMessage).toHaveBeenCalledWith({
			type: "openSubagentChangeSet",
			taskId: "parent-1",
			groupId: "group-1",
			changeSetId: "change-1",
		})
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "applySubagentChangeSet",
				taskId: "parent-1",
				groupId: "group-1",
				changeSetId: "change-1",
				requestId: expect.any(String),
			}),
		)
	})

	it("uses the provider capability to disable Apply during active parent work", () => {
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))
		sendChangeSetCapability(false, "Wait for the parent command to finish.")

		expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled()
		expect(screen.getByRole("button", { name: /discard/i })).toBeDisabled()
		expect(screen.getByText("Wait for the parent command to finish.")).toBeInTheDocument()
	})

	it("shows pending state and prevents duplicate Apply submissions", () => {
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))
		sendChangeSetCapability(true, "The parent is paused for your review.")

		const apply = screen.getByRole("button", { name: "Apply changes" })
		fireEvent.click(apply)
		const confirm = screen.getByRole("button", { name: "Confirm apply" })
		fireEvent.click(confirm)
		fireEvent.click(confirm)

		expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled()
		expect(
			postMessage.mock.calls.filter(
				([message]) => (message as { type?: string }).type === "applySubagentChangeSet",
			),
		).toHaveLength(1)
	})

	it("surfaces a provider Apply error inline", () => {
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))
		sendChangeSetCapability(true, "The parent is paused for your review.")
		fireEvent.click(screen.getByRole("button", { name: "Apply changes" }))
		fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }))
		const request = postMessage.mock.calls
			.map(([message]) => message as { type?: string; requestId?: string })
			.find((message) => message.type === "applySubagentChangeSet")!

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "subagentChangeSetActionResult",
						requestId: request.requestId,
						subagentChangeSetActionResult: {
							action: "apply",
							taskId: "parent-1",
							groupId: "group-1",
							changeSetId: "change-1",
							success: false,
							changeSetStatus: "conflicted",
							message: "Parent files changed; review the conflict.",
						},
					},
				}),
			)
		})

		expect(screen.getByRole("alert")).toHaveTextContent("Parent files changed")
		expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled()
	})

	it("cancels Discard confirmation without submitting it", () => {
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))
		sendChangeSetCapability(true, "The parent is paused for your review.")

		fireEvent.click(screen.getByRole("button", { name: "Discard" }))
		expect(screen.getByRole("dialog", { name: "Discard Worker changes?" })).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "discardSubagentChangeSet" }))
	})

	it.each([
		["required" as const, "Review required", "Review the Worker diff"],
		["pending" as const, "Verification pending", "names at least one applied file"],
		["failed" as const, "Verification failed", "Fix the issue"],
		["satisfied" as const, "Verified", "completion is unblocked"],
	])("renders actionable parent verification state %s", (status, label, nextAction) => {
		const applied = status === "required" ? "pending_review" : "applied"
		const group = makeWorkerGroup({
			changeSet: {
				id: "change-1",
				status: applied,
				changedFiles: ["src/parser/index.ts"],
				createdAt: 4_000,
				updatedAt: 5_000,
			},
			parentVerification: {
				status,
				blocking: status === "pending" || status === "failed",
				obligationCount: 1,
				unresolvedCount: status === "satisfied" ? 0 : 1,
				changeSetId: "change-1",
				updatedAt: 5_000,
				message: label,
			},
		})
		render(<SubagentGroupCard group={group} parentTaskId="parent-1" />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))

		expect(screen.getByText(label)).toBeInTheDocument()
		expect(screen.getByText(new RegExp(nextAction, "i"))).toBeInTheDocument()
	})

	it("surfaces worker command approval with accessible approve and deny controls", () => {
		const group = makeGroup({
			agents: [
				{
					...makeGroup().agents[0],
					role: "worker",
					writeScope: ["src"],
					pendingApproval: {
						id: "approval-1",
						type: "command",
						operation: "pnpm test parser",
						createdAt: 2_000,
					},
				},
			],
		})
		render(<SubagentGroupCard group={group} parentTaskId="parent-1" />)
		fireEvent.click(screen.getByRole("button", { name: "Approve Maple request: pnpm test parser" }))
		expect(screen.getByRole("button", { name: "Deny Maple request: pnpm test parser" })).toBeInTheDocument()

		expect(postMessage).toHaveBeenCalledWith({
			type: "respondToSubagentApproval",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
			approvalId: "approval-1",
			approved: true,
		})
	})
})
