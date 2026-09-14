import { useState } from "react"
import { act, fireEvent, render, screen } from "@/utils/test-utils"

import { UserMessageText } from "../UserMessageText"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const onEdit = vi.fn()
let textHeight: number
let resize: () => void
let disconnect: ReturnType<typeof vi.fn>

function Message({ text = "A pasted log\n".repeat(40) }: { text?: string }) {
	const [expanded, setExpanded] = useState(false)
	return (
		<UserMessageText
			text={text}
			isExpanded={expanded}
			onToggleExpand={() => setExpanded(!expanded)}
			onEdit={onEdit}
		/>
	)
}

describe("long user message previews", () => {
	beforeEach(() => {
		textHeight = 800
		disconnect = vi.fn()
		onEdit.mockClear()
		vi.mocked(Element.prototype.scrollIntoView).mockClear()
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300)
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => textHeight)
		const getStyle = window.getComputedStyle.bind(window)
		vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
			const style = getStyle(element)
			Object.defineProperty(style, "lineHeight", { value: "20px" })
			return style
		})
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					resize = callback
				}
				observe = vi.fn()
				disconnect = disconnect
			},
		)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it("keeps six lines readable without an expansion control", () => {
		textHeight = 120
		render(<Message text="Short message" />)
		expect(screen.queryByRole("button", { name: "chat:task.seeMore" })).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Short message"))
		expect(onEdit).toHaveBeenCalledTimes(1)
	})

	it.each(["one long wrapped paragraph ".repeat(100), "log entry\n".repeat(100)])(
		"collapses overflowing text and retains its full content when expanded",
		(text) => {
			render(<Message text={text} />)
			const expand = screen.getByRole("button", { name: "chat:task.seeMore" })
			const content = document.getElementById(expand.getAttribute("aria-controls")!)!
			expect(expand).toHaveAttribute("aria-expanded", "false")
			expect(content.style.maxHeight).not.toBe("")
			fireEvent.click(expand)
			expect(screen.getByRole("button", { name: "chat:task.seeLess" })).toHaveAttribute("aria-expanded", "true")
			expect(content.style.maxHeight).toBe("")
			expect(content.textContent).toBe(text)
			expect(onEdit).not.toHaveBeenCalled()
			fireEvent.click(screen.getByRole("button", { name: "chat:task.seeLess" }))
			expect(content.style.maxHeight).not.toBe("")
			expect(content.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" })
		},
	)

	it("expands the preview when clicked, while preserving text selection", () => {
		render(<Message text="Long pasted text" />)
		const selection = vi
			.spyOn(window, "getSelection")
			.mockReturnValue({ toString: () => "selected text" } as Selection)
		fireEvent.click(screen.getByText("Long pasted text"))
		expect(screen.getByRole("button", { name: "chat:task.seeMore" })).toBeInTheDocument()
		selection.mockRestore()
		fireEvent.click(screen.getByText("Long pasted text"))
		expect(screen.getByRole("button", { name: "chat:task.seeLess" })).toBeInTheDocument()
		expect(onEdit).not.toHaveBeenCalled()
	})

	it("rechecks wrapping after resize without closing a message the user expanded", () => {
		const { unmount } = render(<Message />)
		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeMore" }))
		textHeight = 60
		act(() => resize())
		expect(screen.queryByRole("button", { name: "chat:task.seeLess" })).not.toBeInTheDocument()
		textHeight = 1000
		act(() => resize())
		expect(screen.getByRole("button", { name: "chat:task.seeLess" })).toHaveAttribute("aria-expanded", "true")
		unmount()
		expect(disconnect).toHaveBeenCalledTimes(1)
	})

	it("adapts when a short message becomes long after an edit", () => {
		textHeight = 40
		const { rerender } = render(<Message text="Short text" />)
		textHeight = 800
		rerender(<Message text="Replaced with a much longer log" />)
		expect(screen.getByRole("button", { name: "chat:task.seeMore" })).toBeInTheDocument()
	})
})
