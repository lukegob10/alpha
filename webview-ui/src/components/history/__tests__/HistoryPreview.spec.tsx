import type { ReactNode } from "react"
import type { HistoryItem } from "@alpha-code/types"
import { fireEvent, render, screen, within } from "@/utils/test-utils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import HistoryPreview from "../HistoryPreview"

vi.mock("@/context/ExtensionStateContext")
vi.mock("@/utils/vscode")
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
// JSDOM has no layout measurements; render the virtual list's supplied items.
vi.mock("react-virtuoso", () => ({
	Virtuoso: ({
		data,
		itemContent,
		"data-testid": testId,
	}: {
		data: unknown[]
		itemContent: (index: number, item: unknown) => ReactNode
		"data-testid"?: string
	}) => (
		<div data-testid={testId}>
			{data.map((item, index) => (
				<div key={index}>{itemContent(index, item)}</div>
			))}
		</div>
	),
}))

const tasks: HistoryItem[] = Array.from({ length: 6 }, (_, index) => ({
	id: `task-${index + 1}`,
	number: index + 1,
	task: index === 0 ? "Repair authentication" : `Saved conversation ${index + 1}`,
	ts: Date.now() - (index + 1) * 60_000,
	tokensIn: 100,
	tokensOut: 50,
	totalCost: 0.01,
	workspace: "/test/workspace",
}))

const setHistory = (taskHistory = tasks, cwd = "/test/workspace") => {
	vi.mocked(useExtensionState).mockReturnValue({ taskHistory, cwd } as ReturnType<typeof useExtensionState>)
}
const manage = () => fireEvent.click(screen.getByRole("button", { name: "history:manageChats" }))
const search = (value: string) => fireEvent.change(screen.getByTestId("history-search-input"), { target: { value } })

describe("inline Chats history", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		setHistory()
	})

	it("shows only five recent compact chats by default without expanded controls or a card", () => {
		render(<HistoryPreview onExpand={vi.fn()} />)
		expect(screen.getByText("history:chats")).toBeInTheDocument()
		expect(screen.getAllByTestId(/^task-item-task-/)).toHaveLength(5)
		expect(screen.queryByTestId("task-item-task-6")).not.toBeInTheDocument()
		expect(screen.queryByTestId("history-search-input")).not.toBeInTheDocument()
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "history:manageChats" })).not.toBeInTheDocument()
		for (const row of screen.getAllByTestId(/^task-item-task-/)) {
			expect(row.closest(".surface-raised")).toBeNull()
		}
	})

	it.each([0, 1, 3])("renders only the available %i chats without empty row placeholders", (count) => {
		setHistory(tasks.slice(0, count))
		render(<HistoryPreview onExpand={vi.fn()} />)
		expect(screen.queryAllByTestId(/^task-item-task-/)).toHaveLength(count)
		expect(screen.queryByTestId("history-search-input")).not.toBeInTheDocument()
		expect(screen.queryByTestId("virtuoso-container")).not.toBeInTheDocument()
	})

	it("requests inline expansion only when View all is activated", () => {
		const onExpand = vi.fn()
		const { rerender } = render(<HistoryPreview onExpand={onExpand} />)
		expect(onExpand).not.toHaveBeenCalled()
		fireEvent.click(screen.getByTestId("history-view-all"))
		expect(onExpand).toHaveBeenCalledTimes(1)
		rerender(<HistoryPreview expanded onExpand={onExpand} />)
		expect(screen.getByTestId("history-search-input")).toBeInTheDocument()
		expect(screen.getByTestId("task-item-task-6")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchTab" }))
	})

	it("opens a recent chat directly without expanding history", () => {
		const onExpand = vi.fn()
		render(<HistoryPreview onExpand={onExpand} />)
		fireEvent.click(screen.getByTestId("task-item-task-1"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "task-1" })
		expect(onExpand).not.toHaveBeenCalled()
	})

	it("returns to an unfiltered recent preview after closing expanded history", () => {
		const onClose = vi.fn()
		const { rerender } = render(<HistoryPreview expanded onClose={onClose} />)
		search("authentication")
		fireEvent.click(screen.getByTestId("history-close"))
		expect(onClose).toHaveBeenCalledTimes(1)
		rerender(<HistoryPreview />)
		expect(screen.getAllByTestId(/^task-item-task-/)).toHaveLength(5)
		expect(screen.queryByTestId("history-search-input")).not.toBeInTheDocument()
		rerender(<HistoryPreview expanded />)
		expect(screen.getByTestId("history-search-input")).toHaveValue("")
		expect(screen.getByTestId("task-item-task-6")).toBeInTheDocument()
	})

	it.each([1, 3])("lets expanded history with %i chats size to its content", (count) => {
		setHistory(tasks.slice(0, count))
		render(<HistoryPreview expanded />)
		expect(screen.getAllByTestId(/^task-item-task-/)).toHaveLength(count)
		expect(screen.getByTestId("history-expanded-list").style.height).toBe("")
		expect(screen.queryByTestId("virtuoso-container")).not.toBeInTheDocument()
	})

	it("keeps virtualization for large expanded histories", () => {
		setHistory(Array.from({ length: 20 }, (_, index) => ({ ...tasks[0], id: `task-${index + 1}` })))
		render(<HistoryPreview expanded />)
		expect(screen.getByTestId("virtuoso-container")).toBeInTheDocument()
		expect(screen.queryByTestId("history-expanded-list")).not.toBeInTheDocument()
	})

	it("makes every conversation available inline without a separate history navigation", () => {
		render(<HistoryPreview expanded />)
		expect(screen.getByText("history:chats")).toBeInTheDocument()
		for (const task of tasks) expect(screen.getByTestId(`task-item-${task.id}`)).toBeInTheDocument()
		expect(screen.queryByTestId("history-done-button")).not.toBeInTheDocument()
		expect(screen.queryByText(/history:viewAllHistory/)).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("task-item-task-6"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "task-6" })
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchTab" }))
	})

	it("filters conversations by search and restores them when cleared", () => {
		render(<HistoryPreview expanded />)
		search("authentication")
		expect(screen.getByTestId("task-item-task-1")).toBeInTheDocument()
		expect(screen.queryByTestId("task-item-task-2")).not.toBeInTheDocument()
		search("")
		expect(screen.getByTestId("task-item-task-6")).toBeInTheDocument()
	})

	it("labels history as current project without an all-project filter", () => {
		render(<HistoryPreview expanded />)
		expect(screen.getByText("history:currentWorkspace")).toBeInTheDocument()
		expect(screen.queryByRole("combobox", { name: "history:filterChats" })).not.toBeInTheDocument()
		expect(screen.getByTestId("task-item-task-1")).toBeInTheDocument()
	})

	it("resets search and selection when the project changes", () => {
		const { rerender } = render(<HistoryPreview expanded />)
		manage()
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		fireEvent.click(screen.getByTestId("task-item-task-1"))
		search("authentication")
		const otherProjectTask = { ...tasks[0], id: "other-project-task", workspace: "/other/project" }
		setHistory([otherProjectTask], "/other/project")
		rerender(<HistoryPreview expanded focusRequest={1} />)
		expect(screen.getByTestId("history-search-input")).toHaveValue("")
		expect(screen.getByTestId("task-item-other-project-task")).toBeInTheDocument()
		expect(screen.queryByTestId("task-item-task-1")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "history:deleteSelected" })).toBeDisabled()
	})

	it("honors oldest sorting for the grouped inline list", () => {
		render(<HistoryPreview expanded />)
		manage()
		fireEvent.change(screen.getByRole("combobox", { name: "history:sort.prefix" }), { target: { value: "oldest" } })
		expect(screen.getAllByTestId(/^task-item-task-/).map((row) => row.getAttribute("data-testid"))).toEqual(
			[...tasks].reverse().map((task) => `task-item-${task.id}`),
		)
	})

	it("exports a conversation without opening it", () => {
		render(<HistoryPreview expanded />)
		manage()
		fireEvent.click(within(screen.getByTestId("task-item-task-1")).getByTestId("export"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "exportTaskWithId", text: "task-1" })
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "showTaskWithId" }))
	})

	it("requires confirmation before deleting an inline conversation", () => {
		render(<HistoryPreview expanded />)
		manage()
		fireEvent.click(within(screen.getByTestId("task-item-task-1")).getByTestId("delete-task-button"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deleteTaskWithId" }))
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "history:delete" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deleteTaskWithId", text: "task-1" })
	})

	it("selects and deletes only chosen conversations through the existing batch confirmation", () => {
		render(<HistoryPreview expanded />)
		manage()
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		fireEvent.click(screen.getByTestId("task-item-task-2"))
		fireEvent.click(screen.getByTestId("task-item-task-4"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "showTaskWithId" }))
		fireEvent.click(screen.getByRole("button", { name: "history:deleteSelected" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "deleteMultipleTasksWithIds" }),
		)
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "history:deleteItems" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "deleteMultipleTasksWithIds",
			ids: ["task-2", "task-4"],
		})
	})

	it("keeps the search controls available when no conversations exist", () => {
		setHistory([])
		render(<HistoryPreview expanded />)
		expect(screen.getByTestId("history-search-input")).toBeInTheDocument()
		expect(screen.queryByTestId(/^task-item-task-/)).not.toBeInTheDocument()
		expect(screen.getByText("history:noChats")).toBeInTheDocument()
	})

	it("reports an empty search and restores chats with the clear control", () => {
		render(<HistoryPreview expanded />)
		const focus = vi.fn()
		screen.getByTestId("history-search-input").focus = focus
		search("zzzzzzzzzz")
		expect(screen.getByRole("status")).toHaveTextContent("history:noResults")
		fireEvent.click(screen.getByRole("button", { name: "history:clearSearch" }))
		expect(screen.getByTestId("task-item-task-1")).toBeInTheDocument()
		expect(focus).toHaveBeenCalled()
	})

	it("clears selection after filtering so hidden chats cannot be deleted", () => {
		render(<HistoryPreview expanded />)
		manage()
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		fireEvent.click(screen.getByTestId("task-item-task-2"))
		search("authentication")
		expect(screen.getByRole("button", { name: "history:deleteSelected" })).toBeDisabled()
	})

	it("focuses search when the host requests inline history", () => {
		const { rerender } = render(<HistoryPreview expanded />)
		const focus = vi.fn()
		screen.getByTestId("history-search-input").focus = focus
		rerender(<HistoryPreview expanded focusRequest={1} />)
		expect(focus).toHaveBeenCalled()
	})

	it("keeps child conversations expandable and searchable inline", () => {
		setHistory([tasks[0], { ...tasks[1], task: "Investigate credential expiry", parentTaskId: tasks[0].id }])
		render(<HistoryPreview expanded />)
		expect(screen.getByTestId("subtask-list")).not.toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "history:expandSubtasks" }))
		expect(screen.getByTestId("subtask-list")).toBeVisible()
		search("credential")
		expect(screen.getByTestId("task-item-task-2")).toBeInTheDocument()
		expect(screen.queryByTestId("task-item-task-1")).not.toBeInTheDocument()
	})
})
