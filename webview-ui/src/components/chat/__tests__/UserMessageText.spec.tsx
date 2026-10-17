import { useState } from "react"
import { act, fireEvent, render, screen } from "@/utils/test-utils"

import { vscode } from "../../../utils/vscode"
import { UserMessageText } from "../UserMessageText"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const onEdit = vi.fn()
let textHeight: number
let resize: () => void
let disconnect: import("vitest").Mock

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

	it.each(["ticket:BAS-65", "tickets:BAS-65", "BAS-65", "/src/task.ts"])(
		"keeps the @%s preview stable when mention styling changes whether six lines fit",
		(mention) => {
			let width = 300
			vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width)
			vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
				if (this.clientWidth >= 500) return 60
				// A styled mention can wrap onto a seventh line where its undecorated text fits in six.
				return this.querySelector("[class*='mention-context-highlight']") ? 140 : 120
			})
			const text = `Work on @${mention} and preserve the details.`
			const { rerender } = render(<Message text={text} />)
			const collapsedStates = [Boolean(screen.queryByRole("button", { name: "chat:task.seeMore" }))]

			for (let update = 0; update < 4; update++) {
				rerender(<Message text={text} />)
				act(() => resize())
				collapsedStates.push(Boolean(screen.queryByRole("button", { name: "chat:task.seeMore" })))
			}
			expect(collapsedStates).toEqual([true, true, true, true, true])
			expect(screen.getByRole("button", { name: "chat:task.seeMore" })).toHaveAttribute("aria-expanded", "false")
			if (!mention.startsWith("/")) expect(screen.getByRole("button", { name: `@${mention}` })).toBeDisabled()

			rerender(<Message text={`${text} Updated details.`} />)
			act(() => resize())
			expect(screen.getByRole("button", { name: "chat:task.seeMore" })).toHaveAttribute("aria-expanded", "false")

			width = 600
			act(() => resize())
			expect(screen.queryByRole("button", { name: "chat:task.seeMore" })).not.toBeInTheDocument()
			expect(screen.getByText(`@${mention}`)).toHaveClass(
				mention.startsWith("/") ? "mention-context-highlight-with-shadow" : "mention-context-highlight",
			)
			if (!mention.startsWith("/")) expect(screen.getByRole("button", { name: `@${mention}` })).not.toBeDisabled()

			width = 300
			act(() => resize())
			expect(screen.getByRole("button", { name: "chat:task.seeMore" })).toHaveAttribute("aria-expanded", "false")
			act(() => resize())
			expect(screen.getByRole("button", { name: "chat:task.seeMore" })).toHaveAttribute("aria-expanded", "false")
		},
	)

	it("keeps short ticket mentions interactive without editing the message", () => {
		textHeight = 40
		const post = vi.spyOn(vscode, "postMessage").mockImplementation(() => {})
		render(<Message text="Work on @ticket:BAS-65." />)
		fireEvent.click(screen.getByRole("button", { name: "@ticket:BAS-65" }))
		expect(post).toHaveBeenCalledTimes(1)
		expect(post).toHaveBeenCalledWith({ type: "openMention", text: "ticket:BAS-65" })
		expect(onEdit).not.toHaveBeenCalled()
	})

	it("keeps clipped ticket controls out of keyboard navigation until the message expands", () => {
		const post = vi.spyOn(vscode, "postMessage").mockImplementation(() => {})
		render(<Message text={"Long ticket details ".repeat(40) + "@ticket:BAS-65"} />)
		const expand = screen.getByRole("button", { name: "chat:task.seeMore" })
		const content = document.getElementById(expand.getAttribute("aria-controls")!)!
		expect(content.querySelector("button:not([disabled]):not([tabindex='-1']), a[href], [tabindex='0']")).toBeNull()
		expect(screen.getByRole("button", { name: "@ticket:BAS-65" })).toBeDisabled()
		expect(post).not.toHaveBeenCalled()

		fireEvent.click(expand)
		const mention = screen.getByRole("button", { name: "@ticket:BAS-65" })
		expect(mention).not.toBeDisabled()
		fireEvent.click(mention)
		expect(post).toHaveBeenCalledTimes(1)
		expect(post).toHaveBeenCalledWith({ type: "openMention", text: "ticket:BAS-65" })
		expect(screen.getByRole("button", { name: "chat:task.seeLess" })).toHaveAttribute("aria-expanded", "true")
		expect(onEdit).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeLess" }))
		expect(screen.getByRole("button", { name: "@ticket:BAS-65" })).toBeDisabled()
		expect(content.querySelector("button:not([disabled]):not([tabindex='-1']), a[href], [tabindex='0']")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "@ticket:BAS-65" }))
		expect(post).toHaveBeenCalledTimes(1)
	})
})
