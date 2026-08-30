import React from "react"
import { render, screen } from "@testing-library/react"

import { Markdown } from "../Markdown"

vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div data-testid="markdown-content">{markdown}</div>,
}))

vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback: vi.fn() }),
}))

vi.mock("@src/components/ui", () => ({
	StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe("Markdown proposed-plan rendering", () => {
	it("renders an exact proposed-plan block as a dedicated surface without exposing protocol tags", () => {
		render(<Markdown markdown={"<proposed_plan>\n# Provider plan\n- Update selection\n</proposed_plan>"} />)

		expect(screen.getByLabelText("Proposed plan")).toBeInTheDocument()
		expect(screen.getByTestId("markdown-content")).toHaveTextContent("# Provider plan - Update selection")
		expect(screen.queryByText(/<proposed_plan>/)).not.toBeInTheDocument()
	})

	it("supports a streaming proposed-plan block and leaves ordinary markdown unchanged", () => {
		const { rerender } = render(<Markdown markdown={"<proposed_plan>\n# Streaming plan"} partial />)
		expect(screen.getByLabelText("Proposed plan")).toBeInTheDocument()
		expect(screen.getByTestId("markdown-content")).toHaveTextContent("# Streaming plan")

		rerender(<Markdown markdown="# Ordinary response" />)
		expect(screen.queryByLabelText("Proposed plan")).not.toBeInTheDocument()
		expect(screen.getByTestId("markdown-content")).toHaveTextContent("# Ordinary response")
	})
})
