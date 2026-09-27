import { fireEvent, render, screen } from "@testing-library/react"
import { ReasoningBlock } from "../ReasoningBlock"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

describe("inline thinking synopsis", () => {
	const source = "A full first paragraph.\n\nThe longer second paragraph remains available."
	const props = { content: source, ts: 1, isStreaming: true, isLast: true }

	it("shows the synopsis and full reasoning by default, and lets the reader fold it", () => {
		render(
			<ReasoningBlock
				{...props}
				summary="Checking roles against the frontend to find documentation mismatches."
			/>,
		)
		const toggle = screen.getByRole("button", { expanded: true })
		expect(toggle).toHaveTextContent("Checking roles against the frontend")
		expect(screen.getByText(/The longer second paragraph/)).toHaveTextContent(source.replace(/\s+/g, " "))
		fireEvent.click(toggle)
		expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument()
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
		expect(toggle).toHaveTextContent("Checking roles against the frontend")
	})

	it("retains expansion and the synopsis as streaming finishes", () => {
		const { rerender } = render(<ReasoningBlock {...props} summary="Checking roles." />)
		expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
		rerender(<ReasoningBlock {...props} isStreaming={false} isLast={false} summary="Checking roles and metrics." />)
		expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("Checking roles and metrics.")
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
	})

	it("keeps old traces foldable without inventing a synopsis", () => {
		render(<ReasoningBlock {...props} isStreaming={false} />)
		const toggle = screen.getByRole("button", { expanded: true })
		expect(toggle).toHaveTextContent("chat:reasoning.thinking")
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
		fireEvent.click(toggle)
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
	})
})
