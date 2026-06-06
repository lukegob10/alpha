import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { QueuedMessages } from "../QueuedMessages"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("QueuedMessages", () => {
	const queue = [
		{ id: "msg1", timestamp: 1, text: "first", images: [] },
		{ id: "msg2", timestamp: 2, text: "second", images: [] },
	]

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
		fireEvent.drop(screen.getByTestId("queued-message-msg1"), { dataTransfer })

		expect(onReorder).toHaveBeenCalledWith(1, 0)
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
})
