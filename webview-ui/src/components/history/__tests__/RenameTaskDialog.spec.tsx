import type { TaskRenameRequest, TaskRenameResult } from "@alpha-code/types"
import { act, fireEvent, render, screen, within } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"
import { RenameTaskDialog, TASK_RENAME_TIMEOUT_MS } from "../RenameTaskDialog"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const item = {
	id: "task-1",
	number: 1,
	task: "Original prompt",
	displayName: "Readable name",
	ts: 1,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}
const request = () => {
	const message = vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0]
	if (message?.type !== "renameTask" || !message.taskRenameRequest) throw new Error("Expected rename request")
	return message.taskRenameRequest
}
const respond = (result: TaskRenameResult) =>
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "taskRenameResult", taskRenameResult: result } }),
		),
	)
const save = () => fireEvent.submit(screen.getByRole("textbox", { name: "Chat name" }).closest("form")!)

describe("RenameTaskDialog", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.useRealTimers())

	it("trims the name, blocks duplicate saves, and waits for a matching acknowledgement", () => {
		const onOpenChange = vi.fn()
		render(<RenameTaskDialog item={item} open onOpenChange={onOpenChange} />)
		fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), {
			target: { value: "  Authentication follow-up  " },
		})
		save()
		const sent = request()
		expect(sent).toEqual({
			taskId: item.id,
			requestId: expect.any(String),
			displayName: "Authentication follow-up",
		})
		expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled()
		save()
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		respond({ ...sent, taskId: "another-task", status: "success" })
		respond({ ...sent, requestId: "older-request", status: "success" })
		expect(onOpenChange).not.toHaveBeenCalled()
		respond({ ...sent, status: "success" })
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(item.task).toBe("Original prompt")
	})

	it("does not save blank names and cancels without a request", () => {
		const onOpenChange = vi.fn()
		render(<RenameTaskDialog item={item} open onOpenChange={onOpenChange} />)
		fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), { target: { value: "   " } })
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
		save()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("closes on Escape before submission and restores caller focus", async () => {
		const onOpenChange = vi.fn()
		const restoreFocus = vi.fn((event: Event) => event.preventDefault())
		const { rerender } = render(
			<RenameTaskDialog item={item} open onOpenChange={onOpenChange} onCloseAutoFocus={restoreFocus} />,
		)
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
		expect(onOpenChange).toHaveBeenCalledWith(false)
		rerender(
			<RenameTaskDialog item={item} open={false} onOpenChange={onOpenChange} onCloseAutoFocus={restoreFocus} />,
		)
		await vi.waitFor(() => expect(restoreFocus).toHaveBeenCalled())
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps edits through projection refreshes and supports retry after a failed save", () => {
		const onOpenChange = vi.fn()
		const { rerender } = render(<RenameTaskDialog item={item} open onOpenChange={onOpenChange} />)
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "My edited label" } })
		rerender(
			<RenameTaskDialog item={{ ...item, tokensIn: 200 }} open onOpenChange={(open) => onOpenChange(open)} />,
		)
		expect(screen.getByRole("textbox")).toHaveValue("My edited label")
		save()
		const sent = request()
		rerender(
			<RenameTaskDialog item={{ ...item, tokensIn: 300 }} open onOpenChange={(open) => onOpenChange(open)} />,
		)
		respond({ taskId: sent.taskId, requestId: sent.requestId, status: "error", error: "saveFailed" })
		expect(screen.getByRole("alert")).toHaveTextContent("The chat could not be renamed. Try again.")
		expect(screen.getByRole("textbox")).toHaveValue("My edited label")
		save()
		expect(request().requestId).not.toBe(sent.requestId)
		respond({ ...request(), status: "success" })
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("reports a missing acknowledgement and ignores late responses after retry", () => {
		vi.useFakeTimers()
		const onOpenChange = vi.fn()
		const { unmount } = render(<RenameTaskDialog item={item} open onOpenChange={onOpenChange} />)
		save()
		const first: TaskRenameRequest = request()
		act(() => vi.advanceTimersByTime(TASK_RENAME_TIMEOUT_MS))
		expect(screen.getByRole("alert")).toHaveTextContent("The rename has not been confirmed")
		save()
		respond({ ...first, status: "success" })
		expect(onOpenChange).not.toHaveBeenCalled()
		respond({ ...request(), status: "success" })
		expect(onOpenChange).toHaveBeenCalledWith(false)
		unmount()
		onOpenChange.mockClear()
		act(() => vi.advanceTimersByTime(TASK_RENAME_TIMEOUT_MS))
		expect(onOpenChange).not.toHaveBeenCalled()
	})

	it.each(["notFound", "wrongWorkspace", "invalid"] as const)("shows an actionable %s failure", (error) => {
		render(<RenameTaskDialog item={item} open onOpenChange={vi.fn()} />)
		save()
		const sent = request()
		respond({ taskId: sent.taskId, requestId: sent.requestId, status: "error", error })
		expect(within(screen.getByRole("dialog")).getByRole("alert")).not.toHaveTextContent(error)
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
	})
})
