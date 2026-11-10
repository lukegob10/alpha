import { render, screen, fireEvent, waitFor, within } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import settingsLocale from "@/i18n/locales/en/settings.json"
import { AutoApproveSettings } from "../AutoApproveSettings"

function translateSetting(key: string, values: Record<string, string> = {}) {
	let translation: unknown = settingsLocale
	for (const segment of key.replace(/^settings:/, "").split(".")) {
		if (typeof translation !== "object" || translation === null) return key
		translation = Reflect.get(translation, segment)
	}
	return typeof translation === "string"
		? translation.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match)
		: key
}

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: translateSetting }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translateSetting }) }))
vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({
		children,
		section,
		settingId,
	}: {
		children: React.ReactNode
		section: string
		settingId: string
	}) => (
		<div data-setting-id={settingId} data-setting-section={section}>
			{children}
		</div>
	),
}))
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	return {
		...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
		VSCodeCheckbox: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
			<label>
				<input type="checkbox" {...props} />
				{children}
			</label>
		),
	}
})

function openAdvanced() {
	fireEvent.click(screen.getByText(translateSetting("settings:autoApprove.advanced")))
}

function openHelp(label: string) {
	fireEvent.click(screen.getByRole("button", { name: translateSetting("settings:helpFor", { label }) }))
}

describe("AutoApproveSettings session dial", () => {
	it.each(["ask", "auto", "bypass"] as const)("omits confirmation-limit controls in %s", (approvalMode) => {
		const setCachedStateField = vi.fn()
		render(<AutoApproveSettings approvalMode={approvalMode} setCachedStateField={setCachedStateField} />)
		openAdvanced()

		expect(screen.queryByRole("textbox", { name: "Requests between confirmations" })).not.toBeInTheDocument()
		expect(
			screen.queryByRole("textbox", { name: "Reported API cost between confirmations" }),
		).not.toBeInTheDocument()
		expect(screen.queryByTestId("max-requests-input")).not.toBeInTheDocument()
		expect(screen.queryByTestId("max-cost-input")).not.toBeInTheDocument()
		expect(screen.getByLabelText(settingsLocale.autoApprove.execute.deniedCommands)).toBeVisible()
		expect(screen.getByRole("checkbox", { name: settingsLocale.autoApprove.mcp.label })).toBeVisible()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("keeps command restrictions, protected files, and MCP changes in the settings edit buffer", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="auto"
				alwaysAllowWriteProtected={false}
				alwaysAllowMcp={false}
				deniedCommands={[]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		const denied = screen.getByLabelText(settingsLocale.autoApprove.execute.deniedCommands)
		fireEvent.change(denied, { target: { value: "git push" } })
		fireEvent.keyDown(denied, { key: "Enter" })
		fireEvent.click(screen.getByTestId("always-allow-write-protected-checkbox"))
		fireEvent.click(screen.getByRole("checkbox", { name: settingsLocale.autoApprove.mcp.label }))
		expect(setCachedStateField.mock.calls).toEqual([
			["deniedCommands", ["git push"]],
			["alwaysAllowWriteProtected", true],
			["alwaysAllowMcp", true],
		])
	})

	it.each(["ask", "auto", "bypass"] as const)(
		"keeps permission guidance out of the main page in %s",
		(approvalMode) => {
			render(<AutoApproveSettings embedded approvalMode={approvalMode} setCachedStateField={vi.fn()} />)

			expect(screen.queryByText(settingsLocale.autoApprove.mode.description)).not.toBeInTheDocument()
			for (const candidate of ["ask", "auto", "bypass"] as const) {
				expect(
					screen.queryByText(settingsLocale.autoApprove.mode[`${candidate}Description`]),
				).not.toBeInTheDocument()
				expect(screen.getByTestId(`approval-mode-${candidate}`)).toBeVisible()
			}
			openAdvanced()
			expect(screen.queryByText(settingsLocale.autoApprove.advancedDescription)).not.toBeInTheDocument()
		},
	)

	it("uses Preferences search metadata with an inline Permissions heading when embedded", () => {
		const { container } = render(<AutoApproveSettings embedded approvalMode="auto" setCachedStateField={vi.fn()} />)

		expect(
			screen.getByRole("heading", { name: translateSetting("settings:preferences.permissions"), level: 4 }),
		).toBeVisible()
		expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument()
		for (const setting of container.querySelectorAll("[data-setting-id]")) {
			expect(setting).toHaveAttribute("data-setting-section", "preferences")
		}
	})

	it("keeps the default mode visible and advanced permissions collapsed", () => {
		render(<AutoApproveSettings approvalMode="auto" setCachedStateField={vi.fn()} />)

		expect(screen.getByTestId("approval-mode-ask")).toBeVisible()
		expect(screen.getByTestId("approval-mode-auto")).toBeVisible()
		expect(screen.getByTestId("approval-mode-bypass")).toBeVisible()
		expect(
			screen.getByText(translateSetting("settings:autoApprove.advanced")).closest("details"),
		).not.toHaveAttribute("open")
		expect(screen.getByTestId("always-allow-write-protected-checkbox")).not.toBeVisible()
		openAdvanced()
		expect(screen.getByTestId("always-allow-write-protected-checkbox")).toBeVisible()
	})

	it("keeps advanced command guidance in help without changing saved permissions", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="ask"
				inheritedCommandRules={[
					{ source: "workspace", allowedCommands: ["pnpm test"], deniedCommands: ["git push"] },
				]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		for (const description of [
			settingsLocale.autoApprove.execute.allowedCommandsDescription,
			settingsLocale.autoApprove.execute.deniedCommandsDescription,
			settingsLocale.autoApprove.execute.inheritedRulesDescription,
		]) {
			expect(screen.queryByText(description)).not.toBeInTheDocument()
		}
		expect(screen.getByText(settingsLocale.autoApprove.mcp.description)).not.toBeVisible()

		openHelp(settingsLocale.autoApprove.execute.deniedCommands)
		expect(
			within(screen.getByRole("dialog")).getByText(settingsLocale.autoApprove.execute.deniedCommandsDescription),
		).toBeVisible()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("lets Full Access users choose indefinite question waiting in the edit buffer", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<AutoApproveSettings
				approvalMode="bypass"
				followupAutoApproveTimeoutMs={60_000}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		const checkbox = screen.getByRole("checkbox", {
			name: settingsLocale.autoApprove.followupQuestions.waitLabel,
		})
		expect(checkbox).not.toBeChecked()
		expect(checkbox).toHaveAccessibleDescription(
			/Require an answer before the agent continues, including in Full Access/,
		)
		fireEvent.click(checkbox)
		expect(setCachedStateField).toHaveBeenCalledTimes(1)
		expect(setCachedStateField).toHaveBeenCalledWith("followupAutoApproveTimeoutMs", 0)

		rerender(
			<AutoApproveSettings
				approvalMode="bypass"
				followupAutoApproveTimeoutMs={0}
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(checkbox).toBeChecked()
		expect(
			screen.queryByLabelText(settingsLocale.autoApprove.followupQuestions.timeoutLabel),
		).not.toBeInTheDocument()
		fireEvent.click(checkbox)
		expect(setCachedStateField).toHaveBeenLastCalledWith("followupAutoApproveTimeoutMs", 60_000)
	})

	it.each(["ask", "auto"] as const)("keeps question preferences saved but hidden in %s", (approvalMode) => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<AutoApproveSettings
				approvalMode={approvalMode}
				followupAutoApproveTimeoutMs={180_000}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		expect(screen.queryByTestId("wait-for-question-answers-checkbox")).not.toBeInTheDocument()
		expect(
			screen.queryByLabelText(settingsLocale.autoApprove.followupQuestions.timeoutLabel),
		).not.toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()

		rerender(
			<AutoApproveSettings
				approvalMode="bypass"
				followupAutoApproveTimeoutMs={180_000}
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(
			screen.getByRole("spinbutton", { name: settingsLocale.autoApprove.followupQuestions.timeoutLabel }),
		).toHaveValue(180)
	})

	it("defaults to waiting for answers and preserves that preference when changing approval modes", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="bypass"
				approvalModeBypassAcknowledged
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		expect(
			screen.getByRole("checkbox", { name: settingsLocale.autoApprove.followupQuestions.waitLabel }),
		).toBeChecked()
		fireEvent.click(screen.getByTestId("approval-mode-auto"))
		expect(setCachedStateField).toHaveBeenCalledWith("approvalMode", "auto")
		expect(setCachedStateField).not.toHaveBeenCalledWith("followupAutoApproveTimeoutMs", expect.anything())
	})

	it("edits an automatic question delay in seconds without accepting invalid delays", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="bypass"
				followupAutoApproveTimeoutMs={60_000}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		const input = screen.getByRole("spinbutton", {
			name: settingsLocale.autoApprove.followupQuestions.timeoutLabel,
		})
		expect(input).toHaveValue(60)
		fireEvent.change(input, { target: { value: "180" } })
		expect(setCachedStateField).toHaveBeenCalledTimes(1)
		expect(setCachedStateField).toHaveBeenCalledWith("followupAutoApproveTimeoutMs", 180_000)
		for (const value of ["", "0", "-1", "2147484"]) {
			fireEvent.change(input, { target: { value } })
		}
		expect(setCachedStateField).toHaveBeenCalledTimes(1)
	})

	it("shows Auto's protected-file and deny controls without ineffective allow rules or leftover chips", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="auto"
				alwaysAllowWriteProtected={false}
				allowedCommands={[]}
				deniedCommands={[]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()

		expect(screen.getByTestId("approval-mode-ask")).toBeInTheDocument()
		expect(screen.getByTestId("approval-mode-auto")).toBeInTheDocument()
		expect(screen.getByTestId("approval-mode-bypass")).toBeInTheDocument()
		expect(screen.getByTestId("always-allow-write-protected-checkbox")).toBeInTheDocument()
		expect(screen.getByTestId("denied-commands-heading")).toBeInTheDocument()
		expect(screen.queryByTestId("allowed-commands-heading")).not.toBeInTheDocument()
		expect(screen.queryByTestId("always-allow-write-toggle")).not.toBeInTheDocument()
		expect(screen.queryByTestId("always-allow-tickets-toggle")).not.toBeInTheDocument()
		expect(screen.queryByTestId("always-allow-write-outside-workspace-checkbox")).not.toBeInTheDocument()
	})

	it("writes the selected mode and derived chips into the settings edit buffer", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="ask"
				allowedCommands={[]}
				deniedCommands={[]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		fireEvent.click(screen.getByTestId("approval-mode-auto"))
		expect(setCachedStateField).toHaveBeenCalledWith("approvalMode", "auto")
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowWrite", true)
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowWriteOutsideWorkspace", false)
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowTickets", true)
	})

	it("keeps Full Access behind its acknowledgement before changing the edit buffer", () => {
		const setCachedStateField = vi.fn()
		render(<AutoApproveSettings approvalMode="auto" setCachedStateField={setCachedStateField} />)

		fireEvent.click(screen.getByTestId("approval-mode-bypass"))
		expect(screen.getByRole("alertdialog")).toHaveAccessibleName(settingsLocale.autoApprove.bypassWarning.title)
		expect(setCachedStateField).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: settingsLocale.autoApprove.bypassWarning.cancel }))
		expect(setCachedStateField).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("approval-mode-bypass"))
		fireEvent.click(screen.getByTestId("approval-mode-bypass-confirm"))
		expect(setCachedStateField).toHaveBeenCalledWith("approvalMode", "bypass")
		expect(setCachedStateField).toHaveBeenCalledWith("approvalModeBypassAcknowledged", true)
	})

	it.each(["Cancel", "Escape"] as const)(
		"restores Full Access focus after %s without changing the previous mode",
		async (dismissal) => {
			const restoreFocus = installNativeTestFocus()
			const user = userEvent.setup()
			try {
				const setCachedStateField = vi.fn()
				render(<AutoApproveSettings approvalMode="auto" setCachedStateField={setCachedStateField} />)
				const fullAccess = screen.getByTestId("approval-mode-bypass")
				await user.click(fullAccess)
				const dialog = screen.getByRole("alertdialog")
				const cancel = within(dialog).getByRole("button", {
					name: settingsLocale.autoApprove.bypassWarning.cancel,
				})
				expect(cancel).toHaveFocus()
				if (dismissal === "Cancel") await user.click(cancel)
				else await user.keyboard("{Escape}")
				await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
				await waitFor(() => expect(fullAccess).toHaveFocus())
				expect(screen.getByTestId("approval-mode-auto")).toHaveAttribute("aria-pressed", "true")
				expect(fullAccess).toHaveAttribute("aria-pressed", "false")
				expect(setCachedStateField).not.toHaveBeenCalled()
			} finally {
				restoreFocus()
			}
		},
	)

	it("labels command inputs and adds a wildcard to the local edit buffer with Enter", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="ask"
				allowedCommands={[]}
				deniedCommands={[]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		const allowed = screen.getByLabelText(settingsLocale.autoApprove.execute.allowedCommands)
		const denied = screen.getByLabelText(settingsLocale.autoApprove.execute.deniedCommands)
		expect(allowed).not.toBe(denied)
		fireEvent.change(allowed, { target: { value: " * " } })
		fireEvent.keyDown(allowed, { key: "Enter" })
		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["*"])
		expect(allowed).toHaveValue("")
	})

	it.each(["ask", "auto", "bypass"] as const)("retains deny rules in %s", (approvalMode) => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode={approvalMode}
				deniedCommands={["git push"]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		expect(screen.getByLabelText(settingsLocale.autoApprove.execute.deniedCommands)).toBeVisible()
		fireEvent.click(screen.getByTestId("remove-denied-command-0"))
		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", [])
	})

	it("hides command allow rules in Full Access without changing the saved rules", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="bypass"
				allowedCommands={["git status"]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		expect(screen.queryByLabelText(settingsLocale.autoApprove.execute.allowedCommands)).not.toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("shows inherited command rules with their source and no removal action", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="ask"
				allowedCommands={["git status"]}
				inheritedCommandRules={[
					{ source: "workspace", allowedCommands: ["pnpm test"], deniedCommands: ["git push"] },
				]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		const rules = screen.getByRole("region", {
			name: translateSetting("settings:autoApprove.execute.inheritedRules"),
		})
		expect(
			within(rules).getByText(translateSetting("settings:autoApprove.execute.inheritedSourceWorkspace")),
		).toBeVisible()
		expect(within(rules).getByText("pnpm test")).toBeVisible()
		expect(within(rules).getByText("git push")).toBeVisible()
		expect(within(rules).queryByRole("button", { name: /pnpm test|git push/ })).not.toBeInTheDocument()
		expect(within(rules).queryByRole("textbox")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("remove-command-0"))
		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", [])
		expect(setCachedStateField).not.toHaveBeenCalledWith("allowedCommands", ["pnpm test"])
	})

	it.each(["auto", "bypass"] as const)("shows only effective inherited deny rules in %s", (approvalMode) => {
		render(
			<AutoApproveSettings
				approvalMode={approvalMode}
				inheritedCommandRules={[
					{ source: "user", allowedCommands: ["git status"], deniedCommands: [] },
					{ source: "workspace", allowedCommands: ["pnpm test"], deniedCommands: ["git push"] },
				]}
				setCachedStateField={vi.fn()}
			/>,
		)
		openAdvanced()
		const rules = screen.getByRole("region", {
			name: translateSetting("settings:autoApprove.execute.inheritedRules"),
		})
		expect(within(rules).queryByText("git status")).not.toBeInTheDocument()
		expect(within(rules).queryByText("pnpm test")).not.toBeInTheDocument()
		expect(within(rules).getByText("git push")).toBeVisible()
	})

	it("explains each permission mode on request without granting authority", () => {
		const setCachedStateField = vi.fn()
		render(<AutoApproveSettings approvalMode="auto" setCachedStateField={setCachedStateField} />)

		expect(screen.queryByText(/eligible bounded managed-agent launches/)).not.toBeInTheDocument()
		openHelp(settingsLocale.autoApprove.mode.label)
		const help = screen.getByRole("dialog")
		for (const candidate of ["ask", "auto", "bypass"] as const) {
			expect(within(help).getByText(settingsLocale.autoApprove.mode[`${candidate}Description`])).toBeVisible()
		}
		expect(within(help).getByText(/eligible bounded managed-agent launches/)).toBeInTheDocument()
		expect(
			within(help).getByText(/delegation follows your requests and applicable project or skill instructions/),
		).toBeInTheDocument()
		expect(within(help).getByText(/Approval settings do not enable delegation by themselves/)).toBeInTheDocument()
		expect(within(help).getByText(/child authority stays within the parent's policy/)).toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it.each([false, undefined, true])("shows Full Access's effective MCP override for saved value %s", (grant) => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="bypass"
				alwaysAllowMcp={grant}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()

		const checkbox = screen.getByRole("checkbox", { name: settingsLocale.autoApprove.mcp.label })
		expect(checkbox).toBeChecked()
		expect(checkbox).toBeDisabled()
		expect(checkbox).toHaveAccessibleDescription(/Full Access auto-approves valid MCP tool calls/)
		fireEvent.click(checkbox)
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it.each(["ask", "auto"] as const)("keeps the saved MCP option editable in %s", (approvalMode) => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<AutoApproveSettings
				approvalMode={approvalMode}
				alwaysAllowMcp={false}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()

		const checkbox = screen.getByRole("checkbox", { name: settingsLocale.autoApprove.mcp.label })
		expect(checkbox).not.toBeChecked()
		expect(checkbox).not.toBeDisabled()
		fireEvent.click(checkbox)
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowMcp", true)
		rerender(
			<AutoApproveSettings
				approvalMode={approvalMode}
				alwaysAllowMcp={true}
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(checkbox).toBeChecked()
		fireEvent.click(checkbox)
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowMcp", false)
	})
})
