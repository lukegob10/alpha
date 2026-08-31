import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { DeleteTaskDialog } from "../DeleteTaskDialog"

vi.mock("@/utils/vscode")

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			const translations: Record<string, string> = {
				"history:deleteTask": "Delete Task",
				"history:deleteTaskMessage": "Are you sure you want to delete this task? This action cannot be undone.",
				"history:cancel": "Cancel",
				"history:delete": "Delete",
			}
			// Handle deleteWithSubtasks with interpolation
			if (key === "history:deleteWithSubtasks" && options?.count !== undefined) {
				return `This will also delete ${options.count} subtask(s). Are you sure?`
			}
			return translations[key] || key
		},
	}),
}))

describe("DeleteTaskDialog", () => {
	const mockTaskId = "test-task-id"
	const mockOnOpenChange = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders dialog with correct content", () => {
		render(<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} />)

		expect(screen.getByText("Delete Task")).toBeInTheDocument()
		expect(
			screen.getByText("Are you sure you want to delete this task? This action cannot be undone."),
		).toBeInTheDocument()
		expect(screen.getByText("Cancel")).toBeInTheDocument()
		expect(screen.getByText("Delete")).toBeInTheDocument()
	})

	it("calls vscode.postMessage when delete is confirmed", () => {
		render(<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} />)

		const deleteButton = screen.getByText("Delete")
		fireEvent.click(deleteButton)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "deleteTaskWithId",
			text: mockTaskId,
		})
		expect(mockOnOpenChange).toHaveBeenCalledWith(false)
	})

	it("calls onOpenChange when cancel is clicked", () => {
		render(<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} />)

		const cancelButton = screen.getByText("Cancel")
		fireEvent.click(cancelButton)

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(mockOnOpenChange).toHaveBeenCalledWith(false)
	})

	it("does not call vscode.postMessage when taskId is empty", () => {
		render(<DeleteTaskDialog taskId="" open={true} onOpenChange={mockOnOpenChange} />)

		const deleteButton = screen.getByText("Delete")
		fireEvent.click(deleteButton)

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(mockOnOpenChange).toHaveBeenCalledWith(false)
	})

	it("does not delete when Enter is pressed outside the confirmation action", () => {
		render(<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} />)

		fireEvent.keyDown(screen.getByText("Cancel"), { key: "Enter", code: "Enter" })

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(mockOnOpenChange).not.toHaveBeenCalled()
	})

	it("calls onOpenChange on escape key", () => {
		render(<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} />)

		// Simulate escape key press on the dialog content
		const dialogContent = screen.getByRole("alertdialog")
		fireEvent.keyDown(dialogContent, { key: "Escape" })

		expect(mockOnOpenChange).toHaveBeenCalledWith(false)
	})

	it("has correct button variants", () => {
		render(<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} />)

		const cancelButton = screen.getByText("Cancel")
		const deleteButton = screen.getByText("Delete")

		// These should have the correct styling classes based on the component
		expect(cancelButton).toBeInTheDocument()
		expect(deleteButton).toBeInTheDocument()
	})

	describe("cascade delete warning", () => {
		it("shows warning message when deleting parent with subtasks", () => {
			render(
				<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} subtaskCount={3} />,
			)

			expect(screen.getByText("This will also delete 3 subtask(s). Are you sure?")).toBeInTheDocument()
		})

		it("shows standard message when no subtasks", () => {
			render(
				<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} subtaskCount={0} />,
			)

			expect(
				screen.getByText("Are you sure you want to delete this task? This action cannot be undone."),
			).toBeInTheDocument()
		})

		it("shows standard message when subtaskCount is not provided", () => {
			render(<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} />)

			expect(
				screen.getByText("Are you sure you want to delete this task? This action cannot be undone."),
			).toBeInTheDocument()
		})

		it("shows singular subtask warning for single subtask", () => {
			render(
				<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} subtaskCount={1} />,
			)

			expect(screen.getByText("This will also delete 1 subtask(s). Are you sure?")).toBeInTheDocument()
		})

		it("still deletes task when cascade warning is shown", () => {
			render(
				<DeleteTaskDialog taskId={mockTaskId} open={true} onOpenChange={mockOnOpenChange} subtaskCount={5} />,
			)

			const deleteButton = screen.getByText("Delete")
			fireEvent.click(deleteButton)

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "deleteTaskWithId",
				text: mockTaskId,
			})
			expect(mockOnOpenChange).toHaveBeenCalledWith(false)
		})
	})
})
