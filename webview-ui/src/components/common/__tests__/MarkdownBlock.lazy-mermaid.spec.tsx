import type { ComponentProps } from "react"
import { render, screen } from "@/utils/test-utils"
import { TranslationContext } from "@src/i18n/TranslationContext"
import i18n from "@src/i18n/setup"

import MarkdownBlock from "../MarkdownBlock"

const mermaidModule = vi.hoisted(() => ({ loaded: vi.fn(), render: vi.fn() }))
const markdownRender = vi.hoisted(() => vi.fn())

vi.mock("react-markdown", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-markdown")>()
	const ReactMarkdown = actual.default
	return {
		...actual,
		default: (props: ComponentProps<typeof ReactMarkdown>) => {
			markdownRender()
			return <ReactMarkdown {...props} />
		},
	}
})

vi.mock("../MermaidBlock", () => {
	mermaidModule.loaded()
	return {
		default: ({ code }: { code: string }) => {
			mermaidModule.render(code)
			return <div data-testid="mermaid-renderer">{code}</div>
		},
	}
})

vi.mock("../CodeBlock", () => ({
	default: ({ source, language }: { source: string; language: string }) => (
		<pre data-testid="code-block" data-language={language}>
			{source}
		</pre>
	),
}))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

describe("MarkdownBlock diagram loading", () => {
	it("keeps plain Markdown memoized when only translation context changes", () => {
		const view = (t: (key: string) => string) => (
			<TranslationContext.Provider value={{ t, i18n }}>
				<MarkdownBlock markdown="A plain response." />
			</TranslationContext.Provider>
		)
		const { rerender } = render(view((key) => key))
		const initialRenders = markdownRender.mock.calls.length
		rerender(view((key) => `Updated ${key}`))
		expect(markdownRender).toHaveBeenCalledTimes(initialRenders)
		expect(screen.getByText("A plain response.")).toBeInTheDocument()
	})

	it("loads Mermaid only for completed diagrams and renders the latest code after loading", async () => {
		const diagram = (code: string) => `Before\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\nAfter`
		const { rerender } = render(<MarkdownBlock markdown="A **ready** response with `inline` code." />)
		expect(mermaidModule.loaded).not.toHaveBeenCalled()
		expect(screen.getByText("ready").tagName).toBe("STRONG")
		expect(screen.getByText("inline").tagName).toBe("CODE")

		rerender(<MarkdownBlock markdown={"```typescript\nconst answer = 42\n```"} />)
		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "typescript")
		expect(screen.getByTestId("code-block")).toHaveTextContent("const answer = 42")
		expect(mermaidModule.loaded).not.toHaveBeenCalled()

		const initialDiagram = diagram("graph TD\n  A-->B")
		rerender(<MarkdownBlock markdown={initialDiagram} partial />)
		expect(screen.getByText(initialDiagram, { normalizer: (text) => text })).toBeInTheDocument()
		expect(mermaidModule.loaded).not.toHaveBeenCalled()

		rerender(<MarkdownBlock markdown={initialDiagram} />)
		expect(screen.getByRole("status")).toHaveTextContent("Generating mermaid diagram...")
		expect(screen.getByText("Before")).toBeInTheDocument()
		expect(screen.getByText("After")).toBeInTheDocument()
		rerender(<MarkdownBlock markdown={diagram("graph TD\n  C-->D")} />)

		expect(await screen.findByTestId("mermaid-renderer")).toHaveTextContent("C-->D")
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
		expect(mermaidModule.loaded).toHaveBeenCalledTimes(1)
		expect(mermaidModule.render).not.toHaveBeenCalledWith(expect.stringContaining("A-->B"))

		rerender(<MarkdownBlock markdown={diagram("graph TD\n  E-->F")} />)
		expect(screen.getByTestId("mermaid-renderer")).toHaveTextContent("E-->F")
		expect(mermaidModule.loaded).toHaveBeenCalledTimes(1)
	})
})
