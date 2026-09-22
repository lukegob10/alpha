import React from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"

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
			approvalMode: "auto",
			approvalModeBypassAcknowledged: false,
			autoApprovalEnabled: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			currentTaskAutoApprovalRestricted: false,
		}
	})

	it("shows the session dial name on the composer trigger", () => {
		render(<AutoApproveDropdown />)
		expect(screen.getAllByText("chat:autoApprove.modes.auto").length).toBeGreaterThan(0)
		expect(screen.queryByText("8 auto-approved")).not.toBeInTheDocument()
		expect(screen.queryByTestId("auto-approve-alwaysAllowReadOnly")).not.toBeInTheDocument()
	})

	it("writes Ask and derived chips together", () => {
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-ask"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({
				approvalMode: "ask",
				autoApprovalEnabled: true,
				alwaysAllowWrite: false,
				alwaysAllowWriteOutsideWorkspace: false,
				alwaysAllowExecute: false,
				alwaysAllowSubagents: false,
				alwaysAllowTickets: false,
			}),
		})
		expect(mockSetters.setApprovalMode).toHaveBeenCalledWith("ask")
	})

	it("requires a one-time Full Access warning before enabling Full Access", () => {
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-bypass"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByText("chat:autoApprove.bypassWarning.title")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("approval-mode-bypass-confirm"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({
				approvalMode: "bypass",
				approvalModeBypassAcknowledged: true,
				alwaysAllowWriteOutsideWorkspace: true,
				alwaysAllowWriteProtected: true,
				alwaysAllowMcp: true,
			}),
		})
	})

	it("skips the Full Access warning after it has been acknowledged", () => {
		mockState.approvalModeBypassAcknowledged = true
		render(<AutoApproveDropdown />)
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("approval-mode-bypass"))

		expect(screen.queryByText("chat:autoApprove.bypassWarning.title")).not.toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({ approvalMode: "bypass" }),
		})
	})

	it("does not advertise leftover chip counts while a child is narrower than the parent dial", () => {
		mockState.currentTaskAutoApprovalRestricted = true
		render(<AutoApproveDropdown />)
		expect(screen.getAllByText("chat:autoApprove.modes.auto").length).toBeGreaterThan(0)
		expect(screen.queryByText("chat:autoApprove.triggerLabelAll")).not.toBeInTheDocument()
	})
})
