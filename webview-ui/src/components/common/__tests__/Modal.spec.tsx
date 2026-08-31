import { useState } from "react"
import userEvent from "@testing-library/user-event"

import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import { Modal } from "../Modal"

const ModalHarness = () => {
	const [isOpen, setIsOpen] = useState(false)

	return (
		<>
			<button type="button" onClick={() => setIsOpen(true)}>
				Open preview
			</button>
			<Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Preview dialog">
				<button type="button">Dialog action</button>
			</Modal>
		</>
	)
}

describe("Modal", () => {
	it("provides dialog semantics, initial focus, and Escape dismissal", async () => {
		const originalFocus = HTMLElement.prototype.focus
		const focusSpy = vi.fn()
		HTMLElement.prototype.focus = focusSpy
		const user = userEvent.setup()

		try {
			render(<ModalHarness />)

			const opener = screen.getByRole("button", { name: "Open preview" })
			await user.click(opener)

			const dialog = screen.getByRole("dialog", { name: "Preview dialog" })
			const dialogAction = screen.getByRole("button", { name: "Dialog action" })
			expect(dialog).toBeInTheDocument()
			await waitFor(() => expect(focusSpy.mock.contexts).toContain(dialogAction))

			fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" })

			expect(screen.queryByRole("dialog", { name: "Preview dialog" })).not.toBeInTheDocument()
		} finally {
			HTMLElement.prototype.focus = originalFocus
		}
	})
})
