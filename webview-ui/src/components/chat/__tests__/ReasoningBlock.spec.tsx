import { fireEvent, render, screen } from "@testing-library/react"
import { ReasoningBlock } from "../ReasoningBlock"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

describe("thinking trace", () => {
	const source = "A full first paragraph.\n\nThe longer second paragraph remains available."
	const props = { content: source, ts: 1, isStreaming: true, isLast: true }

	it("shows only the Thinking label while reasoning is collapsed by default", () => {
		render(<ReasoningBlock {...props} />)
		const toggle = screen.getByRole("button", { expanded: false })
		expect(toggle).toHaveTextContent("chat:reasoning.thinking")
		expect(toggle).toHaveAttribute("aria-busy", "true")
		expect(toggle.querySelector(".activity-step-toggle--active")).toBeInTheDocument()
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
		fireEvent.click(toggle)
		const expandedToggle = screen.getByRole("button", { expanded: true })
		expect(expandedToggle).not.toHaveAttribute("aria-busy")
		expect(expandedToggle.querySelector(".activity-step-toggle--active")).not.toBeInTheDocument()
		expect(screen.getByText(/The longer second paragraph/)).toHaveTextContent(source.replace(/\s+/g, " "))
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-busy", "true")
		expect(toggle.querySelector(".activity-step-toggle--active")).toBeInTheDocument()
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
		expect(toggle).toHaveTextContent("chat:reasoning.thinking")
	})

	it("preserves an explicit expanded preference and disables activity when finished", () => {
		const { rerender } = render(<ReasoningBlock {...props} collapsedByDefault={false} />)
		expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
		expect(screen.getByRole("button", { expanded: true })).not.toHaveAttribute("aria-busy")
		expect(
			screen.getByRole("button", { expanded: true }).querySelector(".activity-step-toggle--active"),
		).not.toBeInTheDocument()
		rerender(<ReasoningBlock {...props} isStreaming={false} isLast={false} collapsedByDefault={false} />)
		expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("chat:reasoning.thinking")
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
	})

	it("keeps old traces foldable", () => {
		render(<ReasoningBlock {...props} isStreaming={false} />)
		const toggle = screen.getByRole("button", { expanded: false })
		expect(toggle).toHaveTextContent("chat:reasoning.thinking")
		expect(toggle).not.toHaveAttribute("aria-busy")
		expect(toggle.querySelector(".activity-step-toggle--active")).not.toBeInTheDocument()
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
		fireEvent.click(toggle)
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
	})
})
