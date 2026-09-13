import { useState } from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"
import SearchResults, { type CodebaseSearchMatch } from "../CodebaseSearchResultsDisplay"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (_key: string, options?: { count?: number }) => `Found ${options?.count} results` }),
	Trans: ({ count }: { count: number }) => <>Found {count} results</>,
}))

const result = {
	filePath: "backend/app/database.py",
	score: 0.983,
	startLine: 12,
	endLine: 26,
	context: "Database.connect",
	codeChunk: "def connect(self):\n    return self.pool.acquire()",
}

function CodebaseSearchResultsDisplay({ results }: { results: CodebaseSearchMatch[] }) {
	const [expanded, setExpanded] = useState(false)
	return (
		<SearchResults results={results} isExpanded={expanded} onToggleExpand={() => setExpanded((value) => !value)} />
	)
}

describe("codebase search results", () => {
	beforeEach(() => vi.clearAllMocks())

	it("routes expansion through the chat's controller so it can release automatic scrolling", () => {
		const onToggleExpand = vi.fn()
		const { rerender } = render(
			<SearchResults results={[result]} isExpanded={false} onToggleExpand={onToggleExpand} />,
		)
		fireEvent.click(screen.getByRole("button", { expanded: false }))
		expect(onToggleExpand).toHaveBeenCalledTimes(1)
		expect(screen.queryByText("database.py")).not.toBeInTheDocument()
		rerender(<SearchResults results={[result]} isExpanded={true} onToggleExpand={onToggleExpand} />)
		expect(screen.getByText("database.py")).toBeVisible()
	})

	it("offers an accessible disclosure and renders evidence only when expanded", () => {
		render(<CodebaseSearchResultsDisplay results={[result]} />)
		const toggle = screen.getByRole("button", { name: "Found 1 results", expanded: false })
		expect(screen.queryByText("database.py")).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeVisible()
		expect(screen.getByText("database.py")).toBeVisible()
		expect(screen.getByText("Database.connect")).toBeVisible()
		expect(screen.getByText(/return self.pool.acquire/)).toBeVisible()
		expect(screen.queryByText("0.983")).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(screen.queryByText("database.py")).not.toBeInTheDocument()
	})

	it("opens the selected match at its original line and normalizes Windows paths", () => {
		render(<CodebaseSearchResultsDisplay results={[{ ...result, filePath: "backend\\app\\database.py" }]} />)
		fireEvent.click(screen.getByRole("button", { expanded: false }))
		const match = screen.getByRole("button", { name: /database.py/ })
		expect(match).toHaveAttribute("type", "button")
		expect(match).toHaveAttribute("title", "backend/app/database.py:12–26")
		fireEvent.click(match)
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "./backend/app/database.py",
			values: { line: 12 },
		})
	})

	it("keeps ranked matches from the same file and supports older results without context", () => {
		render(
			<CodebaseSearchResultsDisplay
				results={[result, { ...result, context: undefined, startLine: 80, endLine: 80 }]}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { expanded: false }))
		expect(screen.getAllByRole("listitem")).toHaveLength(2)
		expect(screen.getAllByRole("button", { name: /database.py/ }).map((button) => button.title)).toEqual([
			"backend/app/database.py:12–26",
			"backend/app/database.py:80",
		])
	})

	it("renders source as text, including markup-like content", () => {
		render(
			<CodebaseSearchResultsDisplay results={[{ ...result, codeChunk: "<script>alert('example')</script>" }]} />,
		)
		fireEvent.click(screen.getByRole("button", { expanded: false }))
		expect(screen.getByText("<script>alert('example')</script>")).toBeVisible()
		expect(document.querySelector("script")).toBeNull()
	})

	it("displays an empty result without offering an empty disclosure", () => {
		render(<CodebaseSearchResultsDisplay results={[]} />)
		expect(screen.getByText("Found 0 results")).toBeVisible()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})
})
