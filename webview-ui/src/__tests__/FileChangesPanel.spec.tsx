import React from "react"
import userEvent from "@testing-library/user-event"
import { createTwoFilesPatch, diffLines } from "diff"
import { act, fireEvent, render, screen, within } from "@/utils/test-utils"
import { openDiffPayloadSchema, type AlphaMessage } from "@alpha-code/types"
import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"
import FileChangesPanel from "../components/chat/FileChangesPanel"
import { installNativeTestFocus } from "@src/utils/test-native-focus"

const mockPostMessage = vi.fn()

vi.mock("diff", async (importOriginal) => {
	const actual = await importOriginal<typeof import("diff")>()
	return { ...actual, createTwoFilesPatch: vi.fn(actual.createTwoFilesPatch), diffLines: vi.fn(actual.diffLines) }
})

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
			if (key === "chat:fileChangesInConversation.openDiff") return `Show diff: ${opts?.path}`
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
			<FileChangesPanel alphaMessages={messages} taskId={taskId} />
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

	it("renders nothing when alphaMessages is undefined", () => {
		const { container } = renderPanel(undefined)
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when alphaMessages is empty", () => {
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

	it("opens the whole file row without creating an inline disclosure or a second button", () => {
		renderPanel([createFileEditMessage("src/foo.ts", "-old\n+new")])
		const row = screen.getByRole("button", { name: "Show diff: src/foo.ts" })
		expect(row).not.toHaveAttribute("aria-expanded")
		expect(row).not.toHaveAttribute("aria-controls")
		expect(row.querySelector("button, svg")).toBeNull()
		fireEvent.click(screen.getByText("src/foo.ts"))
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: src/foo.ts",
				patch: { path: "src/foo.ts", content: "Index: src/foo.ts\n-old\n+new" },
			},
		})
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
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
		fireEvent.click(screen.getByRole("button", { name: "Show diff: src/file.ts" }))
		expect(mockPostMessage).toHaveBeenLastCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: src/file.ts",
				files: [{ path: "src/file.ts", originalContent: "first\n", finalContent: "last\n" }],
			},
		})
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
		fireEvent.click(screen.getByRole("button", { name: "Show diff: src/file.ts" }))
		expect(mockPostMessage.mock.calls[1]).toEqual(mockPostMessage.mock.calls[0])
		expect(mockPostMessage.mock.calls.every(([message]) => message.type === "openDiff")).toBe(true)
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it("opens a completed deletion with empty final content without reading the live file", () => {
		renderPanel([completedCommandEdit("src/file.ts", "before\n", "", "run-1")])
		fireEvent.click(screen.getByRole("button", { name: "Show diff: src/file.ts" }))
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: src/file.ts",
				files: [{ path: "src/file.ts", originalContent: "before\n", finalContent: "" }],
			},
		})
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
		const showDiff = screen.getByRole("button", { name: "Show diff: src/auth.ts" })
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

	it.each(["canonical", "legacy"] as const)(
		"folds open file changes when their turn completes and permits reopening (%s)",
		(source) => {
			const identity = source === "canonical" ? { runId: "file-run", turnId: "file-turn" } : undefined
			const edit = { ...createFileEditMessage("src/foo.ts", "diff"), ts: 100, turn: identity }
			const view = renderPanel([edit], "file-turn")
			fireEvent.click(screen.getByRole("button", { name: "Show diff: src/foo.ts" }))
			expect(screen.getByRole("button", { name: "Show diff: src/foo.ts" })).toBeVisible()
			const completed: AlphaMessage[] = [
				edit,
				{
					ts: 200,
					type: "say",
					say: source === "canonical" ? "text" : "completion_result",
					text: "Updated the file",
					turn: identity ? { ...identity, terminalStatus: "completed" } : undefined,
				},
			]
			const publish = (messages: AlphaMessage[]) =>
				view.rerender(
					<TranslationProvider>
						<FileChangesPanel alphaMessages={messages} taskId="file-turn" />
					</TranslationProvider>,
				)
			publish(completed)
			const trigger = screen.getByText("Files edited: 1").closest("button")!
			expect(trigger).toHaveAttribute("aria-expanded", "false")
			expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
			fireEvent.click(trigger)
			expect(trigger).toHaveAttribute("aria-expanded", "true")
			expect(screen.getByRole("button", { name: "Show diff: src/foo.ts" })).toBeVisible()
			publish([
				...completed,
				{ ts: 250, type: "say", say: "command_output", text: "Late captured output", turn: identity },
			])
			expect(trigger).toHaveAttribute("aria-expanded", "true")
			expect(screen.getByRole("button", { name: "Show diff: src/foo.ts" })).toBeVisible()
		},
	)

	it.each(["details", "composer"] as const)(
		"preserves keyboard focus when completion folds file changes (%s)",
		(owner) => {
			const restoreFocus = installNativeTestFocus()
			const composer = document.createElement("textarea")
			document.body.append(composer)
			try {
				const identity = { runId: "focus-run", turnId: "focus-turn" }
				const edit = { ...createFileEditMessage("src/foo.ts", "diff"), ts: 100, turn: identity }
				const view = renderPanel([edit], "focus-turn")
				const trigger = screen.getByText("Files edited: 1").closest("button")!
				const file = screen.getByRole("button", { name: "Show diff: src/foo.ts" })
				const focused = owner === "details" ? file : composer
				focused.focus()
				expect(focused).toHaveFocus()
				view.rerender(
					<TranslationProvider>
						<FileChangesPanel
							taskId="focus-turn"
							alphaMessages={[
								edit,
								{
									ts: 200,
									type: "say",
									say: "text",
									text: "Done",
									turn: { ...identity, terminalStatus: "completed" },
								},
							]}
						/>
					</TranslationProvider>,
				)
				expect(trigger).toHaveAttribute("aria-expanded", "false")
				expect(owner === "details" ? trigger : composer).toHaveFocus()
			} finally {
				composer.remove()
				restoreFocus()
			}
		},
	)

	it("does not generate or render inline patches during unrelated text streaming", () => {
		const original = Array.from({ length: 10_000 }, (_, index) => `line ${index}\n`).join("")
		const edits = [
			completedCommandEdit("large.ts", original, original.replace("line 5000\n", "changed 5000\n"), "large"),
		]
		const { rerender } = renderPanel(edits, "streaming")
		vi.mocked(createTwoFilesPatch).mockClear()
		for (let delta = 0; delta < 20; delta++) {
			rerender(
				<FileChangesPanel
					alphaMessages={[
						...edits,
						{ type: "say", say: "text", ts: 100, text: `Streaming ${delta}`, partial: true },
					]}
					taskId="streaming"
				/>,
			)
		}
		expect(createTwoFilesPatch).not.toHaveBeenCalled()
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})
})

describe("Net stats caching", () => {
	beforeEach(() => vi.clearAllMocks())

	const capturedFiles = (count: number) =>
		Array.from({ length: count }, (_, index) =>
			completedCommandEdit(`src/file-${index}.ts`, `before-${index}\n`, `after-${index}\n`, `edit-${index}`),
		)
	const panel = (messages: AlphaMessage[], taskId = "stats-task") => (
		<TranslationProvider>
			<FileChangesPanel alphaMessages={messages} taskId={taskId} />
		</TranslationProvider>
	)
	const stream = (messages: AlphaMessage[], delta: number): AlphaMessage[] => [
		...messages,
		{ type: "say", say: "text", ts: 10_000, text: `Checking ${delta}`, partial: true },
	]

	it("keeps the bounded active-path cache warm above its 128-file limit during text streaming", () => {
		const edits = capturedFiles(129)
		const view = render(panel(edits))
		// Warm after the task disclosure reset effect, before measuring independent stream deltas.
		view.rerender(panel(stream(edits, 0)))
		vi.mocked(diffLines).mockClear()

		for (let delta = 1; delta <= 20; delta++) {
			view.rerender(panel(stream(edits, delta)))
		}

		expect(diffLines).toHaveBeenCalledTimes(20)
		expect(vi.mocked(diffLines).mock.calls.every(([original]) => original === "before-128\n")).toBe(true)
		expect(screen.getByTestId("total-added")).toHaveTextContent("+129")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-129")
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it.each([
		{
			endpoint: "original",
			originalContent: "before-0\nextra\n",
			finalContent: "after-0\n",
			added: 129,
			removed: 130,
		},
		{
			endpoint: "final",
			originalContent: "before-0\n",
			finalContent: "after-0\nextra\n",
			added: 130,
			removed: 129,
		},
	])("refreshes cached $endpoint endpoints while preserving every file's net stats", (replacement) => {
		const edits = capturedFiles(129)
		const view = render(panel(edits))
		view.rerender(panel(stream(edits, 0)))
		const updated = [
			completedCommandEdit("src/file-0.ts", replacement.originalContent, replacement.finalContent, "replacement"),
			...edits.slice(1),
		]
		vi.mocked(diffLines).mockClear()

		view.rerender(panel(updated))

		expect(diffLines).toHaveBeenCalledTimes(2)
		expect(diffLines).toHaveBeenCalledWith(replacement.originalContent, replacement.finalContent)
		expect(screen.getByTestId("total-added")).toHaveTextContent(`+${replacement.added}`)
		expect(screen.getByTestId("total-removed")).toHaveTextContent(`-${replacement.removed}`)
		vi.mocked(diffLines).mockClear()
		view.rerender(panel(stream(updated, 1)))
		expect(diffLines).toHaveBeenCalledTimes(1)
	})

	it("releases removed paths so remaining and replacement snapshots can fill the bounded cache", () => {
		const edits = capturedFiles(129)
		const view = render(panel(edits))
		view.rerender(panel(stream(edits, 0)))
		const remaining = edits.slice(1)
		vi.mocked(diffLines).mockClear()

		view.rerender(panel(remaining))

		expect(diffLines).toHaveBeenCalledTimes(1)
		expect(diffLines).toHaveBeenCalledWith("before-128\n", "after-128\n")
		vi.mocked(diffLines).mockClear()
		view.rerender(panel(stream(remaining, 1)))
		expect(diffLines).not.toHaveBeenCalled()

		const replacement = [
			...remaining.slice(1),
			completedCommandEdit("src/replacement.ts", "", "one\ntwo\n", "new-path"),
		]
		view.rerender(panel(replacement))
		expect(diffLines).toHaveBeenCalledTimes(1)
		expect(diffLines).toHaveBeenCalledWith("", "one\ntwo\n")
		expect(screen.getByText("Files edited: 128")).toBeInTheDocument()
		expect(screen.getByTestId("total-added")).toHaveTextContent("+129")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-127")
		vi.mocked(diffLines).mockClear()
		view.rerender(panel(stream(replacement, 2)))
		expect(diffLines).not.toHaveBeenCalled()
	})

	it("clears prior-task snapshots before caching the next task's updates", () => {
		const edits = capturedFiles(1)
		const view = render(panel(edits, "task-a"))
		view.rerender(panel(stream(edits, 0), "task-a"))
		view.rerender(panel(edits, "task-b"))
		vi.mocked(diffLines).mockClear()

		view.rerender(panel(stream(edits, 1), "task-b"))

		expect(diffLines).toHaveBeenCalledTimes(1)
		const updated = [completedCommandEdit("src/file-0.ts", "old\n", "new\nextra\n", "next-task-edit")]
		view.rerender(panel(updated, "task-b"))
		expect(diffLines).toHaveBeenCalledWith("old\n", "new\nextra\n")
		expect(screen.getByTestId("total-added")).toHaveTextContent("+2")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-1")
	})
})

describe("Review editor actions", () => {
	beforeEach(() => vi.clearAllMocks())
	const capturedFiles = (count: number) =>
		Array.from({ length: count }, (_, index) =>
			completedCommandEdit(`src/file-${index}.ts`, `before-${index}\n`, `after-${index}\n`, `edit-${index}`),
		)

	it.each([1, 3, 5])("reviews all %i captured files without expanding the chat", (count) => {
		const onExpandedChange = vi.fn()
		render(
			<FileChangesPanel
				alphaMessages={capturedFiles(count)}
				taskId="review"
				onExpandedChange={onExpandedChange}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Review" }))
		expect(onExpandedChange).not.toHaveBeenCalled()
		expect(screen.getByText(`Files edited: ${count}`).closest("button")).toHaveAttribute("aria-expanded", "false")
		const payload = openDiffPayloadSchema.parse(mockPostMessage.mock.calls[0][0].payload)
		expect(payload).toMatchObject({
			files: Array.from({ length: count }, (_, index) => ({
				path: `src/file-${index}.ts`,
				originalContent: `before-${index}\n`,
				finalContent: `after-${index}\n`,
			})),
		})
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it.each(["{Enter}", " "])("opens a full captured row using %s", async (key) => {
		const restoreFocus = installNativeTestFocus()
		try {
			const user = userEvent.setup()
			renderPanel(capturedFiles(1))
			const row = screen.getByRole("button", { name: "Show diff: src/file-0.ts" })
			row.focus()
			await user.keyboard(key)
			expect(mockPostMessage).toHaveBeenCalledTimes(1)
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "openDiff",
				payload: {
					title: "Alpha Diff: src/file-0.ts",
					files: [{ path: "src/file-0.ts", originalContent: "before-0\n", finalContent: "after-0\n" }],
				},
			})
			expect(row).not.toHaveAttribute("aria-expanded")
		} finally {
			restoreFocus()
		}
	})

	it("uses one file row for both the filename and line counts", () => {
		renderPanel(capturedFiles(1))
		const row = screen.getByRole("button", { name: "Show diff: src/file-0.ts" })
		fireEvent.click(within(row).getByText("+1"))
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(screen.getAllByRole("button")).toHaveLength(3)
		expect(screen.queryByTestId("file-diff")).not.toBeInTheDocument()
	})

	it("keeps the compact list and shows more filenames without inline diffs", () => {
		renderPanel(capturedFiles(5))
		expect(screen.queryByText("src/file-4.ts")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeMore" }))
		expect(screen.getByText("src/file-4.ts")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeLess" }))
		expect(screen.queryByText("src/file-4.ts")).not.toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalled()
	})

	it("keeps mixed and legacy reviews complete in a saved patch editor", () => {
		renderPanel([...capturedFiles(2), createFileEditMessage("legacy.ts", "-legacy\n+fixed")], "mixed", false)
		fireEvent.click(screen.getByRole("button", { name: "Review" }))
		const payload = openDiffPayloadSchema.parse(mockPostMessage.mock.calls[0][0].payload)
		expect(payload).toMatchObject({ title: "Alpha Diff", patch: { path: "review" } })
		if (!("patch" in payload)) throw new Error("Expected saved patch review")
		for (const file of ["src/file-0.ts", "src/file-1.ts", "legacy.ts"])
			expect(payload.patch.content).toContain(`Index: ${file}`)
		expect(payload.patch.content).toContain("-legacy\n+fixed")
		expect(screen.getByText("Files edited: 3").closest("button")).toHaveAttribute("aria-expanded", "false")
	})

	it("keeps large reviews complete and individual captured diffs available", () => {
		renderPanel(capturedFiles(129))
		fireEvent.click(screen.getByRole("button", { name: "Review" }))
		const payload = openDiffPayloadSchema.parse(mockPostMessage.mock.calls[0][0].payload)
		if (!("patch" in payload)) throw new Error("Expected bounded native request with saved patch fallback")
		expect(payload.patch.content.match(/Index: src\/file-/g) ?? []).toHaveLength(129)
		fireEvent.click(screen.getByRole("button", { name: "chat:task.seeMore" }))
		fireEvent.click(screen.getByRole("button", { name: "Show diff: src/file-128.ts" }))
		expect(mockPostMessage).toHaveBeenLastCalledWith({
			type: "openDiff",
			payload: {
				title: "Alpha Diff: src/file-128.ts",
				files: [{ path: "src/file-128.ts", originalContent: "before-128\n", finalContent: "after-128\n" }],
			},
		})
	})

	it("uses updated snapshots and resets the filename disclosure on task changes", () => {
		const view = renderPanel(capturedFiles(1), "first")
		const updated = [completedCommandEdit("src/file-0.ts", "earlier\n", "later\n", "updated")]
		view.rerender(
			<TranslationProvider>
				<FileChangesPanel alphaMessages={updated} taskId="first" />
			</TranslationProvider>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Show diff: src/file-0.ts" }))
		expect(mockPostMessage.mock.calls[0][0].payload.files[0]).toEqual({
			path: "src/file-0.ts",
			originalContent: "earlier\n",
			finalContent: "later\n",
		})
		view.rerender(
			<TranslationProvider>
				<FileChangesPanel alphaMessages={[createFileEditMessage("other.ts", "other patch")]} taskId="second" />
			</TranslationProvider>,
		)
		expect(screen.queryByText("src/file-0.ts")).not.toBeInTheDocument()
		expect(screen.queryByText("other.ts")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Files edited: 1").closest("button")!)
		fireEvent.click(screen.getByRole("button", { name: "Show diff: other.ts" }))
		expect(mockPostMessage.mock.calls[1][0].payload.patch.content).toContain("other patch")
	})

	it("keeps long-path titles within the host limit", () => {
		const path = `src/${"nested/".repeat(40)}file.ts`
		renderPanel([completedCommandEdit(path, "before\n", "after\n", "long")])
		fireEvent.click(screen.getByRole("button", { name: `Show diff: ${path}` }))
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: { title: "Alpha Diff", files: [{ path, originalContent: "before\n", finalContent: "after\n" }] },
		})
	})
})
