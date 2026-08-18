import type { SubagentGroupState, SubagentRunState } from "@alpha-code/types"
import { act, fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import { SubagentGroupCard } from "../SubagentGroupCard"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (...args: unknown[]) => postMessage(...args) } }))

const originalFocusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")
const originalActiveElementDescriptor = Object.getOwnPropertyDescriptor(document, "activeElement")

const installFunctionalFocus = () => {
	document.body.removeAttribute("tabindex")
	Object.defineProperty(HTMLElement.prototype, "focus", {
		configurable: true,
		value(this: HTMLElement) {
			Object.defineProperty(document, "activeElement", {
				configurable: true,
				get: () => this,
			})
		},
	})
	Object.defineProperty(document, "activeElement", {
		configurable: true,
		get: () => document.body,
	})
}

const restoreTestFocus = () => {
	document.body.removeAttribute("tabindex")
	if (originalFocusDescriptor) {
		Object.defineProperty(HTMLElement.prototype, "focus", originalFocusDescriptor)
	}
	if (originalActiveElementDescriptor) {
		Object.defineProperty(document, "activeElement", originalActiveElementDescriptor)
	} else {
		Reflect.deleteProperty(document, "activeElement")
	}
}

const makeWorkerGroup = (agentOverrides: Partial<SubagentRunState> = {}): SubagentGroupState => ({
	groupId: "worker-regression-group",
	parentTaskId: "parent-1",
	status: "completed",
	createdAt: 1_000,
	startedAt: 1_100,
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

const sendChangeSetCapability = (allowed: boolean, reason: string) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "subagentChangeSetActionCapability",
					subagentChangeSetActionCapability: {
						taskId: "parent-1",
						groupId: "worker-regression-group",
						changeSetId: "change-1",
						allowed,
						state: allowed ? "available" : "busy",
						reason,
					},
				},
			}),
		)
	})

describe("SubagentGroupCard Worker regressions", () => {
	beforeEach(() => {
		postMessage.mockReset()
		installFunctionalFocus()
	})
	afterEach(restoreTestFocus)

	it("preserves the completion gate across Apply and parent-verification transitions", () => {
		const { rerender } = render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)
		fireEvent.click(screen.getByRole("button", { name: "Expand sub-agent group" }))
		sendChangeSetCapability(true, "The parent is paused for your review.")

		fireEvent.click(screen.getByRole("button", { name: "Apply changes" }))
		expect(screen.getByRole("dialog", { name: "Apply Worker changes?" })).toBeInTheDocument()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "applySubagentChangeSet" }))
		fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }))

		const applyRequests = postMessage.mock.calls
			.map(([message]) => message as { type?: string; requestId?: string })
			.filter((message) => message.type === "applySubagentChangeSet")
		expect(applyRequests).toHaveLength(1)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "subagentChangeSetActionResult",
						requestId: applyRequests[0].requestId,
						subagentChangeSetActionResult: {
							action: "apply",
							taskId: "parent-1",
							groupId: "worker-regression-group",
							changeSetId: "change-1",
							success: true,
							changeSetStatus: "applied",
							message: "Changes applied; parent verification is required.",
						},
					},
				}),
			)
		})
		expect(screen.getByText("Changes applied; parent verification is required.")).toBeInTheDocument()

		rerender(
			<SubagentGroupCard
				group={makeWorkerGroup({
					changeSet: {
						id: "change-1",
						status: "applied",
						changedFiles: ["src/parser/index.ts"],
						createdAt: 4_000,
						updatedAt: 6_000,
					},
					parentVerification: {
						status: "pending",
						blocking: true,
						obligationCount: 1,
						unresolvedCount: 1,
						changeSetId: "change-1",
						updatedAt: 6_000,
						message: "Parent verification is required before completion.",
					},
				})}
				parentTaskId="parent-1"
			/>,
		)

		expect(screen.getByText("Verification pending")).toBeInTheDocument()
		expect(screen.getByText(/names at least one applied file/i)).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Apply changes" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Open transcript for Maple" })).toBeEnabled()

		rerender(
			<SubagentGroupCard
				group={makeWorkerGroup({
					changeSet: {
						id: "change-1",
						status: "applied",
						changedFiles: ["src/parser/index.ts"],
						createdAt: 4_000,
						updatedAt: 7_000,
					},
					parentVerification: {
						status: "satisfied",
						blocking: false,
						obligationCount: 1,
						unresolvedCount: 0,
						changeSetId: "change-1",
						updatedAt: 7_000,
						message: "Parent verification passed.",
					},
				})}
				parentTaskId="parent-1"
			/>,
		)

		expect(screen.getByText("Verified")).toBeInTheDocument()
		expect(screen.getByText(/completion is unblocked/i)).toBeInTheDocument()
	})

	it("keeps Worker review controls focusable and restores review focus after Escape", async () => {
		render(<SubagentGroupCard group={makeWorkerGroup()} parentTaskId="parent-1" />)

		const expand = screen.getByRole("button", { name: "Expand sub-agent group" })
		expand.focus()
		fireEvent.click(expand)
		expect(screen.getByRole("button", { name: "Collapse sub-agent group" })).toHaveFocus()

		sendChangeSetCapability(true, "The parent is paused for your review.")
		const openDiff = screen.getByRole("button", { name: "Open diff" })
		const apply = screen.getByRole("button", { name: "Apply changes" })
		expect(openDiff).toHaveProperty("tabIndex", 0)
		expect(apply).toHaveProperty("tabIndex", 0)
		expect(openDiff.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		apply.focus()
		fireEvent.click(apply)

		const dialog = screen.getByRole("dialog", { name: "Apply Worker changes?" })
		expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
		expect(screen.getByRole("button", { name: "Confirm apply" })).toHaveProperty("tabIndex", 0)
		expect(dialog).toContainElement(document.activeElement as HTMLElement)
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "applySubagentChangeSet" }))

		fireEvent.keyDown(document, { key: "Escape", code: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Apply Worker changes?" })).not.toBeInTheDocument()
			expect(apply).toHaveFocus()
		})
		expect(apply).toBeEnabled()
		expect(apply).toHaveFocus()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "applySubagentChangeSet" }))
	})
})
