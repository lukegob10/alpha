import React from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { AutoApproveDropdown } from "../AutoApproveDropdown"

const mockSetters = {
	setAutoApprovalEnabled: vi.fn(),
	setAlwaysAllowReadOnly: vi.fn(),
	setAlwaysAllowReadOnlyOutsideWorkspace: vi.fn(),
	setAlwaysAllowWrite: vi.fn(),
	setAlwaysAllowWriteOutsideWorkspace: vi.fn(),
	setAlwaysAllowWriteProtected: vi.fn(),
	setAlwaysAllowExecute: vi.fn(),
	setAlwaysAllowMcp: vi.fn(),
	setAlwaysAllowModeSwitch: vi.fn(),
	setAlwaysAllowSubtasks: vi.fn(),
	setAlwaysAllowSubagents: vi.fn(),
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
		t: (key: string, options?: Record<string, unknown>) => {
			if (key === "chat:autoApprove.triggerLabel" && typeof options?.count === "number") {
				return `${options.count} auto-approved`
			}

			return key
		},
	}),
}))

vi.mock("@/components/ui/hooks/useAlphaPortal", () => ({
	useAlphaPortal: () => undefined,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		...mockState,
		...mockSetters,
	}),
}))

describe("AutoApproveDropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockState = {
			autoApprovalEnabled: false,
			allowedCommands: ["git"],
			deniedCommands: [],
			alwaysAllowReadOnly: false,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: false,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: false,
			alwaysAllowMcp: false,
			alwaysAllowModeSwitch: false,
			alwaysAllowSubtasks: false,
			alwaysAllowSubagents: false,
			alwaysAllowFollowupQuestions: false,
		}
	})

	it("enables full auto-approval from the main dropdown toggle", () => {
		render(<AutoApproveDropdown />)

		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByRole("switch", { name: "Toggle auto-approval" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({
				alwaysAllowReadOnly: true,
				alwaysAllowReadOnlyOutsideWorkspace: true,
				alwaysAllowWrite: true,
				alwaysAllowWriteOutsideWorkspace: true,
				alwaysAllowWriteProtected: true,
				alwaysAllowExecute: true,
				alwaysAllowMcp: true,
				alwaysAllowModeSwitch: true,
				alwaysAllowSubtasks: true,
				alwaysAllowSubagents: true,
				alwaysAllowFollowupQuestions: true,
				allowedCommands: ["git", "*"],
			}),
		})
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "autoApprovalEnabled", bool: true })
		expect(mockSetters.setAllowedCommands).toHaveBeenCalledWith(["git", "*"])
		expect(mockSetters.setAlwaysAllowWriteProtected).toHaveBeenCalledWith(true)
		expect(mockSetters.setAlwaysAllowSubagents).toHaveBeenCalledWith(true)
	})

	it("select all includes nested permissions and wildcard commands", () => {
		mockState.autoApprovalEnabled = true
		mockState.allowedCommands = ["*"]

		render(<AutoApproveDropdown />)

		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByRole("button", { name: "chat:autoApprove.selectAll" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({
				alwaysAllowReadOnlyOutsideWorkspace: true,
				alwaysAllowWriteOutsideWorkspace: true,
				alwaysAllowWriteProtected: true,
				allowedCommands: ["*"],
			}),
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "autoApprovalEnabled", bool: true })
	})

	it("updates the dedicated sub-agent permission from the compact menu", () => {
		mockState.autoApprovalEnabled = true

		render(<AutoApproveDropdown />)

		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("auto-approve-alwaysAllowSubagents"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { alwaysAllowSubagents: true },
		})
		expect(mockSetters.setAlwaysAllowSubagents).toHaveBeenCalledWith(true)
	})

	it("does not label a restricted command allowlist as full auto-approval", () => {
		mockState = {
			...mockState,
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: true,
			alwaysAllowWriteProtected: true,
			alwaysAllowExecute: true,
			alwaysAllowMcp: true,
			alwaysAllowModeSwitch: true,
			alwaysAllowSubtasks: true,
			alwaysAllowSubagents: true,
			alwaysAllowFollowupQuestions: true,
			allowedCommands: ["git diff", "git log"],
		}

		render(<AutoApproveDropdown />)

		expect(screen.queryAllByText("chat:autoApprove.triggerLabelAll")).toHaveLength(0)
		expect(screen.getAllByText("8 auto-approved").length).toBeGreaterThan(0)
	})

	it("does not label a wildcard with command denials as full auto-approval", () => {
		mockState = {
			...mockState,
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: true,
			alwaysAllowWriteProtected: true,
			alwaysAllowExecute: true,
			alwaysAllowMcp: true,
			alwaysAllowModeSwitch: true,
			alwaysAllowSubtasks: true,
			alwaysAllowSubagents: true,
			alwaysAllowFollowupQuestions: true,
			allowedCommands: ["*"],
			deniedCommands: ["git push"],
		}

		render(<AutoApproveDropdown />)

		expect(screen.queryAllByText("chat:autoApprove.triggerLabelAll")).toHaveLength(0)
		expect(screen.getAllByText("8 auto-approved").length).toBeGreaterThan(0)
	})

	it("does not advertise global All while the visible child has a frozen approval cap", () => {
		mockState = {
			...mockState,
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: true,
			alwaysAllowWriteProtected: true,
			alwaysAllowExecute: true,
			alwaysAllowMcp: true,
			alwaysAllowModeSwitch: true,
			alwaysAllowSubtasks: true,
			alwaysAllowSubagents: true,
			alwaysAllowFollowupQuestions: true,
			allowedCommands: ["*"],
			deniedCommands: [],
			currentTaskAutoApprovalRestricted: true,
		}

		render(<AutoApproveDropdown />)

		expect(screen.queryAllByText("chat:autoApprove.triggerLabelAll")).toHaveLength(0)
		expect(screen.getAllByText("8 auto-approved").length).toBeGreaterThan(0)
	})
})
