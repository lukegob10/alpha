import { render, screen, fireEvent } from "@/utils/test-utils"
import settingsLocale from "@/i18n/locales/en/settings.json"
import { AutoApproveSettings } from "../AutoApproveSettings"

function translateSetting(key: string) {
	let translation: unknown = settingsLocale
	for (const segment of key.replace(/^settings:/, "").split(".")) {
		if (typeof translation !== "object" || translation === null) return key
		translation = Reflect.get(translation, segment)
	}
	return typeof translation === "string" ? translation : key
}

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: translateSetting }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translateSetting }) }))
vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const { forwardRef } = await import("react")
	return {
		...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
		VSCodeCheckbox: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
			<label>
				<input type="checkbox" {...props} />
				{children}
			</label>
		),
		VSCodeTextField: forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => {
			const inputProps = { ...props }
			delete inputProps.children
			return <input type="text" {...inputProps} ref={ref} />
		}),
	}
})

describe("AutoApproveSettings session dial", () => {
	it.each(["ask", "auto", "bypass"] as const)(
		"lets %s users choose indefinite question waiting in the edit buffer",
		(approvalMode) => {
			const setCachedStateField = vi.fn()
			const { rerender } = render(
				<AutoApproveSettings
					approvalMode={approvalMode}
					followupAutoApproveTimeoutMs={60_000}
					setCachedStateField={setCachedStateField}
				/>,
			)
			const checkbox = screen.getByRole("checkbox", {
				name: settingsLocale.autoApprove.followupQuestions.waitLabel,
			})
			expect(checkbox).not.toBeChecked()
			expect(checkbox).toHaveAccessibleDescription(/until you answer, including in Full Access/)
			fireEvent.click(checkbox)
			expect(setCachedStateField).toHaveBeenCalledTimes(1)
			expect(setCachedStateField).toHaveBeenCalledWith("followupAutoApproveTimeoutMs", 0)

			rerender(
				<AutoApproveSettings
					approvalMode={approvalMode}
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
		},
	)

	it("defaults to waiting for answers and preserves that preference when changing approval modes", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="auto"
				approvalModeBypassAcknowledged
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(
			screen.getByRole("checkbox", { name: settingsLocale.autoApprove.followupQuestions.waitLabel }),
		).toBeChecked()
		fireEvent.click(screen.getByTestId("approval-mode-bypass"))
		expect(setCachedStateField).toHaveBeenCalledWith("approvalMode", "bypass")
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

	it("shows Ask / Auto / Full Access and nested command rules without leftover chips", () => {
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

		expect(screen.getByTestId("approval-mode-ask")).toBeInTheDocument()
		expect(screen.getByTestId("approval-mode-auto")).toBeInTheDocument()
		expect(screen.getByTestId("approval-mode-bypass")).toBeInTheDocument()
		expect(screen.getByTestId("always-allow-write-protected-checkbox")).toBeInTheDocument()
		expect(screen.getByTestId("denied-commands-heading")).toBeInTheDocument()
		expect(screen.getByTestId("allowed-commands-heading")).toBeInTheDocument()
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

	it("labels command inputs and adds a wildcard to the local edit buffer with Enter", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				approvalMode="auto"
				allowedCommands={[]}
				deniedCommands={[]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		const allowed = screen.getByLabelText(settingsLocale.autoApprove.execute.allowedCommands)
		const denied = screen.getByLabelText(settingsLocale.autoApprove.execute.deniedCommands)
		expect(allowed).not.toBe(denied)
		fireEvent.change(allowed, { target: { value: " * " } })
		fireEvent.keyDown(allowed, { key: "Enter" })
		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["*"])
		expect(allowed).toHaveValue("")
	})

	it("describes eligible managed-agent launches separately from delegation eligibility and child authority", () => {
		const setCachedStateField = vi.fn()
		render(<AutoApproveSettings approvalMode="auto" setCachedStateField={setCachedStateField} />)

		expect(screen.getByText(/eligible bounded managed-agent launches/)).toBeInTheDocument()
		expect(screen.getByText(/explicit-only or proactive delegation/)).toBeInTheDocument()
		expect(screen.getByText(/child authority stays within the parent's policy/)).toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("labels requests and reported cost as task confirmation checkpoints with distinct accessible inputs", () => {
		render(<AutoApproveSettings approvalMode="auto" setCachedStateField={vi.fn()} />)

		const requests = screen.getByRole("textbox", { name: "Requests between confirmations" })
		const cost = screen.getByRole("textbox", { name: "Reported API cost between confirmations" })
		expect(requests).not.toBe(cost)
		expect(requests).toHaveAccessibleDescription(/Blank values \(or 0 cost\) mean unlimited/)
		expect(cost).toHaveAccessibleDescription(/Cost is checked after usage is reported and may exceed the amount/)
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
		fireEvent.click(screen.getByText(settingsLocale.autoApprove.advancedMcp))

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
		fireEvent.click(screen.getByText(settingsLocale.autoApprove.advancedMcp))

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
