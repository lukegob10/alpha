import userEvent from "@testing-library/user-event"
import type { HistoryItem } from "@alpha-code/types"
import { act, fireEvent, render, screen, waitFor, within } from "@/utils/test-utils"
import { ExtensionStateContext, type ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import { vscode } from "@/utils/vscode"
import ChatHistorySwitcher from "../ChatHistorySwitcher"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const tasks: HistoryItem[] = Array.from({ length: 6 }, (_, index) => ({
	id: `task-${index}`,
	number: index,
	task: `Original prompt ${index}`,
	displayName: index === 0 ? "Navigation cleanup" : undefined,
	ts: Date.now() - index * 60_000,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}))
const context = (history: HistoryItem[]) =>
	({
		taskHistory: history,
		currentTaskId: "task-0",
		liveTasksById: {},
		cwd: "/workspace",
		getCachedTranscriptRevision: () => 12,
	}) as unknown as ExtensionStateContextType
const view = (onOpenTask = vi.fn(), onViewAll = vi.fn(), history = tasks, isVisible = true, onBackToHome = vi.fn()) => (
	<ExtensionStateContext.Provider value={context(history)}>
		<ChatHistorySwitcher
			currentTaskId={history[0]?.id}
			onBackToHome={onBackToHome}
			onOpenTask={onOpenTask}
			onViewAll={onViewAll}
			isVisible={isVisible}
		/>
	</ExtensionStateContext.Provider>
)

describe("ChatHistorySwitcher", () => {
	beforeEach(() => vi.clearAllMocks())

	it("shows only the Back and Switch chat icons, in that order, without the active title", () => {
		const { container } = render(view())
		expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
			"Back to main screen",
			"Switch chat",
		])
		expect(screen.queryByText("Navigation cleanup")).not.toBeInTheDocument()
		expect(screen.queryByText("Original prompt 0")).not.toBeInTheDocument()
		expect(container.querySelector(".chat-history-switcher")).toHaveTextContent("")
		expect(screen.queryByRole("button", { name: /Rename chat/ })).not.toBeInTheDocument()
	})

	it("returns to the main screen without opening the switcher or changing a chat", async () => {
		const onOpenTask = vi.fn()
		const onViewAll = vi.fn()
		const onBackToHome = vi.fn()
		const user = userEvent.setup()
		render(view(onOpenTask, onViewAll, tasks, true, onBackToHome))
		await user.click(screen.getByRole("button", { name: "Back to main screen" }))
		expect(onBackToHome).toHaveBeenCalledTimes(1)
		expect(onOpenTask).not.toHaveBeenCalled()
		expect(onViewAll).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.queryByTestId("history-preview-list")).not.toBeInTheDocument()
	})

	it("opens the same four recent rows and uses the owning chat callback", async () => {
		const onOpenTask = vi.fn()
		const user = userEvent.setup()
		render(view(onOpenTask))
		expect(screen.queryByTestId("history-preview-list")).not.toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Switch chat" }))
		expect(screen.getAllByTestId(/^task-item-task-/)).toHaveLength(4)
		await user.click(screen.getByTestId("task-item-task-2"))
		expect(onOpenTask).toHaveBeenCalledWith("task-2")
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.queryByTestId("history-preview-list")).not.toBeInTheDocument()
	})

	it("focuses the first row and preserves wrapping, Home, and End keyboard navigation", async () => {
		const restoreFocus = installNativeTestFocus()
		try {
			const user = userEvent.setup()
			render(view())
			await user.click(screen.getByRole("button", { name: "Switch chat" }))
			const rows = screen.getAllByTestId(/^task-item-task-/)
			await waitFor(() => expect(rows[0]).toHaveFocus())
			fireEvent.keyDown(rows[0], { key: "ArrowUp" })
			expect(rows[3]).toHaveFocus()
			fireEvent.keyDown(rows[3], { key: "ArrowDown" })
			expect(rows[0]).toHaveFocus()
			fireEvent.keyDown(rows[0], { key: "End" })
			expect(rows[3]).toHaveFocus()
			fireEvent.keyDown(rows[3], { key: "Home" })
			expect(rows[0]).toHaveFocus()
			expect(vscode.postMessage).not.toHaveBeenCalled()
		} finally {
			restoreFocus()
		}
	})

	it("does not rescan history rows for unrelated keyboard input", async () => {
		const onOpenTask = vi.fn()
		const user = userEvent.setup()
		render(view(onOpenTask))
		await user.click(screen.getByRole("button", { name: "Switch chat" }))
		const dialog = screen.getByRole("dialog", { name: "Switch chat" })
		const row = screen.getByTestId("task-item-task-0")
		const queryRows = vi.spyOn(dialog, "querySelectorAll")
		try {
			for (let index = 0; index < 20; index++) {
				fireEvent.keyDown(row, { key: ["Tab", "Shift", "a", "F10"][index % 4] })
			}
			expect(
				queryRows.mock.calls.filter(([selector]) => selector === '[data-testid^="task-item-"]'),
			).toHaveLength(0)
			expect(dialog).toBeInTheDocument()
			expect(onOpenTask).not.toHaveBeenCalled()
			expect(vscode.postMessage).not.toHaveBeenCalled()
		} finally {
			queryRows.mockRestore()
		}
	})

	it("closes the popover and opens the existing full history surface", async () => {
		const onViewAll = vi.fn()
		const user = userEvent.setup()
		render(view(vi.fn(), onViewAll))
		await user.click(screen.getByRole("button", { name: "Switch chat" }))
		await user.click(screen.getByRole("button", { name: "View all chats" }))
		expect(onViewAll).toHaveBeenCalledTimes(1)
		expect(screen.queryByTestId("history-preview-list")).not.toBeInTheDocument()
	})

	it("renames through a switcher row and refreshes history from the host projection", async () => {
		const user = userEvent.setup()
		const { rerender } = render(view())
		await user.click(screen.getByRole("button", { name: "Switch chat" }))
		await user.click(
			within(screen.getByTestId("task-item-task-0")).getByRole("button", {
				name: "Chat actions: Navigation cleanup",
			}),
		)
		await user.click(screen.getByRole("menuitem", { name: "Rename chat" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), {
			target: { value: "Release navigation" },
		})
		fireEvent.submit(screen.getByRole("textbox").closest("form")!)
		const message = vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0]
		const request = message?.type === "renameTask" ? message.taskRenameRequest : undefined
		expect(request).toBeDefined()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "taskRenameResult",
						taskRenameResult: { ...request, status: "success", displayName: "Release navigation" },
					},
				}),
			),
		)
		expect(screen.queryByRole("dialog", { name: "Rename chat" })).not.toBeInTheDocument()
		rerender(view(vi.fn(), vi.fn(), [{ ...tasks[0], displayName: "Release navigation" }, ...tasks.slice(1)]))
		expect(within(screen.getByTestId("task-item-task-0")).getByText("Release navigation")).toBeInTheDocument()
	})

	it.each(["context", "keyboard"])("opens switcher row actions using %s", async (entry) => {
		const user = userEvent.setup()
		render(view())
		await user.click(screen.getByRole("button", { name: "Switch chat" }))
		const row = screen.getByTestId("task-item-task-0")
		if (entry === "context") fireEvent.contextMenu(row)
		else fireEvent.keyDown(row, { key: "F10", shiftKey: true })
		await user.click(screen.getByRole("menuitem", { name: "Rename chat" }))
		expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue("Navigation cleanup")
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps row rename usable inside the switcher popover", async () => {
		const user = userEvent.setup()
		render(view())
		await user.click(screen.getByRole("button", { name: "Switch chat" }))
		const row = within(screen.getByTestId("task-item-task-1"))
		await user.click(row.getByRole("button", { name: "Chat actions: Original prompt 1" }))
		await user.click(screen.getByRole("menuitem", { name: "Rename chat" }))
		expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue("Original prompt 1")
		await user.click(
			within(screen.getByRole("dialog", { name: "Rename chat" })).getByRole("button", { name: "Cancel" }),
		)
		expect(screen.getByTestId("task-item-task-1")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each(["switcher", "rename", "actions"])(
		"closes %s portals when chat is hidden and leaves them closed on return",
		async (entry) => {
			const user = userEvent.setup()
			const { rerender } = render(view())
			await user.click(screen.getByRole("button", { name: "Switch chat" }))
			if (entry !== "switcher") {
				fireEvent.contextMenu(screen.getByTestId("task-item-task-0"))
				if (entry === "rename") await user.click(screen.getByRole("menuitem", { name: "Rename chat" }))
			}
			expect(screen.queryAllByRole("dialog").length + screen.queryAllByRole("menu").length).toBeGreaterThan(0)
			rerender(view(vi.fn(), vi.fn(), tasks, false))
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
			expect(screen.queryByRole("menu")).not.toBeInTheDocument()
			rerender(view())
			expect(screen.getByRole("button", { name: "Switch chat" })).toHaveAttribute("aria-expanded", "false")
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
			expect(screen.queryByRole("menu")).not.toBeInTheDocument()
			expect(vscode.postMessage).not.toHaveBeenCalled()
		},
	)

	it.each(["switcher", "rename", "actions"])("closes %s portals when the current chat changes", async (entry) => {
		const user = userEvent.setup()
		const { rerender } = render(view())
		await user.click(screen.getByRole("button", { name: "Switch chat" }))
		if (entry !== "switcher") {
			fireEvent.contextMenu(screen.getByTestId("task-item-task-0"))
			if (entry === "rename") await user.click(screen.getByRole("menuitem", { name: "Rename chat" }))
		}
		rerender(view(vi.fn(), vi.fn(), [tasks[1], tasks[0], ...tasks.slice(2)]))
		expect(screen.getByRole("button", { name: "Switch chat" })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(screen.queryByRole("menu")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
