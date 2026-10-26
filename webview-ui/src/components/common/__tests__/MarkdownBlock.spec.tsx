import { render, screen } from "@/utils/test-utils"

import MarkdownBlock from "../MarkdownBlock"
import { fireEvent } from "@testing-library/react"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		theme: "dark",
	}),
}))

describe("MarkdownBlock", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each([
		["package.json:12", "./package.json"],
		["file.ts:12", "./file.ts"],
		["file.c++:12", "./file.c++"],
		["src/app.ts:12-14", "./src/app.ts"],
		["/work/src/app.ts:12", "/work/src/app.ts"],
		["C:/work/src/app.ts:12", "C:/work/src/app.ts"],
		[String.raw`C:\work\src\app.ts:12`, "C:/work/src/app.ts"],
		["file:///work/src/a%20b.ts:12", "/work/src/a%20b.ts"],
		["file:///C:/work/src/app.ts:12", "C:/work/src/app.ts"],
		["file://localhost/C:/work/src/app.ts:12", "C:/work/src/app.ts"],
		["FiLe:///C:/work/src/app.ts:12", "C:/work/src/app.ts"],
	])("opens the local source %s at its line without rewriting absolute paths", (url, text) => {
		render(<MarkdownBlock markdown={`[Source](${url})`} />)
		fireEvent.click(screen.getByRole("link", { name: "Source" }))

		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openFile", text, values: { line: 12 } })
	})

	it("renders a basename line link as a relative URL rather than a URI scheme", () => {
		render(<MarkdownBlock markdown="[Source](package.json:12)" />)
		expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute("href", "./package.json:12")
	})

	it.each([
		"https://example.com/page",
		"http://example.com/page",
		"mailto:help@example.com",
		"#details",
		"?view=details",
		"//example.com/page",
		"/%2fexample.com/page",
		"%5c%5cserver%5cshare",
	])("leaves browser navigation for %s without requesting a file", (url) => {
		render(<MarkdownBlock markdown={`[Navigate](${url})`} />)
		const link = screen.getByRole("link", { name: "Navigate" })
		expect(link).toHaveAttribute("href", url)
		let intercepted = false
		document.addEventListener(
			"click",
			(event) => {
				intercepted = event.defaultPrevented
				event.preventDefault()
			},
			{ once: true },
		)
		fireEvent.click(link)

		expect(intercepted).toBe(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each([
		"",
		"command:workbench.action.closeWindow",
		"command:/workbench.action.closeWindow",
		"javascript:alert(1)",
		"javascript:123",
		"data:text/html,unsafe",
		"vscode:workbench.action.closeWindow",
		"alpha-document://open?uri=file%3A%2F%2F%2Fwork%2Freview.html&unknown=value",
		"file://server/share/private.txt",
		"file:////server/share/private.txt",
		"file:///%5cserver/share/private.txt",
		"file:///work/private.txt?create=true",
	])("does not turn the blocked link %s into workspace navigation", (url) => {
		render(<MarkdownBlock markdown={`[Blocked](${url})`} />)
		fireEvent.click(screen.getByText("Blocked"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
		if (url) expect(screen.getByText("Blocked")).not.toHaveAttribute("href", url)
	})

	it.each(["file:///C:/private/image.png", "C:/private/image.png"])(
		"keeps the default image URL restrictions for %s",
		(url) => {
			render(<MarkdownBlock markdown={`![Preview](${url})`} />)
			expect(screen.getByAltText("Preview")).not.toHaveAttribute("src", url)
		},
	)

	it("routes explicit document links with durable URI/task identity", () => {
		const link = "alpha-document://open?uri=file%3A%2F%2F%2FC%3A%2Fwork%2Freview.html&task=task-1"
		render(<MarkdownBlock markdown={`[Review](${link})`} />)
		fireEvent.click(screen.getByRole("link", { name: "Review" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openHtmlDocument", text: link })
	})

	it("keeps ordinary HTML links in the source-opening flow", () => {
		render(<MarkdownBlock markdown="[Source](./review.html)" />)
		fireEvent.click(screen.getByRole("link", { name: "Source" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openFile", text: "./review.html", values: undefined })
	})

	it("does not allow arbitrary command schemes through the URL transform", () => {
		render(<MarkdownBlock markdown="[Unsafe](command:workbench.action.closeWindow)" />)
		expect(screen.getByText("Unsafe")).not.toHaveAttribute("href", "command:workbench.action.closeWindow")
	})

	it("defers math rendering until the stream completes", () => {
		const { container, rerender } = render(<MarkdownBlock markdown="The answer is $x^2$." partial />)
		expect(container.querySelector(".katex")).toBeNull()
		expect(container.querySelector("p")?.textContent).toBe("The answer is $x^2$.")
		rerender(<MarkdownBlock markdown="The answer is $x^2$." />)
		expect(container.querySelector(".katex")).not.toBeNull()
	})
	it("should correctly handle URLs with trailing punctuation", async () => {
		const markdown = "Check out this link: https://example.com."
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Check out this link/, { exact: false })

		// Check for nested links - this should not happen
		const nestedLinks = container.querySelectorAll("a a")
		expect(nestedLinks.length).toBe(0)

		// Should have exactly one link
		const linkElement = screen.getByRole("link")
		expect(linkElement).toHaveAttribute("href", "https://example.com")
		expect(linkElement.textContent).toBe("https://example.com")

		// Check that the period is outside the link
		const paragraph = container.querySelector("p")
		expect(paragraph?.textContent).toBe("Check out this link: https://example.com.")
	}, 10000)

	it("should render unordered lists with proper styling", async () => {
		const markdown = `Here are some items:
- First item
- Second item
  - Nested item
  - Another nested item`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Here are some items/, { exact: false })

		// Check that ul elements exist
		const ulElements = container.querySelectorAll("ul")
		expect(ulElements.length).toBeGreaterThan(0)

		// Check that list items exist
		const liElements = container.querySelectorAll("li")
		expect(liElements.length).toBe(4)

		// Verify the text content
		expect(screen.getByText("First item")).toBeInTheDocument()
		expect(screen.getByText("Second item")).toBeInTheDocument()
		expect(screen.getByText("Nested item")).toBeInTheDocument()
		expect(screen.getByText("Another nested item")).toBeInTheDocument()
	})

	it("should render ordered lists with proper styling", async () => {
		const markdown = `And a numbered list:
1. Step one
2. Step two
3. Step three`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/And a numbered list/, { exact: false })

		// Check that ol elements exist
		const olElements = container.querySelectorAll("ol")
		expect(olElements.length).toBe(1)

		// Check that list items exist
		const liElements = container.querySelectorAll("li")
		expect(liElements.length).toBe(3)

		// Verify the text content
		expect(screen.getByText("Step one")).toBeInTheDocument()
		expect(screen.getByText("Step two")).toBeInTheDocument()
		expect(screen.getByText("Step three")).toBeInTheDocument()
	})

	it("should render nested lists with proper hierarchy", async () => {
		const markdown = `Complex list:
1. First level ordered
   - Second level unordered
   - Another second level
     1. Third level ordered
     2. Another third level
2. Back to first level`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Complex list/, { exact: false })

		// Check nested structure
		const olElements = container.querySelectorAll("ol")
		const ulElements = container.querySelectorAll("ul")

		expect(olElements.length).toBeGreaterThan(0)
		expect(ulElements.length).toBeGreaterThan(0)

		// Verify all text is rendered
		expect(screen.getByText("First level ordered")).toBeInTheDocument()
		expect(screen.getByText("Second level unordered")).toBeInTheDocument()
		expect(screen.getByText("Third level ordered")).toBeInTheDocument()
		expect(screen.getByText("Back to first level")).toBeInTheDocument()
	})
})
