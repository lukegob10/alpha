import { render, screen, fireEvent } from "@/utils/test-utils"
import { AutoApproveSettings } from "../AutoApproveSettings"

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
	VSCodeCheckbox: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
}))

describe("AutoApproveSettings session dial", () => {
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
		const allowed = screen.getByLabelText("settings:autoApprove.execute.allowedCommands")
		const denied = screen.getByLabelText("settings:autoApprove.execute.deniedCommands")
		expect(allowed).not.toBe(denied)
		fireEvent.change(allowed, { target: { value: " * " } })
		fireEvent.keyDown(allowed, { key: "Enter" })
		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["*"])
		expect(allowed).toHaveValue("")
	})
})
