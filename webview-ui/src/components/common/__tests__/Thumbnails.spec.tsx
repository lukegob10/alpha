import { useState } from "react"
import userEvent from "@testing-library/user-event"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import Thumbnails from "../Thumbnails"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const firstImage = "data:image/png;base64,first"
const secondImage = "data:image/png;base64,second"

const EditableThumbnails = () => {
	const [images, setImages] = useState([firstImage, secondImage])
	return <Thumbnails images={images} setImages={setImages} />
}

describe("Thumbnails", () => {
	beforeEach(() => vi.mocked(vscode.postMessage).mockClear())
	afterEach(() => vi.restoreAllMocks())

	it.each(["{Enter}", " "])("opens an attachment with %s", async (key) => {
		const user = userEvent.setup()
		render(<Thumbnails images={[firstImage]} />)
		const opener = screen.getByRole("button", { name: "Open attachment 1" })
		expect(opener).toHaveAttribute("type", "button")
		expect(opener.tabIndex).toBe(0)
		// FAST's shared test setup replaces native focus with a no-op.
		vi.spyOn(document, "activeElement", "get").mockReturnValue(opener)

		await user.keyboard(key)

		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openImage", text: firstImage })
		expect(screen.queryByRole("button", { name: /Remove attachment/ })).not.toBeInTheDocument()
	})

	it.each(["{Enter}", " "])("removes only the selected attachment with %s", async (key) => {
		const user = userEvent.setup()
		render(<EditableThumbnails />)
		const remove = screen.getByRole("button", { name: "Remove attachment 1" })
		expect(remove).toHaveAttribute("type", "button")
		expect(remove.tabIndex).toBe(0)
		vi.spyOn(document, "activeElement", "get").mockReturnValue(remove)

		await user.keyboard(key)

		expect(screen.getAllByRole("img")).toHaveLength(1)
		expect(screen.getByRole("img")).toHaveAttribute("src", secondImage)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps thumbnail actions from activating an enclosing message row", () => {
		const onClick = vi.fn()
		render(
			<div onClick={onClick}>
				<EditableThumbnails />
			</div>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Open attachment 1" }))
		fireEvent.click(screen.getByRole("button", { name: "Remove attachment 1" }))

		expect(onClick).not.toHaveBeenCalled()
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openImage", text: firstImage })
		expect(screen.getByRole("img")).toHaveAttribute("src", secondImage)
	})
})
