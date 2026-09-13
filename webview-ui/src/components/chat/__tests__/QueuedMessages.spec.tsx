import { createEvent, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { QueuedMessages } from "../QueuedMessages"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}))

const createDragData = () => ({ effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn() })

const mockRowRect = (row: HTMLElement, top: number) => {
	vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
		top,
		bottom: top + 40,
		height: 40,
		left: 0,
		right: 100,
		width: 100,
		x: 0,
		y: top,
		toJSON: () => ({}),
	})
}

const fireDragAt = (
	target: HTMLElement,
	type: "dragEnter" | "dragOver" | "drop",
	clientY: number,
	dataTransfer: ReturnType<typeof createDragData>,
) => {
	const event = createEvent[type](target, { dataTransfer })
	Object.defineProperty(event, "clientY", { value: clientY })
	fireEvent(target, event)
	return event
}

describe("QueuedMessages", () => {
	const queue = [
		{ id: "msg1", timestamp: 1, text: "first", images: [] },
		{ id: "msg2", timestamp: 2, text: "second", images: [] },
	]

	it.each([
		{ fromIndex: 0, clientY: 45, position: 0, toIndex: 0 },
		{ fromIndex: 0, clientY: 95, position: 1, toIndex: 0 },
		{ fromIndex: 0, clientY: 145, position: 2, toIndex: 1 },
		{ fromIndex: 1, clientY: 45, position: 0, toIndex: 0 },
		{ fromIndex: 1, clientY: 95, position: 1, toIndex: 1 },
		{ fromIndex: 1, clientY: 145, position: 2, toIndex: 1 },
	])("accepts message $fromIndex in queue gap $position", ({ fromIndex, clientY, position, toIndex }) => {
		const onReorder = vi.fn()
		const dataTransfer = createDragData()
		render(
			<QueuedMessages
				queue={queue}
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)
		mockRowRect(screen.getByTestId("queued-message-msg1"), 50)
		mockRowRect(screen.getByTestId("queued-message-msg2"), 100)
		fireEvent.dragStart(screen.getAllByLabelText("queuedMessages.dragHandle")[fromIndex], { dataTransfer })

		// Empty space targets the queue container, not either message card.
		const container = screen.getByTestId("queued-messages")
		expect(fireDragAt(container, "dragEnter", clientY, dataTransfer).defaultPrevented).toBe(true)
		expect(screen.getByTestId("queued-drop-indicator")).toHaveAttribute("data-position", String(position))
		expect(fireDragAt(container, "dragOver", clientY, dataTransfer).defaultPrevented).toBe(true)
		expect(screen.getByTestId("queued-drop-indicator")).toHaveAttribute("data-position", String(position))
		fireDragAt(container, "drop", clientY, dataTransfer)

		if (fromIndex === toIndex) {
			expect(onReorder).not.toHaveBeenCalled()
		} else {
			expect(onReorder).toHaveBeenCalledExactlyOnceWith(fromIndex, toIndex)
		}
		expect(screen.queryByTestId("queued-drop-indicator")).not.toBeInTheDocument()
	})

	it("keeps the line while moving from a card into the gap and accepts a drop on the line", () => {
		const onReorder = vi.fn()
		const dataTransfer = createDragData()
		render(
			<QueuedMessages
				queue={queue}
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)
		const firstRow = screen.getByTestId("queued-message-msg1")
		mockRowRect(firstRow, 50)
		mockRowRect(screen.getByTestId("queued-message-msg2"), 100)
		fireEvent.dragStart(screen.getAllByLabelText("queuedMessages.dragHandle")[1], { dataTransfer })
		fireDragAt(firstRow, "dragOver", 55, dataTransfer)
		const leave = createEvent.dragLeave(firstRow)
		Object.defineProperty(leave, "relatedTarget", { value: screen.getByTestId("queued-messages") })
		fireEvent(firstRow, leave)
		const indicator = screen.getByTestId("queued-drop-indicator")
		fireDragAt(indicator, "drop", 45, dataTransfer)
		expect(onReorder).toHaveBeenCalledExactlyOnceWith(1, 0)
		expect(screen.queryByTestId("queued-drop-indicator")).not.toBeInTheDocument()
	})

	it.each([
		{ fromIndex: 0, position: 2, clientY: 145 },
		{ fromIndex: 2, position: 1, clientY: 95 },
	])("moves message $fromIndex into the middle using the gap itself", ({ fromIndex, position, clientY }) => {
		const onReorder = vi.fn()
		const dataTransfer = createDragData()
		const messages = [...queue, { id: "msg3", timestamp: 3, text: "third", images: [] }]
		render(
			<QueuedMessages
				queue={messages}
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)
		messages.forEach((message, index) =>
			mockRowRect(screen.getByTestId(`queued-message-${message.id}`), 50 + index * 50),
		)
		fireEvent.dragStart(screen.getAllByLabelText("queuedMessages.dragHandle")[fromIndex], { dataTransfer })
		const gap = screen.getByTestId(`queued-drop-zone-${position}`)
		fireDragAt(gap, "dragOver", clientY, dataTransfer)
		expect(screen.getByTestId("queued-drop-indicator")).toHaveAttribute("data-position", String(position))
		fireDragAt(gap, "drop", clientY, dataTransfer)
		fireDragAt(gap, "drop", clientY, dataTransfer)
		expect(onReorder).toHaveBeenCalledExactlyOnceWith(fromIndex, 1)
	})

	it("clears the line on leaving the queue or cancelling the drag", () => {
		const onReorder = vi.fn()
		const dataTransfer = createDragData()
		render(
			<QueuedMessages
				queue={queue}
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)
		mockRowRect(screen.getByTestId("queued-message-msg1"), 50)
		mockRowRect(screen.getByTestId("queued-message-msg2"), 100)
		const handle = screen.getAllByLabelText("queuedMessages.dragHandle")[1]
		const container = screen.getByTestId("queued-messages")
		fireEvent.dragStart(handle, { dataTransfer })
		fireDragAt(container, "dragOver", 45, dataTransfer)
		fireEvent.dragLeave(container)
		expect(screen.queryByTestId("queued-drop-indicator")).not.toBeInTheDocument()
		fireDragAt(container, "dragOver", 45, dataTransfer)
		expect(screen.getByTestId("queued-drop-indicator")).toBeInTheDocument()
		fireEvent.dragEnd(handle)
		expect(screen.queryByTestId("queued-drop-indicator")).not.toBeInTheDocument()
		fireDragAt(container, "drop", 45, dataTransfer)
		expect(onReorder).not.toHaveBeenCalled()
	})

	it("ignores external drags even when their text looks like a queue index", () => {
		const onReorder = vi.fn()
		const dataTransfer = createDragData()
		dataTransfer.getData.mockReturnValue("1")
		render(
			<QueuedMessages
				queue={queue}
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)
		const container = screen.getByTestId("queued-messages")
		expect(fireDragAt(container, "dragOver", 45, dataTransfer).defaultPrevented).toBe(false)
		fireDragAt(container, "drop", 45, dataTransfer)
		expect(screen.queryByTestId("queued-drop-indicator")).not.toBeInTheDocument()
		expect(onReorder).not.toHaveBeenCalled()
	})

	it.each([false, true])("tracks the dragged message when the queue changes (source removed: %s)", (removeSource) => {
		const onReorder = vi.fn()
		const dataTransfer = createDragData()
		const props = { onRemove: vi.fn(), onSteer: vi.fn(), onEdit: vi.fn(), onReorder }
		const messages = [...queue, { id: "msg3", timestamp: 3, text: "third", images: [] }]
		const { rerender } = render(<QueuedMessages queue={messages} {...props} />)
		fireEvent.dragStart(screen.getAllByLabelText("queuedMessages.dragHandle")[1], { dataTransfer })
		const remaining = messages.filter((message) => message.id !== (removeSource ? "msg2" : "msg1"))
		rerender(<QueuedMessages queue={remaining} {...props} />)
		remaining.forEach((message, index) =>
			mockRowRect(screen.getByTestId(`queued-message-${message.id}`), 50 + index * 50),
		)
		fireDragAt(screen.getByTestId("queued-messages"), "drop", 145, dataTransfer)
		if (removeSource) {
			expect(onReorder).not.toHaveBeenCalled()
		} else {
			expect(onReorder).toHaveBeenCalledExactlyOnceWith(0, 1)
		}
	})

	it("rejects a drop if steering starts during the drag", () => {
		const onReorder = vi.fn()
		const dataTransfer = createDragData()
		const props = { queue, onRemove: vi.fn(), onSteer: vi.fn(), onEdit: vi.fn(), onReorder }
		const { rerender } = render(<QueuedMessages {...props} />)
		fireEvent.dragStart(screen.getAllByLabelText("queuedMessages.dragHandle")[1], { dataTransfer })
		rerender(<QueuedMessages {...props} steeringMessageId="msg1" />)
		const container = screen.getByTestId("queued-messages")
		fireDragAt(container, "dragOver", 45, dataTransfer)
		fireDragAt(container, "drop", 45, dataTransfer)
		expect(screen.queryByTestId("queued-drop-indicator")).not.toBeInTheDocument()
		expect(onReorder).not.toHaveBeenCalled()
	})

	it("emits reorder when a queued message is dropped onto another row", () => {
		const onReorder = vi.fn()
		const dataTransfer = {
			effectAllowed: "",
			dropEffect: "",
			setData: vi.fn(),
			getData: vi.fn().mockReturnValue("1"),
		}

		render(
			<QueuedMessages
				queue={queue}
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)

		fireEvent.dragStart(screen.getAllByLabelText("queuedMessages.dragHandle")[1], { dataTransfer })
		const firstRow = screen.getByTestId("queued-message-msg1")
		mockRowRect(firstRow, 50)
		mockRowRect(screen.getByTestId("queued-message-msg2"), 100)
		fireDragAt(firstRow, "drop", 55, dataTransfer)

		expect(onReorder).toHaveBeenCalledWith(1, 0)
	})

	it("shows the insertion line at every queue boundary and converts the drop position to the final index", () => {
		const onReorder = vi.fn()
		const dataTransfer = {
			effectAllowed: "",
			dropEffect: "",
			setData: vi.fn(),
			getData: vi.fn().mockReturnValue("0"),
		}
		const threeMessages = [...queue, { id: "msg3", timestamp: 3, text: "third", images: [] }]

		render(
			<QueuedMessages
				queue={threeMessages}
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)

		const firstRow = screen.getByTestId("queued-message-msg1")
		const secondRow = screen.getByTestId("queued-message-msg2")
		const thirdRow = screen.getByTestId("queued-message-msg3")
		mockRowRect(firstRow, 50)
		mockRowRect(secondRow, 100)
		mockRowRect(thirdRow, 150)

		fireEvent.dragStart(screen.getAllByLabelText("queuedMessages.dragHandle")[0], { dataTransfer })
		const dragOver = (row: HTMLElement, clientY: number) => {
			const event = createEvent.dragOver(row, { dataTransfer })
			Object.defineProperty(event, "clientY", { value: clientY })
			fireEvent(row, event)
		}
		dragOver(firstRow, 55)
		expect(screen.getByTestId("queued-drop-indicator")).toHaveAttribute("data-position", "0")

		dragOver(secondRow, 110)
		expect(screen.getByTestId("queued-drop-indicator")).toHaveAttribute("data-position", "1")

		dragOver(secondRow, 135)
		expect(screen.getByTestId("queued-drop-indicator")).toHaveAttribute("data-position", "2")

		dragOver(thirdRow, 185)
		expect(screen.getByTestId("queued-drop-indicator")).toHaveAttribute("data-position", "3")

		const drop = createEvent.drop(thirdRow, { dataTransfer })
		Object.defineProperty(drop, "clientY", { value: 185 })
		fireEvent(thirdRow, drop)
		expect(onReorder).toHaveBeenCalledWith(0, 2)
		expect(screen.queryByTestId("queued-drop-indicator")).not.toBeInTheDocument()
	})

	it("reorders queued messages with arrow keys", () => {
		const onReorder = vi.fn()
		render(
			<QueuedMessages
				queue={queue}
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)

		fireEvent.keyDown(screen.getAllByLabelText("queuedMessages.dragHandle")[1], { key: "ArrowUp" })

		expect(onReorder).toHaveBeenCalledWith(1, 0)
	})

	it("gives the remove action an accessible name", () => {
		render(
			<QueuedMessages queue={queue} onRemove={vi.fn()} onSteer={vi.fn()} onEdit={vi.fn()} onReorder={vi.fn()} />,
		)

		expect(screen.getAllByRole("button", { name: "common:answers.remove" })).toHaveLength(2)
	})

	it("disables queued actions for the row currently being edited", () => {
		render(
			<QueuedMessages
				queue={queue}
				editingMessageId="msg1"
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={vi.fn()}
			/>,
		)

		expect(screen.getByText("queuedMessages.editing")).toBeInTheDocument()
		expect(screen.getAllByTitle("queuedMessages.editTooltip")[0]).toBeDisabled()
		expect(screen.getAllByTitle("queuedMessages.steerTooltip")[0]).toBeDisabled()
	})

	it("disables every queue mutation while a steering handoff is pending", () => {
		const onReorder = vi.fn()
		render(
			<QueuedMessages
				queue={queue}
				steeringMessageId="msg1"
				onRemove={vi.fn()}
				onSteer={vi.fn()}
				onEdit={vi.fn()}
				onReorder={onReorder}
			/>,
		)

		expect(screen.getByText("queuedMessages.steering")).toBeInTheDocument()
		expect(
			screen.getAllByTitle("queuedMessages.editTooltip").every((button) => button.hasAttribute("disabled")),
		).toBe(true)
		expect(
			screen.getAllByTitle("queuedMessages.steerTooltip").every((button) => button.hasAttribute("disabled")),
		).toBe(true)
		expect(screen.getAllByLabelText("queuedMessages.dragHandle").every((handle) => !handle.draggable)).toBe(true)

		fireEvent.keyDown(screen.getAllByLabelText("queuedMessages.dragHandle")[1], { key: "ArrowUp" })
		expect(onReorder).not.toHaveBeenCalled()
	})
})
