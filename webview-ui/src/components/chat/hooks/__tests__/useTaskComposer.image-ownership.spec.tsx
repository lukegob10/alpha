import { act, renderHook } from "@testing-library/react"
import { useTaskComposer } from "../useTaskComposer"

describe("task composer image ownership", () => {
	it("keeps the initial submission receipt when a late new-chat image updates its draft", () => {
		const { result, rerender } = renderHook(({ taskId }: { taskId?: string }) => useTaskComposer(taskId), {
			initialProps: {},
		})
		const submission = { requestId: "request-new", taskId: "created-task", text: "start", images: [] }
		act(() =>
			result.current.updateTaskDraft(undefined, (draft) => ({ ...draft, pendingNewTaskRequest: submission })),
		)
		const finishImageRead = result.current.setSelectedImages
		rerender({ taskId: "created-task" })
		act(() => result.current.setSelectedImages(["created-task-image"]))
		act(() => finishImageRead((images) => [...images, "new-chat-image"]))
		expect(result.current.selectedImages).toEqual(["created-task-image"])
		expect(result.current.getTaskDraft(undefined)).toMatchObject({
			selectedImages: ["new-chat-image"],
			pendingNewTaskRequest: submission,
		})
	})

	it("appends to the originating draft's latest images after navigating away and back", () => {
		const { result, rerender } = renderHook(({ taskId }) => useTaskComposer(taskId), {
			initialProps: { taskId: "a" },
		})
		const finishImageRead = result.current.setSelectedImages
		act(() => result.current.setSelectedImages(["original-a"]))
		rerender({ taskId: "b" })
		act(() => result.current.setSelectedImages(["image-b"]))
		rerender({ taskId: "a" })
		act(() => result.current.setSelectedImages((images) => [...images, "newer-a"]))
		act(() => finishImageRead((images) => [...images, "late-a"]))
		expect(result.current.selectedImages).toEqual(["original-a", "newer-a", "late-a"])
		expect(result.current.getTaskDraft("b").selectedImages).toEqual(["image-b"])
	})
})
