import React from "react"
import { act, fireEvent, render, screen } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { AutoApproveDropdown } from "../AutoApproveDropdown"

const mockSetters = {
	setApprovalMode: vi.fn(),
	setApprovalModeBypassAcknowledged: vi.fn(),
	setAutoApprovalEnabled: vi.fn(),
	setAlwaysAllowReadOnly: vi.fn(),
	setAlwaysAllowReadOnlyOutsideWorkspace: vi.fn(),
	setAlwaysAllowWrite: vi.fn(),
	setAlwaysAllowWriteOutsideWorkspace: vi.fn(),
	setAlwaysAllowWriteProtected: vi.fn(),
	setAlwaysAllowExecute: vi.fn(),
	setAlwaysAllowMcp: vi.fn(),
	setAlwaysAllowSubtasks: vi.fn(),
	setAlwaysAllowSubagents: vi.fn(),
	setAlwaysAllowTickets: vi.fn(),
	setAlwaysAllowFollowupQuestions: vi.fn(),
	setAllowedCommands: vi.fn(),
}

let mockState: Record<string, any>

const latestTaskApprovalUpdate = () => {
	const request = vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0]
	if (!request || request.type !== "setTaskApprovalMode") {
		throw new Error("Expected a task-scoped approval mode request")
	}
	return request.taskApprovalModeUpdate
}

const allTaskApprovalUpdates = () =>
	vi
		.mocked(vscode.postMessage)
		.mock.calls.flatMap(([message]) =>
			message.type === "setTaskApprovalMode" ? [message.taskApprovalModeUpdate] : [],
		)

const respondToTaskApprovalRequest = (
	update: ReturnType<typeof latestTaskApprovalUpdate>,
	status: "applied" | "targetUnavailable" | "rejected",
) => {
	fireEvent(
		window,
		new MessageEvent("message", {
			data: {
				type: "taskApprovalModeUpdated",
				taskApprovalModeUpdateResult: {
					requestId: update.requestId,
					taskId: update.taskId,
					status,
					...(status === "applied" ? { approvalMode: update.approvalMode } : {}),
				},
			},
		}),
	)
}

const respondToTaskApprovalUpdate = (status: "applied" | "targetUnavailable" | "rejected") => {
	respondToTaskApprovalRequest(latestTaskApprovalUpdate(), status)
}

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui/hooks/useAlphaPortal", () => ({
	useAlphaPortal: (id: string) => document.getElementById(id) ?? undefined,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		...mockState,
		...mockSetters,
	}),
	useShellState: () => ({
		...mockState,
		...mockSetters,
	}),
}))

describe("AutoApproveDropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockState = {
			currentTaskId: "task-1",
			currentTaskApprovalMode: null,
			approvalMode: "auto",
			approvalModeBypassAcknowledged: false,
			autoApprovalEnabled: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			currentTaskAutoApprovalRestricted: false,
		}
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("shows the session dial name on the composer trigger", () => {
		render(<AutoApproveDropdown />)
		expect(screen.getAllByText("chat:autoApprove.modes.auto").length).toBeGreaterThan(0)
		expect(screen.queryByText("8 auto-approved")).not.toBeInTheDocument()
		expect(screen.queryByTestId("auto-approve-alwaysAllowReadOnly")).not.toBeInTheDocument()
	})

	it("allows draft mode selection without updating a stale current task or global settings", () => {
		mockState.currentTaskApprovalMode = "ask"
		const onDraftApprovalModeChange = vi.fn()
		const view = render(
			<AutoApproveDropdown
				isDraft
				draftApprovalMode="auto"
				onDraftApprovalModeChange={onDraftApprovalModeChange}
			/>,
		)
		const trigger = screen.getByTestId("auto-approve-dropdown-trigger")
		expect(trigger).not.toBeDisabled()
		expect(trigger).toHaveTextContent("chat:autoApprove.modes.auto")

		fireEvent.click(trigger)
		fireEvent.click(screen.getByTestId("approval-mode-ask"))
		expect(onDraftApprovalModeChange).toHaveBeenLastCalledWith("ask")
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(mockSetters.setApprovalMode).not.toHaveBeenCalled()

		view.rerender(
			<AutoApproveDropdown
				isDraft
				draftApprovalMode="ask"
				onDraftApprovalModeChange={onDraftApprovalModeChange}
			/>,
		)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-auto"))
		expect(onDraftApprovalModeChange).toHaveBeenLastCalledWith("auto")
		expect(vscode.postMessage).not.toHaveBeenCalled()

		view.rerender(
			<AutoApproveDropdown
				isDraft
				draftApprovalMode="auto"
				onDraftApprovalModeChange={onDraftApprovalModeChange}
			/>,
		)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-bypass"))
		expect(screen.getByText("chat:autoApprove.bypassWarning.title")).toBeInTheDocument()
		expect(onDraftApprovalModeChange).not.toHaveBeenCalledWith("bypass")
		fireEvent.click(screen.getByTestId("approval-mode-bypass-confirm"))
		expect(onDraftApprovalModeChange).toHaveBeenLastCalledWith("bypass")
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(mockSetters.setApprovalMode).not.toHaveBeenCalled()
	})

	it("sends Ask to the visible task and waits for its scoped result", () => {
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-ask"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "setTaskApprovalMode",
			taskApprovalModeUpdate: expect.objectContaining({
				taskId: "task-1",
				approvalMode: "ask",
			}),
		})
		expect(mockSetters.setApprovalMode).not.toHaveBeenCalled()
		expect(screen.getAllByText("chat:autoApprove.modes.auto").length).toBeGreaterThan(0)

		respondToTaskApprovalUpdate("applied")
		expect(screen.getAllByText("chat:autoApprove.modes.ask").length).toBeGreaterThan(0)
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	})

	it("requires a one-time Full Access warning before enabling Full Access", () => {
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-bypass"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByText("chat:autoApprove.bypassWarning.title")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("approval-mode-bypass-confirm"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "setTaskApprovalMode",
			taskApprovalModeUpdate: expect.objectContaining({
				taskId: "task-1",
				approvalMode: "bypass",
			}),
		})
		expect(mockSetters.setApprovalMode).not.toHaveBeenCalled()
	})

	it("skips the Full Access warning after it has been acknowledged", () => {
		mockState.approvalModeBypassAcknowledged = true
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-bypass"))

		expect(screen.queryByText("chat:autoApprove.bypassWarning.title")).not.toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "setTaskApprovalMode",
			taskApprovalModeUpdate: expect.objectContaining({ taskId: "task-1", approvalMode: "bypass" }),
		})
	})

	it("keeps the selected mode when the targeted task is unavailable", () => {
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-ask"))

		respondToTaskApprovalUpdate("targetUnavailable")

		expect(screen.getByRole("alert")).toHaveTextContent("chat:autoApprove.updateTargetUnavailable")
		expect(screen.getAllByText("chat:autoApprove.modes.auto").length).toBeGreaterThan(0)
	})

	it("correlates a malformed host rejection by request id when no usable task id is available", () => {
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-ask"))
		const update = latestTaskApprovalUpdate()

		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "taskApprovalModeUpdated",
					taskApprovalModeUpdateResult: {
						requestId: update.requestId,
						status: "rejected",
						error: "invalid",
					},
				},
			}),
		)

		expect(screen.getByRole("alert")).toHaveTextContent("chat:autoApprove.updateRejected")
		expect(screen.getAllByText("chat:autoApprove.modes.auto").length).toBeGreaterThan(0)
	})

	it("keeps an accepted mode scoped to its task when switching tasks", () => {
		const view = render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-ask"))
		respondToTaskApprovalUpdate("applied")

		mockState.currentTaskId = "task-2"
		view.rerender(<AutoApproveDropdown />)
		expect(screen.getAllByText("chat:autoApprove.modes.auto").length).toBeGreaterThan(0)

		mockState.currentTaskId = "task-1"
		view.rerender(<AutoApproveDropdown />)
		expect(screen.getAllByText("chat:autoApprove.modes.ask").length).toBeGreaterThan(0)
	})

	it("keeps another task's approval choices available while an update is pending", () => {
		const view = render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-ask"))

		const [firstUpdate] = allTaskApprovalUpdates()
		expect(firstUpdate).toMatchObject({ taskId: "task-1", approvalMode: "ask" })

		mockState.currentTaskId = "task-2"
		view.rerender(<AutoApproveDropdown />)
		const askButton = screen.getByTestId("approval-mode-ask")
		expect(askButton).not.toBeDisabled()
		fireEvent.click(askButton)

		const updates = allTaskApprovalUpdates()
		expect(updates).toHaveLength(2)
		expect(updates[1]).toMatchObject({ taskId: "task-2", approvalMode: "ask" })

		respondToTaskApprovalRequest(firstUpdate!, "applied")
		expect(screen.getByTestId("approval-mode-auto")).toBeDisabled()
		respondToTaskApprovalRequest(updates[1]!, "applied")

		mockState.currentTaskId = "task-1"
		view.rerender(<AutoApproveDropdown />)
		expect(screen.getAllByText("chat:autoApprove.modes.ask").length).toBeGreaterThan(0)
	})

	it("unlocks the current task's approval choices if the host never acknowledges an update", () => {
		vi.useFakeTimers()
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-ask"))

		expect(screen.getByTestId("approval-mode-auto")).toBeDisabled()
		act(() => {
			vi.advanceTimersByTime(15_000)
		})

		expect(screen.getByTestId("approval-mode-auto")).not.toBeDisabled()
		expect(screen.getByRole("alert")).toHaveTextContent("chat:autoApprove.updateTimedOut")
	})

	it("disables the composer selector when no task is open", () => {
		mockState.currentTaskId = undefined
		render(<AutoApproveDropdown />)
		const trigger = screen.getByTestId("auto-approve-dropdown-trigger")

		expect(trigger).toBeDisabled()
		fireEvent.click(trigger)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("does not advertise leftover chip counts while a child is narrower than the parent dial", () => {
		mockState.currentTaskAutoApprovalRestricted = true
		render(<AutoApproveDropdown />)
		expect(screen.getAllByText("chat:autoApprove.modes.auto").length).toBeGreaterThan(0)
		expect(screen.queryByText("chat:autoApprove.triggerLabelAll")).not.toBeInTheDocument()
	})
})
