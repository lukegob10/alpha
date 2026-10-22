import React from "react"
import { createTwoFilesPatch } from "diff"
import { act, fireEvent, render, screen, within } from "@/utils/test-utils"
import { openDiffPayloadSchema, type AlphaMessage } from "@alpha-code/types"
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
		t: (key: string, opts?: { count?: number; path?: string }) => {
			if (key === "chat:fileChangesInConversation.header" && opts?.count != null) {
				return `Files edited: ${opts.count}`
			}
			if (key === "chat:fileChangesInConversation.openAllDiffs") return "Review"
			if (key === "chat:fileChangesInConversation.diffTitle") return "Alpha Diff"
			if (key === "chat:fileChangesInConversation.diffTitleForFile") return `Alpha Diff: ${opts?.path}`
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
): AlphaMessage {
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

function completedCommandEdit(
	path: string,
	originalContent: string,
	finalContent: string,
	commandExecutionId: string,
): AlphaMessage {
	const lineCount = (content: string) => (content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0)
	return {
		type: "say",
		say: "tool",
		ts: Date.now(),
		text: JSON.stringify({
			tool: "appliedDiff",
			path,
			diff: createTwoFilesPatch(path, path, originalContent, finalContent),
			diffStats: { added: lineCount(finalContent), removed: lineCount(originalContent) },
			originalContent,
			finalContent,
			changeStatus: "applied",
			commandExecutionId,
		}),
	}
}

function renderPanel(messages: AlphaMessage[] | undefined, taskId?: string, expandPanel = true) {
	const result = render(
		<TranslationProvider>
			<FileChangesPanel clineMessages={messages} taskId={taskId} />
		</TranslationProvider>,
	)
	if (expandPanel) {
		const header = screen.queryByText(/Files edited:/)
		const trigger = header?.closest("button")
		if (trigger) fireEvent.click(trigger)
	}
	return result
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
		const messages: AlphaMessage[] = [
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
		const messages: AlphaMessage[] = [
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

	it("shows line counts for a newly added file from apply_patch", () => {
		renderPanel([
			{
				type: "ask",
				ask: "tool",
				ts: 1,
				isAnswered: true,
				text: JSON.stringify({
					tool: "newFileCreated",
					path: "new.txt",
					diff: "--- /dev/null\n+++ new.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n",
					diffStats: { added: 2, removed: 0 },
				}),
			},
		])

		expect(screen.getByText("new.txt")).toBeInTheDocument()
		expect(screen.getByTestId("total-added")).toHaveTextContent("+2")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-0")
	})

	it("does not attribute a generic shell command to a file edit", () => {
		const { container } = renderPanel([
			{ type: "ask", ask: "command", ts: 1, isAnswered: true, text: "Set-Content new.txt 'hello'" },
			{ type: "say", say: "command_output", ts: 2, text: "success" },
		])

		expect(container.firstChild).toBeNull()
	})

	it("renders one row per unique path when multiple files edited", () => {
		const messages = [createFileEditMessage("src/a.ts", "diff a"), createFileEditMessage("src/b.ts", "diff b")]
		renderPanel(messages)

		expect(screen.getByText("Files edited: 2")).toBeInTheDocument()
		expect(screen.getByText("src/a.ts")).toBeInTheDocument()
		expect(screen.getByText("src/b.ts")).toBeInTheDocument()
	})

	it("starts collapsed and reveals the file list on demand", () => {
		const messages = [createFileEditMessage("src/foo.ts", "diff")]
		renderPanel(messages, undefined, false)

		// Header visible
		const headerText = screen.getByText("Files edited: 1")
		expect(headerText).toBeInTheDocument()
		// Trigger is the button that contains the header text
		const trigger = headerText.closest("button")
		expect(trigger).toBeInTheDocument()

		expect(trigger).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("src/foo.ts")).not.toBeInTheDocument()
		fireEvent.click(trigger!)
		expect(screen.getByText("src/foo.ts")).toBeInTheDocument()
		fireEvent.click(trigger!)
		expect(screen.queryByText("src/foo.ts")).not.toBeInTheDocument()
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

	it("counts a completed command edit once when an answered preview matches", () => {
		const completed = completedCommandEdit("src/file.ts", "before\n", "after\n", "run-1")
		const preview = createFileEditMessage("src/file.ts", JSON.parse(completed.text!).diff, {
			added: 7,
			removed: 7,
		})
		renderPanel([preview, completed])

		expect(screen.getByText("Files edited: 1")).toBeInTheDocument()
		expect(screen.getByTestId("total-added")).toHaveTextContent("+1")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-1")
	})

	it("merges multiple command edits from the first before content to the last captured after content", () => {
		renderPanel([
			completedCommandEdit("src/file.ts", "first\n", "middle\n", "run-1"),
			completedCommandEdit("src/file.ts", "middle\n", "last\n", "run-2"),
		])

		expect(screen.getByTestId("total-added")).toHaveTextContent("+1")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-1")
		fireEvent.click(screen.getByRole("button", { name: "src/file.ts" }))
		const displayedDiff = screen.getByTestId("file-diff")
		expect(displayedDiff).toHaveTextContent("-first")
		expect(displayedDiff).toHaveTextContent("+last")
		expect(displayedDiff).not.toHaveTextContent("middle")
		expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "readFileContent", text: "src/file.ts" })

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "fileContent",
						fileContent: { path: "src/file.ts", content: "later external edit\n" },
					},
				}),
			)
		})
		expect(screen.getByTestId("file-diff")).toHaveTextContent("+last")
		expect(screen.getByTestId("file-diff")).not.toHaveTextContent("later external edit")
	})

	it("renders a completed deletion with empty final content without reading the live file", () => {
		renderPanel([completedCommandEdit("src/file.ts", "before\n", "", "run-1")])
		fireEvent.click(screen.getByRole("button", { name: "src/file.ts" }))

		expect(screen.getByTestId("file-diff")).toHaveTextContent("-before")
		expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "readFileContent", text: "src/file.ts" })
	})

	it("shows net line counts after successive rewrite, repair, and format commands", () => {
		const content = (prefix: string, count: number) =>
			Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join("\n") + "\n"
		renderPanel([
			completedCommandEdit("src/auth.ts", content("original", 60), content("rewrite", 130), "run-1"),
			completedCommandEdit("src/auth.ts", content("rewrite", 130), content("repair", 100), "run-2"),
			completedCommandEdit("src/auth.ts", content("repair", 100), content("formatted", 81), "run-3"),
		])

		expect(screen.getByTestId("total-added")).toHaveTextContent("+81")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-60")
		const showDiff = screen.getByRole("button", { name: "chat:fileChangesInConversation.openDiff" })
		expect(within(showDiff).getByText("+81")).toBeInTheDocument()
		expect(within(showDiff).getByText("-60")).toBeInTheDocument()
	})

	it("groups relative path aliases for successive edits to one file", () => {
		renderPanel([
			completedCommandEdit("./src/file.ts", "first\n", "middle\n", "run-1"),
			completedCommandEdit("src/file.ts", "middle\n", "last\n", "run-2"),
		])

		expect(screen.getByText("Files edited: 1")).toBeInTheDocument()
		expect(screen.getByTestId("total-added")).toHaveTextContent("+1")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-1")
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
		fireEvent.click(screen.getByText("Files edited: 1").closest("button")!)
		expect(screen.getByRole("button", { name: /^src\/foo.ts/ })).toHaveAttribute("aria-expanded", "false")
	})
})

function edit(path: string, overrides: Partial<AlphaMessage> = {}): AlphaMessage {
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

describe("Review disclosure", () => {
	beforeEach(() => vi.clearAllMocks())

	const capturedFiles = (count: number) =>
		Array.from({ length: count }, (_, index) =>
			completedCommandEdit(
				`src/file-${index + 1}.ts`,
				`before-${index + 1}\n`,
				`after-${index + 1}\n`,
				`edit-${index + 1}`,
			),
		)
	const fileToggle = (path: string) => screen.getByText(path).closest("button")!
	const clickReview = () => fireEvent.click(screen.getByRole("button", { name: "Review" }))

	it("opens the three-file list with only its bottom captured diff expanded", () => {
		renderPanel(capturedFiles(3), "task-a", false)
		clickReview()

		expect(screen.getByText("Files edited: 3").closest("button")).toHaveAttribute("aria-expanded", "true")
		expect(screen.getAllByText(/^src\/file-\d\.ts$/).map((label) => label.textContent)).toEqual([
			"src/file-1.ts",
			"src/file-2.ts",
			"src/file-3.ts",
		])
		expect(fileToggle("src/file-1.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-2.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-3.ts")).toHaveAttribute("aria-expanded", "true")
		expect(screen.getAllByTestId("file-diff")).toHaveLength(1)
		expect(screen.getByTestId("file-diff")).toHaveTextContent("-before-3")
		expect(screen.getByTestId("file-diff")).toHaveTextContent("+after-3")
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
	})

	it("reveals every file when Review starts beyond the compact three-row limit", () => {
		renderPanel(capturedFiles(5), "task-a", false)
		clickReview()

		expect(screen.getAllByText(/^src\/file-\d\.ts$/)).toHaveLength(5)
		for (const index of [1, 2, 3, 4]) {
			expect(fileToggle(`src/file-${index}.ts`)).toHaveAttribute("aria-expanded", "false")
		}
		expect(fileToggle("src/file-5.ts")).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByRole("button", { name: "chat:task.seeLess" })).toBeInTheDocument()
	})

	it("keeps manual file choices through final output updates and newly appended files", () => {
		const messages = capturedFiles(3)
		const { rerender } = renderPanel(messages, "task-a", false)
		clickReview()
		fireEvent.click(fileToggle("src/file-3.ts"))
		fireEvent.click(fileToggle("src/file-1.ts"))
		const updated: AlphaMessage[] = [
			...messages,
			completedCommandEdit("src/file-1.ts", "after-1\n", "final-1\n", "edit-1-final"),
			completedCommandEdit("src/file-3.ts", "after-3\n", "final-3\n", "edit-3-final"),
			completedCommandEdit("src/file-4.ts", "before-4\n", "after-4\n", "edit-4"),
			{ type: "say", say: "text", ts: 50, text: "Final response", partial: true },
		]
		rerender(
			<TranslationProvider>
				<FileChangesPanel clineMessages={updated} taskId="task-a" />
			</TranslationProvider>,
		)

		expect(fileToggle("src/file-1.ts")).toHaveAttribute("aria-expanded", "true")
		expect(fileToggle("src/file-2.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-3.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-4.ts")).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByTestId("file-diff")).toHaveTextContent("-before-1")
		expect(screen.getByTestId("file-diff")).toHaveTextContent("+final-1")
		rerender(
			<TranslationProvider>
				<FileChangesPanel
					clineMessages={updated.map((message) => ({ ...message, partial: false }))}
					taskId="task-a"
				/>
			</TranslationProvider>,
		)
		clickReview()
		expect(fileToggle("src/file-1.ts")).toHaveAttribute("aria-expanded", "true")
		expect(fileToggle("src/file-3.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-4.ts")).toHaveAttribute("aria-expanded", "false")
	})

	it("lets the user close the bottom file and keep the entire list closed on later Review clicks", () => {
		renderPanel(capturedFiles(3), "task-a", false)
		clickReview()
		fireEvent.click(fileToggle("src/file-3.ts"))
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Files edited: 3").closest("button")!)
		clickReview()

		for (const index of [1, 2, 3]) {
			expect(fileToggle(`src/file-${index}.ts`)).toHaveAttribute("aria-expanded", "false")
		}
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it("initializes Review again after changing tasks without reusing prior file choices", () => {
		const messages = capturedFiles(3)
		const { rerender } = renderPanel(messages, "task-a", false)
		clickReview()
		fireEvent.click(fileToggle("src/file-3.ts"))
		fireEvent.click(fileToggle("src/file-1.ts"))
		rerender(
			<TranslationProvider>
				<FileChangesPanel clineMessages={messages} taskId="task-b" />
			</TranslationProvider>,
		)
		expect(screen.getByText("Files edited: 3").closest("button")).toHaveAttribute("aria-expanded", "false")
		clickReview()

		expect(fileToggle("src/file-1.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-2.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-3.ts")).toHaveAttribute("aria-expanded", "true")
	})

	it("keeps per-file native diff actions bound to the captured content after inline Review", () => {
		renderPanel(capturedFiles(3), "task-a", false)
		clickReview()
		fireEvent.click(screen.getAllByRole("button", { name: "chat:fileChangesInConversation.openDiff" })[0]!)

		expect(mockPostMessage).toHaveBeenCalledTimes(2)
		expect(mockPostMessage).toHaveBeenLastCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: src/file-1.ts",
				files: [{ path: "src/file-1.ts", originalContent: "before-1\n", finalContent: "after-1\n" }],
			},
		})
		expect(fileToggle("src/file-1.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-3.ts")).toHaveAttribute("aria-expanded", "true")
	})

	it("keeps single-file Review native and initializes the list if a second file arrives", () => {
		const first = capturedFiles(1)
		const { rerender } = renderPanel(first, "task-a", false)
		clickReview()
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: src/file-1.ts",
				files: [{ path: "src/file-1.ts", originalContent: "before-1\n", finalContent: "after-1\n" }],
			},
		})
		expect(screen.queryByText("src/file-1.ts")).not.toBeInTheDocument()
		mockPostMessage.mockClear()
		rerender(
			<TranslationProvider>
				<FileChangesPanel clineMessages={capturedFiles(2)} taskId="task-a" />
			</TranslationProvider>,
		)
		clickReview()
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(fileToggle("src/file-1.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-2.ts")).toHaveAttribute("aria-expanded", "true")
	})

	it("opens the bottom displayed legacy diff even when it has no native snapshot", () => {
		renderPanel([...capturedFiles(2), edit("src/legacy.ts")], "task-a", false)
		clickReview()

		expect(fileToggle("src/file-1.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-2.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/legacy.ts")).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByTestId("file-diff")).toHaveTextContent("-old +new")
	})

	it("preserves an earlier file the user explicitly opened before first Review", () => {
		renderPanel(capturedFiles(3), "task-a")
		fireEvent.click(fileToggle("src/file-1.ts"))
		clickReview()

		expect(fileToggle("src/file-1.ts")).toHaveAttribute("aria-expanded", "true")
		expect(fileToggle("src/file-2.ts")).toHaveAttribute("aria-expanded", "false")
		expect(fileToggle("src/file-3.ts")).toHaveAttribute("aria-expanded", "true")
	})

	it("keeps a bottom file explicitly closed before first Review closed", () => {
		renderPanel(capturedFiles(3), "task-a")
		fireEvent.click(fileToggle("src/file-3.ts"))
		fireEvent.click(fileToggle("src/file-3.ts"))
		clickReview()

		for (const index of [1, 2, 3]) {
			expect(fileToggle(`src/file-${index}.ts`)).toHaveAttribute("aria-expanded", "false")
		}
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})
})

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
		fireEvent.click(screen.getByText("Files edited: 4").closest("button")!)
		expect(screen.getByRole("button", { name: "one.ts" })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("four.ts")).not.toBeInTheDocument()
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalled()
		expect(screen.getByTestId("total-added")).toHaveTextContent("+8")
		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeMore" }))
		expect(screen.getByText("four.ts")).toBeInTheDocument()
		expect(onExpandedChange).toHaveBeenCalledTimes(2)
		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeLess" }))
		expect(screen.queryByText("four.ts")).not.toBeInTheDocument()
	})

	it("uses the side action to expand and collapse the file diff", () => {
		renderPanel([edit("src/one.ts")], "one", true)
		const toggle = screen.getByRole("button", { name: "src/one.ts" })
		expect(toggle.tagName).toBe("BUTTON")
		const diffAction = screen.getByRole("button", { name: "chat:fileChangesInConversation.openDiff" })
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(diffAction)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByTestId("file-diff")).toHaveTextContent("-old +new")
		expect(mockPostMessage).not.toHaveBeenCalled()
		fireEvent.click(diffAction)
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it("reviews the captured change set natively and keeps inline and individual diff actions", () => {
		const first = completedCommandEdit("src/one.ts", "old\n", "new\n", "run-1")
		const second = completedCommandEdit("src/two.ts", "before\n", "after\n", "run-2")
		renderPanel([first, second], "one", false)

		const allDiffs = screen.getByRole("button", { name: "Review" })
		expect(allDiffs).toBeEnabled()
		fireEvent.click(allDiffs)
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("button", { name: /^src\/one.ts/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByRole("button", { name: /^src\/two.ts/ })).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(screen.getAllByRole("button", { name: "chat:fileChangesInConversation.openDiff" })[0]!)
		expect(mockPostMessage).toHaveBeenLastCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: src/one.ts",
				files: [expect.objectContaining({ path: "src/one.ts" })],
			},
		})
	})

	it("reviews a grouped approval natively while preserving its inline and individual snapshots", () => {
		const message: AlphaMessage = {
			type: "ask",
			ask: "tool",
			ts: 1,
			isAnswered: true,
			text: JSON.stringify({
				tool: "appliedDiff",
				batchDiffs: [
					{
						path: "bootstrap.py",
						content: "-old\n+new",
						originalContent: "old\n",
						finalContent: "new\n",
					},
					{
						path: "config.py",
						content: "-before\n+after",
						originalContent: "before\n",
						finalContent: "after\n",
					},
				],
			}),
		}
		renderPanel([message], "grouped-edit", false)
		const allDiffs = screen.getByRole("button", { name: "Review" })
		expect(allDiffs).toBeEnabled()
		fireEvent.click(allDiffs)
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("button", { name: /^bootstrap.py/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByRole("button", { name: /^config.py/ })).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(screen.getAllByRole("button", { name: "chat:fileChangesInConversation.openDiff" })[1]!)
		expect(mockPostMessage).toHaveBeenLastCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: config.py",
				files: [{ path: "config.py", originalContent: "before\n", finalContent: "after\n" }],
			},
		})
	})

	it("resets disclosure state when changing tasks and excludes unapproved edits", () => {
		const messages = [edit("one.ts"), edit("pending.ts", { isAnswered: false })]
		const { rerender } = render(<FileChangesPanel clineMessages={messages} taskId="one" />)
		expect(screen.queryByText("pending.ts")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Files edited: 1").closest("button")!)
		fireEvent.click(screen.getByRole("button", { name: "one.ts" }))
		rerender(<FileChangesPanel clineMessages={messages} taskId="two" />)
		fireEvent.click(screen.getByText("Files edited: 1").closest("button")!)
		expect(screen.getByRole("button", { name: "one.ts" })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it("renders nothing when no edits have been applied", () => {
		const { container } = render(<FileChangesPanel clineMessages={[edit("pending.ts", { isAnswered: false })]} />)
		expect(container).toBeEmptyDOMElement()
	})
})

describe("Review editor routing regressions", () => {
	beforeEach(() => vi.clearAllMocks())

	it("opens every captured file in the native diff while expanding inline review", () => {
		renderPanel(
			[
				completedCommandEdit("src/one.ts", "old\n", "new\n", "one"),
				completedCommandEdit("src/two.ts", "before\n", "after\n", "two"),
			],
			"captured-review",
			false,
		)

		fireEvent.click(screen.getByRole("button", { name: "Review" }))

		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff",
				files: [
					{ path: "src/one.ts", originalContent: "old\n", finalContent: "new\n" },
					{ path: "src/two.ts", originalContent: "before\n", finalContent: "after\n" },
				],
			},
		})
		expect(screen.getByText("Files edited: 2").closest("button")).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByRole("button", { name: /^src\/two.ts/ })).toHaveAttribute("aria-expanded", "true")
	})

	it.each([1, 3])("reviews %i legacy files inline without captured snapshots", (count) => {
		renderPanel(
			Array.from({ length: count }, (_, index) => edit(`legacy-${index + 1}.ts`)),
			"legacy-review",
			false,
		)
		const review = screen.getByRole("button", { name: "Review" })
		expect(review).toBeEnabled()

		fireEvent.click(review)

		expect(screen.getByText(`Files edited: ${count}`).closest("button")).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByRole("button", { name: new RegExp(`^legacy-${count}\\.ts`) })).toHaveAttribute(
			"aria-expanded",
			"true",
		)
		expect(screen.getByTestId("file-diff")).toHaveTextContent("-old +new")
		expect(mockPostMessage).not.toHaveBeenCalled()
	})

	it("keeps long-path native diff titles within the host payload limit", () => {
		const path = `src/${"nested/".repeat(40)}file.ts`
		renderPanel([completedCommandEdit(path, "before\n", "after\n", "long-path")])

		fireEvent.click(screen.getByRole("button", { name: "chat:fileChangesInConversation.openDiff" }))

		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff",
				files: [{ path, originalContent: "before\n", finalContent: "after\n" }],
			},
		})
	})

	it("opens the captured native diff when clicking a file's added-line count", () => {
		renderPanel([completedCommandEdit("src/one.ts", "before\n", "after\n", "counter-review")])
		const showDiff = screen.getByRole("button", { name: "chat:fileChangesInConversation.openDiff" })

		fireEvent.click(within(showDiff).getByText("+1"))

		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: src/one.ts",
				files: [{ path: "src/one.ts", originalContent: "before\n", finalContent: "after\n" }],
			},
		})
		expect(screen.getByRole("button", { name: "src/one.ts" })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it("keeps reviews over the native file limit complete inline with working individual diff actions", () => {
		const paths = Array.from({ length: 129 }, (_, index) => `src/file-${index}.ts`)
		renderPanel(
			paths.map((path) => completedCommandEdit(path, "before\n", "after\n", path)),
			"large-review",
			false,
		)

		fireEvent.click(screen.getByRole("button", { name: "Review" }))

		expect(mockPostMessage).not.toHaveBeenCalled()
		expect(screen.getAllByText(/^src\/file-\d+\.ts$/).map((label) => label.textContent)).toEqual(paths)
		expect(screen.getByRole("button", { name: "src/file-128.ts" })).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(screen.getAllByRole("button", { name: "chat:fileChangesInConversation.openDiff" })[64]!)
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		const payload = openDiffPayloadSchema.parse(mockPostMessage.mock.calls[0]![0].payload)
		expect(payload.files).toEqual([{ path: paths[64], originalContent: "before\n", finalContent: "after\n" }])
	})
})
