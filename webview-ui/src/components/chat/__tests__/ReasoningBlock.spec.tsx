import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { ActivityStep } from "../ActivityStep"
import { ReasoningBlock } from "../ReasoningBlock"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { count: number }) =>
			key === "chat:reasoning.seconds" ? `${options?.count}s` : key,
	}),
}))
vi.mock("../ActivityStep", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ActivityStep")>()
	return { ...actual, ActivityStep: vi.fn(actual.ActivityStep) }
})
vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div data-testid="reasoning-markdown">{markdown}</div>,
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
		expect(expandedToggle).toHaveAttribute("aria-busy", "true")
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
		expect(screen.getByRole("button", { expanded: true })).toHaveAttribute("aria-busy", "true")
		expect(
			screen.getByRole("button", { expanded: true }).querySelector(".activity-step-toggle--active"),
		).not.toBeInTheDocument()
		rerender(<ReasoningBlock {...props} isStreaming={false} isLast={false} collapsedByDefault={false} />)
		expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("chat:reasoning.thinking")
		expect(screen.getByRole("button", { expanded: true })).not.toHaveAttribute("aria-busy")
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
	})

	it("restores the reader's reasoning choice after the parent turn unmounts its body", () => {
		function FoldableTurn() {
			const [visible, setVisible] = useState(true)
			const [expanded, setExpanded] = useState<boolean>()
			return (
				<>
					<button onClick={() => setVisible((value) => !value)}>Toggle turn</button>
					{visible && (
						<ReasoningBlock
							{...props}
							isStreaming={false}
							isExpanded={expanded}
							onExpandedChange={setExpanded}
						/>
					)}
				</>
			)
		}
		render(<FoldableTurn />)
		fireEvent.click(screen.getByRole("button", { expanded: false }))
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "Toggle turn" }))
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Toggle turn" }))
		expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
		expect(screen.getByText(/The longer second paragraph/)).toBeVisible()
		fireEvent.click(screen.getByRole("button", { expanded: true }))
		fireEvent.click(screen.getByRole("button", { name: "Toggle turn" }))
		fireEvent.click(screen.getByRole("button", { name: "Toggle turn" }))
		expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument()
		expect(screen.queryByText(/The longer second paragraph/)).not.toBeInTheDocument()
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

	it("updates elapsed seconds without rerendering the trace frame and cleans up its timer", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		vi.mocked(ActivityStep).mockClear()
		const { rerender, unmount } = render(<ReasoningBlock {...props} collapsedByDefault={false} />)
		try {
			const initialRenders = vi.mocked(ActivityStep).mock.calls.length
			for (let second = 0; second < 60; second++) {
				act(() => vi.advanceTimersByTime(1000))
			}
			expect(ActivityStep).toHaveBeenCalledTimes(initialRenders)
			expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("60s")
			expect(screen.getByTestId("reasoning-markdown")).toHaveTextContent(source.replace(/\s+/g, " "))
			expect(vi.getTimerCount()).toBe(1)

			rerender(<ReasoningBlock {...props} collapsedByDefault={false} isStreaming={false} />)
			expect(vi.getTimerCount()).toBe(0)
			act(() => vi.advanceTimersByTime(5000))
			expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("60s")

			rerender(<ReasoningBlock {...props} collapsedByDefault={false} />)
			expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("65s")
			expect(vi.getTimerCount()).toBe(1)
			unmount()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			unmount()
			vi.useRealTimers()
		}
	})

	it("does not inspect collapsed content during streamed updates and expands the latest trace", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const contents = Array.from({ length: 101 }, (_, index) => `${source}${" More reasoning. ".repeat(index)}`)
		const contentVersions = new Set(contents)
		const trim = vi.spyOn(String.prototype, "trim")
		const { rerender, unmount } = render(<ReasoningBlock {...props} content={contents[0]} />)
		try {
			for (const content of contents.slice(1)) {
				rerender(<ReasoningBlock {...props} content={content} />)
			}
			expect(trim.mock.contexts.filter((value) => contentVersions.has(String(value)))).toHaveLength(0)
			trim.mockRestore()
			expect(screen.queryByTestId("reasoning-markdown")).not.toBeInTheDocument()
			fireEvent.click(screen.getByRole("button", { expanded: false }))
			expect(screen.getByTestId("reasoning-markdown").textContent).toBe(contents[100])
		} finally {
			trim.mockRestore()
			unmount()
			vi.useRealTimers()
		}
	})

	it.each(["", " \n\t"])("does not mount markdown for empty reasoning %j", (content) => {
		render(<ReasoningBlock {...props} content={content} collapsedByDefault={false} isStreaming={false} />)
		expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
		expect(screen.queryByTestId("reasoning-markdown")).not.toBeInTheDocument()
	})
})
