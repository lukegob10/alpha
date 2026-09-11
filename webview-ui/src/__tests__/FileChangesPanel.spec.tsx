import React from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"
import type { ClineMessage } from "@alpha-code/types"
import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"
import FileChangesPanel from "../components/chat/FileChangesPanel"

const mockPostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

// Mock i18n to return readable header with count
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { count?: number }) => {
			if (key === "chat:fileChangesInConversation.header" && opts?.count != null) {
				return `Files edited: ${opts.count}`
			}
			return key
		},
	}),
}))

vi.mock("@src/components/common/DiffView", () => ({
	default: ({ source }: { source: string }) => <pre data-testid="file-diff">{source}</pre>,
}))

function createFileEditMessage(
	path: string,
	diff: string,
	diffStats?: { added: number; removed: number },
): ClineMessage {
	return {
		type: "ask",
		ask: "tool",
		ts: Date.now(),
		partial: false,
		isAnswered: true,
		text: JSON.stringify({
			tool: "appliedDiff",
			path,
			diff,
			...(diffStats && { diffStats }),
		}),
	}
}

function renderPanel(messages: ClineMessage[] | undefined, taskId?: string) {
	return render(
		<TranslationProvider>
			<FileChangesPanel clineMessages={messages} taskId={taskId} />
		</TranslationProvider>,
	)
}

describe("FileChangesPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders nothing when clineMessages is undefined", () => {
		const { container } = renderPanel(undefined)
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when clineMessages is empty", () => {
		const { container } = renderPanel([])
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when there are no file-edit messages", () => {
		const messages: ClineMessage[] = [
			{
				type: "say",
				say: "text",
				ts: Date.now(),
				partial: false,
				text: "hello",
			},
			{
				type: "ask",
				ask: "tool",
				ts: Date.now(),
				partial: false,
				text: JSON.stringify({ tool: "read_file", path: "x.ts" }),
			},
		]
		const { container } = renderPanel(messages)
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when file-edit ask tool is not approved (isAnswered false or missing)", () => {
		const messages: ClineMessage[] = [
			{
				type: "ask",
				ask: "tool",
				ts: Date.now(),
				partial: false,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/foo.ts",
					diff: "+line",
				}),
			},
		]
		const { container } = renderPanel(messages)
		expect(container.firstChild).toBeNull()
	})

	it("renders panel with header when there is one file edit", () => {
		const messages = [createFileEditMessage("src/foo.ts", "@@ -1 +1 @@\n+line")]
		renderPanel(messages)

		expect(screen.getByText("Files edited: 1")).toBeInTheDocument()
		expect(screen.getByText("src/foo.ts")).toBeInTheDocument()
	})

	it("renders one row per unique path when multiple files edited", () => {
		const messages = [createFileEditMessage("src/a.ts", "diff a"), createFileEditMessage("src/b.ts", "diff b")]
		renderPanel(messages)

		expect(screen.getByText("Files edited: 2")).toBeInTheDocument()
		expect(screen.getByText("src/a.ts")).toBeInTheDocument()
		expect(screen.getByText("src/b.ts")).toBeInTheDocument()
	})

	it("shows the file list by default and lets the user collapse it", () => {
		const messages = [createFileEditMessage("src/foo.ts", "diff")]
		renderPanel(messages)

		// Header visible
		const headerText = screen.getByText("Files edited: 1")
		expect(headerText).toBeInTheDocument()
		// Trigger is the button that contains the header text
		const trigger = headerText.closest("button")
		expect(trigger).toBeInTheDocument()

		expect(trigger).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(trigger!)
		expect(screen.queryByText("src/foo.ts")).not.toBeInTheDocument()
		fireEvent.click(trigger!)
		expect(screen.getByText("src/foo.ts")).toBeInTheDocument()
	})

	it("toggling a file row expand calls onToggleExpand", () => {
		const messages = [createFileEditMessage("src/foo.ts", "diff")]
		renderPanel(messages)

		const toggle = screen.getByRole("button", { name: /^src\/foo.ts/ })
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
	})

	it("hides aggregate stats when no diffStats are present", () => {
		const messages = [createFileEditMessage("src/a.ts", "diff a"), createFileEditMessage("src/b.ts", "diff b")]
		renderPanel(messages)

		expect(screen.queryByTestId("total-added")).not.toBeInTheDocument()
		expect(screen.queryByTestId("total-removed")).not.toBeInTheDocument()
		expect(screen.queryByText("+0")).not.toBeInTheDocument()
		expect(screen.queryByText("-0")).not.toBeInTheDocument()
	})

	it("shows aggregated + and - totals in the header when diffStats are present", () => {
		const messages = [
			createFileEditMessage("src/a.ts", "diff a", { added: 3, removed: 1 }),
			createFileEditMessage("src/b.ts", "diff b", { added: 2, removed: 5 }),
		]
		renderPanel(messages)

		expect(screen.getByTestId("total-added")).toHaveTextContent("+5")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-6")
	})

	it("preserves expanded files during streaming and resets them only when the task changes", () => {
		const edit = createFileEditMessage("src/foo.ts", "diff")
		const { rerender } = renderPanel([edit], "task-a")

		fireEvent.click(screen.getByRole("button", { name: /^src\/foo.ts/ }))
		expect(screen.getByRole("button", { name: /^src\/foo.ts/ })).toHaveAttribute("aria-expanded", "true")

		rerender(
			<TranslationProvider>
				<FileChangesPanel
					clineMessages={[
						edit,
						{ type: "say", say: "text", ts: edit.ts + 1, text: "streaming", partial: true },
					]}
					taskId="task-a"
				/>
			</TranslationProvider>,
		)
		expect(screen.getByRole("button", { name: /^src\/foo.ts/ })).toHaveAttribute("aria-expanded", "true")

		rerender(
			<TranslationProvider>
				<FileChangesPanel clineMessages={[edit]} taskId="task-b" />
			</TranslationProvider>,
		)
		expect(screen.getByRole("button", { name: /^src\/foo.ts/ })).toHaveAttribute("aria-expanded", "false")
	})
})

function edit(path: string, overrides: Partial<ClineMessage> = {}): ClineMessage {
	return {
		ts: 100,
		type: "ask",
		ask: "tool",
		isAnswered: true,
		text: JSON.stringify({
			tool: "appliedDiff",
			path,
			diff: "-old\n+new",
			diffStats: { added: 2, removed: 1 },
			originalContent: "old",
		}),
		...overrides,
	}
}

describe("Compact file summaries", () => {
	beforeEach(() => vi.clearAllMocks())

	it("shows three files with collapsed diffs, then reveals the remaining files", () => {
		const onExpandedChange = vi.fn()
		render(
			<FileChangesPanel
				clineMessages={[edit("one.ts"), edit("two.ts"), edit("three.ts"), edit("four.ts")]}
				taskId="one"
				onExpandedChange={onExpandedChange}
			/>,
		)
		expect(screen.getByRole("button", { name: /one.ts \+2 -1/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("four.ts")).not.toBeInTheDocument()
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalled()
		expect(screen.getByTestId("total-added")).toHaveTextContent("+8")
		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeMore" }))
		expect(screen.getByText("four.ts")).toBeInTheDocument()
		expect(onExpandedChange).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeLess" }))
		expect(screen.queryByText("four.ts")).not.toBeInTheDocument()
	})

	it("keeps expanding a diff separate from opening the file in the editor", () => {
		render(<FileChangesPanel clineMessages={[edit("src/one.ts")]} taskId="one" />)
		const toggle = screen.getByRole("button", { name: /src\/one.ts \+2 -1/ })
		expect(toggle.tagName).toBe("BUTTON")
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByTestId("file-diff")).toHaveTextContent("-old +new")
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "readFileContent", text: "src/one.ts" })
		fireEvent.click(screen.getByRole("button", { name: "chat:fileChangesInConversation.openFile" }))
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "openFile", text: "./src/one.ts" })
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(toggle)
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it("resets disclosure state when changing tasks and excludes unapproved edits", () => {
		const messages = [edit("one.ts"), edit("pending.ts", { isAnswered: false })]
		const { rerender } = render(<FileChangesPanel clineMessages={messages} taskId="one" />)
		expect(screen.queryByText("pending.ts")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /one.ts \+2 -1/ }))
		rerender(<FileChangesPanel clineMessages={messages} taskId="two" />)
		expect(screen.getByRole("button", { name: /one.ts \+2 -1/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it("renders nothing when no edits have been applied", () => {
		const { container } = render(<FileChangesPanel clineMessages={[edit("pending.ts", { isAnswered: false })]} />)
		expect(container).toBeEmptyDOMElement()
	})
})
