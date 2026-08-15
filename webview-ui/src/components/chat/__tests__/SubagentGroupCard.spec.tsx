import type { SubagentGroupState } from "@alpha-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"

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
		vi.spyOn(window, "confirm").mockReturnValue(true)
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

		expect(screen.getByText("Maple · Worker")).toBeInTheDocument()
		expect(screen.getByText("Write scope: src/parser")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /open diff/i }))
		fireEvent.click(screen.getByRole("button", { name: /apply changes/i }))

		expect(postMessage).toHaveBeenCalledWith({
			type: "openSubagentChangeSet",
			taskId: "parent-1",
			groupId: "group-1",
			changeSetId: "change-1",
		})
		expect(postMessage).toHaveBeenCalledWith({
			type: "applySubagentChangeSet",
			taskId: "parent-1",
			groupId: "group-1",
			changeSetId: "change-1",
		})
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
