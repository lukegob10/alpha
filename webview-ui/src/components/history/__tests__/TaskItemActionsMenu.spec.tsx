import userEvent from "@testing-library/user-event"
import { fireEvent, render, screen, within } from "@/utils/test-utils"
import { copyToClipboard } from "@/utils/clipboard"
import { vscode } from "@/utils/vscode"
import TaskItem from "../TaskItem"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/clipboard", () => ({ copyToClipboard: vi.fn() }))

const item = {
	id: "task-1",
	number: 1,
	task: "Original task prompt",
	displayName: "Short label",
	ts: Date.now(),
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

describe("chat row actions", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each(["button", "context", "keyboard"])("opens rename from the %s without opening a chat", async (entry) => {
		const user = userEvent.setup()
		render(<TaskItem item={item} variant="compact" />)
		const row = screen.getByTestId("task-item-task-1")
		if (entry === "button") await user.click(within(row).getByRole("button", { name: "Chat actions: Short label" }))
		else if (entry === "context") fireEvent.contextMenu(row)
		else fireEvent.keyDown(row, { key: "F10", shiftKey: true })
		await user.click(screen.getByRole("menuitem", { name: "Rename chat" }))
		expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue("Short label")
		// Input context menus retain native text-editing behavior, rather than reopening row actions.
		fireEvent.contextMenu(screen.getByRole("textbox"))
		expect(screen.queryByRole("menu")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("copies the original prompt after renaming", async () => {
		const user = userEvent.setup()
		render(<TaskItem item={item} variant="compact" />)
		await user.click(screen.getByRole("button", { name: "Chat actions: Short label" }))
		await user.click(screen.getByRole("menuitem", { name: "Copy Prompt" }))
		expect(copyToClipboard).toHaveBeenCalledWith("Original task prompt")
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("retains export and confirmed delete for recent rows", async () => {
		const user = userEvent.setup()
		render(<TaskItem item={item} variant="compact" />)
		await user.click(screen.getByRole("button", { name: "Chat actions: Short label" }))
		await user.click(screen.getByRole("menuitem", { name: "Export Task" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "exportTaskWithId", text: item.id })
		await user.click(screen.getByRole("button", { name: "Chat actions: Short label" }))
		await user.click(screen.getByRole("menuitem", { name: "Delete Task" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deleteTaskWithId" }))
		await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "deleteTaskWithId", text: item.id })
	})
})
