// npx vitest run src/components/common/__tests__/CodeBlock.spec.tsx

import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"

import CodeBlock from "../CodeBlock"

// Mock the translation context
vi.mock("../../../i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			// Return fixed English strings for tests
			const translations: { [key: string]: string } = {
				"chat:codeblock.tooltips.copy_code": "Copy code",
				"chat:codeblock.tooltips.expand": "Expand code block",
				"chat:codeblock.tooltips.collapse": "Collapse code block",
			}
			return translations[key] || key
		},
	}),
}))

// Mock shiki module
vi.mock("shiki", () => ({
	bundledLanguages: {
		typescript: {},
		javascript: {},
		txt: {},
	},
}))

// Mock the highlighter utility
vi.mock("../../../utils/highlighter", () => {
	const mockHighlighter = {
		codeToHtml: vi.fn().mockImplementation((code, options) => {
			const theme = options.theme === "github-light" ? "light" : "dark"
			return `<pre><code class="hljs language-${options.lang}">${code} [${theme}-theme]</code></pre>`
		}),
		codeToHast: vi.fn().mockImplementation((code, options) => {
			const theme = options.theme === "github-light" ? "light" : "dark"
			// Return a comprehensive HAST node structure that matches Shiki's output
			// Apply transformers if provided
			const preNode = {
				type: "element",
				tagName: "pre",
				properties: {},
				children: [
					{
						type: "element",
						tagName: "code",
						properties: { className: [`hljs`, `language-${options.lang}`] },
						children: [
							{
								type: "text",
								value: `${code} [${theme}-theme]`,
							},
						],
					},
				],
			}

			// Apply transformers if they exist
			if (options.transformers) {
				for (const transformer of options.transformers) {
					if (transformer.pre) {
						transformer.pre(preNode)
					}
					if (transformer.code && preNode.children[0]) {
						transformer.code(preNode.children[0])
					}
				}
			}

			return preNode
		}),
	}

	return {
		normalizeLanguage: vi.fn((lang) => lang || "txt"),
		isLanguageLoaded: vi.fn().mockReturnValue(true),
		getHighlighter: vi.fn().mockResolvedValue(mockHighlighter),
	}
})

// Mock clipboard utility
vi.mock("../../../utils/clipboard", () => ({
	useCopyToClipboard: () => ({
		showCopyFeedback: false,
		copyWithFeedback: vi.fn(),
	}),
}))

describe("CodeBlock", () => {
	const mockIntersectionObserver = vi.fn()
	const originalGetComputedStyle = window.getComputedStyle

	beforeEach(() => {
		// Mock IntersectionObserver
		window.IntersectionObserver = mockIntersectionObserver

		// Mock getComputedStyle
		window.getComputedStyle = vi.fn().mockImplementation((element) => ({
			...originalGetComputedStyle(element),
			getPropertyValue: () => "12px",
		}))
	})

	afterEach(() => {
		vi.clearAllMocks()
		window.getComputedStyle = originalGetComputedStyle
	})

	it("subscribes to its owning native transcript scroller", async () => {
		const unrelatedScroller = document.createElement("div")
		unrelatedScroller.setAttribute("data-chat-transcript-scroller", "true")
		const unrelatedAddEventListener = vi.spyOn(unrelatedScroller, "addEventListener")
		document.body.appendChild(unrelatedScroller)

		const owningScroller = document.createElement("div")
		owningScroller.setAttribute("data-chat-transcript-scroller", "true")
		const mountNode = document.createElement("div")
		owningScroller.appendChild(mountNode)
		document.body.appendChild(owningScroller)

		const addEventListener = vi.spyOn(owningScroller, "addEventListener")
		const removeEventListener = vi.spyOn(owningScroller, "removeEventListener")
		const { unmount } = render(<CodeBlock source="const x = 1" language="typescript" />, {
			container: mountNode,
		})

		const scrollRegistration = addEventListener.mock.calls.find(([type]) => type === "scroll")
		expect(scrollRegistration).toBeDefined()
		expect(unrelatedAddEventListener).not.toHaveBeenCalledWith("scroll", expect.any(Function))

		unmount()
		expect(removeEventListener).toHaveBeenCalledWith("scroll", scrollRegistration?.[1])

		owningScroller.remove()
		unrelatedScroller.remove()
	})

	it("renders basic syntax highlighting", async () => {
		const code = "const x = 1;\nconsole.log(x);"

		await act(async () => {
			render(<CodeBlock source={code} language="typescript" />)
		})

		expect(screen.getByText(/const x = 1/)).toBeInTheDocument()
	})

	it("handles theme switching", async () => {
		const code = "const x = 1;"

		await act(async () => {
			const { rerender } = render(<CodeBlock source={code} language="typescript" />)

			// Simulate light theme
			document.body.className = "light"
			rerender(<CodeBlock source={code} language="typescript" />)
		})

		expect(screen.getByText(/\[light-theme\]/)).toBeInTheDocument()

		await act(async () => {
			document.body.className = "dark"
			render(<CodeBlock source={code} language="typescript" />)
		})

		expect(screen.getByText(/\[dark-theme\]/)).toBeInTheDocument()
	})

	it("handles invalid language gracefully", async () => {
		const code = "some code"

		await act(async () => {
			render(<CodeBlock source={code} language="invalid-lang" />)
		})

		expect(screen.getByText(/some code/)).toBeInTheDocument()
	})

	it("handles WASM loading errors", async () => {
		const mockError = new Error("WASM load failed")
		const highlighterUtil = await import("../../../utils/highlighter")
		vi.mocked(highlighterUtil.getHighlighter).mockRejectedValueOnce(mockError)

		const code = "const x = 1;"
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await act(async () => {
			render(<CodeBlock source={code} language="typescript" />)
		})

		expect(consoleSpy).toHaveBeenCalledWith(
			"[CodeBlock] Syntax highlighting error:",
			mockError,
			"\nStack trace:",
			mockError.stack,
		)
		expect(screen.getByText(/const x = 1;/)).toBeInTheDocument()

		consoleSpy.mockRestore()
	})

	it("verifies highlighter utility is used correctly", async () => {
		const code = "const x = 1;"
		const highlighterUtil = await import("../../../utils/highlighter")

		await act(async () => {
			render(<CodeBlock source={code} language="typescript" />)
		})

		// Verify getHighlighter was called with the right language
		expect(highlighterUtil.getHighlighter).toHaveBeenCalledWith("typescript")
		expect(highlighterUtil.normalizeLanguage).toHaveBeenCalledWith("typescript")
	})

	it("renders partial code as plain text without starting syntax highlighting", async () => {
		const highlighterUtil = await import("../../../utils/highlighter")
		const getHighlighter = vi.mocked(highlighterUtil.getHighlighter)
		getHighlighter.mockClear()

		const { rerender } = render(<CodeBlock source="const first = 1" language="typescript" partial />)
		expect(screen.getByText("const first = 1")).toBeInTheDocument()
		expect(getHighlighter).not.toHaveBeenCalled()

		rerender(<CodeBlock source="const latest = 2" language="typescript" partial />)
		expect(screen.getByText("const latest = 2")).toBeInTheDocument()
		expect(screen.queryByText("const first = 1")).not.toBeInTheDocument()
		expect(getHighlighter).not.toHaveBeenCalled()

		rerender(<CodeBlock source="const latest = 2" language="typescript" partial={false} />)
		await waitFor(() => expect(getHighlighter).toHaveBeenCalledTimes(1))
	})

	it("does not let stale asynchronous highlighting replace newer source", async () => {
		const highlighterUtil = await import("../../../utils/highlighter")
		const getHighlighter = vi.mocked(highlighterUtil.getHighlighter)
		const defaultHighlighter = await getHighlighter("typescript")
		const resolvers = new Map<string, (value: any) => void>()
		const codeToHast = vi.fn(
			(code: string) =>
				new Promise((resolve) => {
					resolvers.set(code, resolve)
				}),
		)
		getHighlighter.mockResolvedValue({ ...defaultHighlighter, codeToHast } as any)

		const makeHast = (text: string) => ({
			type: "element",
			tagName: "pre",
			properties: {},
			children: [
				{
					type: "element",
					tagName: "code",
					properties: {},
					children: [{ type: "text", value: `${text} highlighted` }],
				},
			],
		})

		const { rerender } = render(<CodeBlock source="old source" language="typescript" />)
		await waitFor(() => expect(resolvers.has("old source")).toBe(true))
		rerender(<CodeBlock source="new source" language="typescript" />)
		await waitFor(() => expect(resolvers.has("new source")).toBe(true))

		await act(async () => resolvers.get("new source")?.(makeHast("new source")))
		expect(await screen.findByText("new source highlighted")).toBeInTheDocument()

		await act(async () => resolvers.get("old source")?.(makeHast("old source")))
		expect(screen.queryByText("old source highlighted")).not.toBeInTheDocument()
		expect(screen.getByText("new source highlighted")).toBeInTheDocument()

		getHighlighter.mockResolvedValue(defaultHighlighter)
	})

	it("handles copy functionality", async () => {
		const code = "const x = 1;"
		const { container } = render(<CodeBlock source={code} language="typescript" />)

		// Simulate code block visibility
		const codeBlock = container.querySelector("[data-partially-visible]")
		if (codeBlock) {
			codeBlock.setAttribute("data-partially-visible", "true")
		}

		// Find the copy button by looking for the button containing the Copy icon
		const buttons = screen.getAllByRole("button")
		const copyButton = buttons.find((btn) => btn.querySelector("svg.lucide-copy"))

		expect(copyButton).toBeTruthy()
		if (copyButton) {
			await act(async () => {
				fireEvent.click(copyButton)
			})
		}
	})

	it("exposes named keyboard-focusable controls", () => {
		render(<CodeBlock source="const value = 1" language="typescript" />)

		const copyButton = screen.getByRole("button", { name: "Copy code" })

		expect(copyButton).toHaveAttribute("type", "button")
		expect(copyButton).toHaveAccessibleName("Copy code")
	})
})
