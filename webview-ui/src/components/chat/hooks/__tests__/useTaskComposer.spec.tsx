import { act, renderHook } from "@testing-library/react"
import { useTaskComposer } from "../useTaskComposer"

describe("useTaskComposer", () => {
	it("keeps text, images, and queue edits with their owning chat", () => {
		const { result, rerender } = renderHook(({ taskId }: { taskId?: string }) => useTaskComposer(taskId), {
			initialProps: { taskId: "a" },
		})
		act(() => {
			result.current.setInputValue("edit a")
			result.current.setSelectedImages(["image-a"])
			result.current.setEditingQueuedMessage({
				taskId: "a",
				id: "queue-a",
				priorText: "draft a",
				priorImages: [],
			})
		})
		rerender({ taskId: "b" })
		expect(result.current.inputValue).toBe("")
		expect(result.current.editingQueuedMessage).toBeNull()
		act(() => result.current.setInputValue("draft b"))
		rerender({ taskId: "a" })
		expect(result.current.inputValue).toBe("edit a")
		expect(result.current.selectedImages).toEqual(["image-a"])
		expect(result.current.editingQueuedMessage?.id).toBe("queue-a")
		rerender({ taskId: "b" })
		expect(result.current.inputValue).toBe("draft b")
	})
	it("applies a late receipt to the originating draft without overwriting the selected chat", () => {
		const { result, rerender } = renderHook(({ taskId }) => useTaskComposer(taskId), {
			initialProps: { taskId: "a" },
		})
		act(() =>
			result.current.setPendingResumeRequest({
				taskId: "a",
				requestId: "request-a",
				text: "continue a",
				images: [],
			}),
		)
		rerender({ taskId: "b" })
		act(() => result.current.setInputValue("draft b"))
		act(() =>
			result.current.updateTaskDraft("a", (draft) => ({
				...draft,
				pendingResumeRequest: null,
				inputValue: "continue a",
			})),
		)
		expect(result.current.inputValue).toBe("draft b")
		rerender({ taskId: "a" })
		expect(result.current.inputValue).toBe("continue a")
		expect(result.current.pendingResumeRequest).toBeNull()
	})
})
