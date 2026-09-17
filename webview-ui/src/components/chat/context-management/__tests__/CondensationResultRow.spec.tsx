import { render, screen } from "@testing-library/react"
import { CondensationResultRow } from "../CondensationResultRow"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../../Markdown", () => ({ Markdown: () => <div>Summary details</div> }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

it("presents an unchanged result as information without a success heading or summary expander", () => {
	render(
		<CondensationResultRow
			data={{ outcome: "unchanged", cost: 0, prevContextTokens: 800, newContextTokens: 800, summary: "" }}
		/>,
	)
	expect(screen.getByRole("status")).toHaveTextContent("chat:contextManagement.condensation.unchanged")
	expect(screen.getByRole("status")).toHaveTextContent("800")
	expect(screen.queryByText("chat:contextManagement.condensation.title")).not.toBeInTheDocument()
	expect(screen.queryByText("Summary details")).not.toBeInTheDocument()
})

it("continues rendering saved successful events without an outcome field", () => {
	render(
		<CondensationResultRow
			data={{ cost: 0, prevContextTokens: 800, newContextTokens: 200, summary: "Saved summary" }}
		/>,
	)
	expect(screen.getByText("chat:contextManagement.condensation.title")).toBeInTheDocument()
})
