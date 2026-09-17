import { fireEvent, render, screen } from "@testing-library/react"
import { ReasoningBlock } from "../ReasoningBlock"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

describe("inline thinking synopsis", () => {
	const source = "A full first paragraph.\n\nThe longer second paragraph remains available."
	const props = { content: source, ts: 1, isStreaming: true, isLast: true }

	it("shows the synopsis in the trace and expands the unmodified source", () => {
		render(
			<ReasoningBlock
				{...props}
				summary="Checking roles against the frontend to find documentation mismatches."
			/>,
		)
		const toggle = screen.getByRole("button", { expanded: false })
		expect(toggle).toHaveTextContent("Checking roles against the frontend")
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
		expect(screen.getByText(/The longer second paragraph/)).toHaveTextContent(source.replace(/\s+/g, " "))
		fireEvent.click(toggle)
		expect(toggle).toHaveTextContent("Checking roles against the frontend")
	})

	it("retains expansion and the synopsis as streaming finishes", () => {
		const { rerender } = render(<ReasoningBlock {...props} summary="Checking roles." />)
		fireEvent.click(screen.getByRole("button"))
		rerender(<ReasoningBlock {...props} isStreaming={false} isLast={false} summary="Checking roles and metrics." />)
		expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("Checking roles and metrics.")
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
	})

	it("keeps old traces expandable without inventing a synopsis", () => {
		render(<ReasoningBlock {...props} isStreaming={false} />)
		expect(screen.getByRole("button")).toHaveTextContent("chat:reasoning.thinking")
		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
	})
})
