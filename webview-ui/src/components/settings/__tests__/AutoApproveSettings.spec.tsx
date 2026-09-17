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

describe("outside workspace approval settings", () => {
	it("labels command inputs and adds a wildcard to the local edit buffer with Enter", () => {
		const setCachedStateField = vi.fn()
		render(
			<AutoApproveSettings
				autoApprovalEnabled
				alwaysAllowExecute
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
		expect(setCachedStateField).toHaveBeenCalledTimes(1)
		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["*"])
		expect(allowed).toHaveValue("")
	})

	it("keeps the outside read edit buffer and removes legacy outside write auto-approval", () => {
		const setCachedStateField = vi.fn()
		const props = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: true,
			setCachedStateField,
		}
		const { rerender } = render(<AutoApproveSettings {...props} />)
		const read = screen.getByTestId("always-allow-readonly-outside-workspace-checkbox")
		expect(read).toBeChecked()
		expect(screen.queryByTestId("always-allow-write-outside-workspace-checkbox")).not.toBeInTheDocument()
		fireEvent.click(read)
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowReadOnlyOutsideWorkspace", false)
		rerender(<AutoApproveSettings {...props} alwaysAllowReadOnlyOutsideWorkspace={false} />)
		expect(screen.getByTestId("always-allow-readonly-outside-workspace-checkbox")).not.toBeChecked()
	})
})
