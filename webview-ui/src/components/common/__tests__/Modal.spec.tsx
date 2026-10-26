import { useState } from "react"
import userEvent from "@testing-library/user-event"

import { cleanup, render, screen, waitFor } from "@/utils/test-utils"
import { installNativeTestFocus } from "@/utils/test-native-focus"

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
				<button type="button">Last dialog action</button>
			</Modal>
		</>
	)
}

describe("Modal", () => {
	let restoreFocus: () => void

	beforeEach(() => {
		restoreFocus = installNativeTestFocus()
	})

	afterEach(() => {
		cleanup()
		restoreFocus()
	})

	it("names the dialog, contains keyboard focus, and restores its opener after Escape", async () => {
		const user = userEvent.setup()
		render(<ModalHarness />)

		const opener = screen.getByRole("button", { name: "Open preview" })
		await user.click(opener)

		const dialog = screen.getByRole("dialog", { name: "Preview dialog" })
		const first = screen.getByRole("button", { name: "Dialog action" })
		const last = screen.getByRole("button", { name: "Last dialog action" })
		expect(dialog).toHaveAccessibleName("Preview dialog")
		await waitFor(() => expect(first).toHaveFocus())
		await user.tab({ shift: true })
		expect(last).toHaveFocus()
		await user.tab()
		expect(first).toHaveFocus()
		await user.tab()
		expect(last).toHaveFocus()
		await user.keyboard("{Escape}")

		expect(screen.queryByRole("dialog", { name: "Preview dialog" })).not.toBeInTheDocument()
		await waitFor(() => expect(opener).toHaveFocus())
	})
})
