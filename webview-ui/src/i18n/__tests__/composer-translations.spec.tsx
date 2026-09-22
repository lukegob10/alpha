import { memo } from "react"
import { act, render, screen } from "@/utils/test-utils"

import { AutoApproveDropdown } from "@/components/chat/AutoApproveDropdown"
import { ReasoningSelector } from "@/components/reasoning/ReasoningSelector"
import TranslationProvider from "../TranslationContext"
import i18n from "../setup"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/components/ui/hooks/useAlphaPortal", () => ({ useAlphaPortal: () => document.body }))
vi.mock("@/context/ExtensionStateContext", () => {
	const extensionState = {
		language: "en",
		autoApprovalEnabled: true,
		allowedCommands: ["*"],
		deniedCommands: [],
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: true,
		alwaysAllowWrite: true,
		alwaysAllowWriteOutsideWorkspace: true,
		alwaysAllowWriteProtected: true,
		alwaysAllowExecute: true,
		alwaysAllowMcp: true,
		alwaysAllowSubtasks: true,
		alwaysAllowSubagents: true,
		alwaysAllowTickets: true,
		alwaysAllowFollowupQuestions: true,
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
	}

	return {
		useExtensionState: () => extensionState,
		useShellState: () => extensionState,
	}
})

const ComposerControls = memo(function ComposerControls() {
	return (
		<>
			<ReasoningSelector
				scopeKey="task/profile"
				onChange={vi.fn()}
				state={{
					requested: { kind: "effort", effort: "high" },
					effective: { kind: "effort", effort: "high" },
					capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: true },
				}}
			/>
			<AutoApproveDropdown />
		</>
	)
})

describe("composer translations with real locale resources", () => {
	it("uses the short None label", () => {
		expect(i18n.t("chat:reasoning.none", { lng: "en" })).toBe("None")
	})

	beforeEach(async () => {
		await i18n.changeLanguage("en")
	})

	it.each([
		["reasoning-trigger", "High"],
		["auto-approve-dropdown-trigger", "Auto"],
	])("translates %s without the app provider", (testId, expected) => {
		render(<ComposerControls />)

		expect(screen.getByTestId(testId).textContent).toBe(expected)
	})

	it("keeps English labels when a removed locale is requested", async () => {
		render(
			<TranslationProvider>
				<ComposerControls />
			</TranslationProvider>,
		)

		expect(screen.getByTestId("reasoning-trigger")).toHaveTextContent(/^High$/)
		await act(async () => {
			await i18n.changeLanguage("de")
		})
		expect(screen.getByTestId("reasoning-trigger")).toHaveTextContent(/^High$/)
		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toHaveTextContent(/^Auto$/)
	})
})
