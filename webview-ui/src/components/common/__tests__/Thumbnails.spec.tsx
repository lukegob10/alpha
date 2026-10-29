import { useState } from "react"
import userEvent from "@testing-library/user-event"

import { act, fireEvent, render, screen } from "@/utils/test-utils"
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
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

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

	describe("height tracking", () => {
		const mockAnimationFrames = () => {
			const callbacks = new Map<number, FrameRequestCallback>()
			let nextId = 0
			const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
				const id = ++nextId
				callbacks.set(id, callback)
				return id
			})
			const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
				callbacks.delete(id)
			})
			const flush = () => {
				const pending = [...callbacks.values()]
				callbacks.clear()
				for (const callback of pending) callback(0)
			}
			return { request, cancel, flush }
		}

		it("does no layout reads or resize subscriptions for 100 historical thumbnail lists", () => {
			const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
			const bounds = vi.spyOn(Element.prototype, "getBoundingClientRect")
			const subscribe = vi.spyOn(window, "addEventListener")
			const thumbnails = () =>
				Array.from({ length: 100 }, (_, index) => <Thumbnails key={index} images={[firstImage]} />)
			const view = render(<>{thumbnails()}</>)

			view.rerender(<>{thumbnails()}</>)
			fireEvent(window, new Event("resize"))

			expect(height).not.toHaveBeenCalled()
			expect(bounds).not.toHaveBeenCalled()
			expect(subscribe.mock.calls.filter(([event]) => event === "resize")).toHaveLength(0)
			expect(screen.getAllByRole("img")).toHaveLength(100)
		})

		it("reports the current height on mount and image changes", () => {
			const onHeightChange = vi.fn()
			const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(34)
			const view = render(<Thumbnails images={[firstImage]} onHeightChange={onHeightChange} />)
			expect(onHeightChange).toHaveBeenLastCalledWith(34)

			height.mockReturnValue(68)
			view.rerender(<Thumbnails images={[firstImage, secondImage]} onHeightChange={onHeightChange} />)

			expect(onHeightChange).toHaveBeenCalledTimes(2)
			expect(onHeightChange).toHaveBeenLastCalledWith(68)
		})

		it("retains the bounding-box fallback for a browser returning zero clientHeight", () => {
			const onHeightChange = vi.fn()
			vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(0)
			const bounds = vi
				.spyOn(Element.prototype, "getBoundingClientRect")
				.mockReturnValue(new DOMRect(0, 0, 34, 37))

			render(<Thumbnails images={[firstImage]} onHeightChange={onHeightChange} />)

			expect(bounds).toHaveBeenCalledTimes(1)
			expect(onHeightChange).toHaveBeenCalledWith(37)
		})

		it("coalesces width changes into one measurement and ignores height-only resizes", () => {
			vi.stubGlobal("innerWidth", 1000)
			const frames = mockAnimationFrames()
			const onHeightChange = vi.fn()
			const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(34)
			render(<Thumbnails images={[firstImage]} onHeightChange={onHeightChange} />)
			height.mockClear()
			onHeightChange.mockClear()

			fireEvent(window, new Event("resize"))
			expect(frames.request).not.toHaveBeenCalled()
			vi.stubGlobal("innerWidth", 900)
			fireEvent(window, new Event("resize"))
			vi.stubGlobal("innerWidth", 800)
			fireEvent(window, new Event("resize"))
			expect(frames.request).toHaveBeenCalledTimes(1)
			expect(height).not.toHaveBeenCalled()
			height.mockReturnValue(68)
			act(frames.flush)

			expect(height).toHaveBeenCalledTimes(1)
			expect(onHeightChange).toHaveBeenCalledTimes(1)
			expect(onHeightChange).toHaveBeenCalledWith(68)
		})

		it("replaces callbacks without delivering a pending resize to the previous callback", () => {
			vi.stubGlobal("innerWidth", 1000)
			const frames = mockAnimationFrames()
			const onFirstHeight = vi.fn()
			const onNextHeight = vi.fn()
			const images = [firstImage]
			const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(34)
			const view = render(<Thumbnails images={images} onHeightChange={onFirstHeight} />)
			vi.stubGlobal("innerWidth", 900)
			fireEvent(window, new Event("resize"))
			height.mockReturnValue(68)

			view.rerender(<Thumbnails images={images} onHeightChange={onNextHeight} />)
			act(frames.flush)

			expect(frames.cancel).toHaveBeenCalledTimes(1)
			expect(onFirstHeight).toHaveBeenCalledTimes(1)
			expect(onNextHeight).toHaveBeenCalledTimes(1)
			expect(onNextHeight).toHaveBeenCalledWith(68)
			vi.stubGlobal("innerWidth", 800)
			fireEvent(window, new Event("resize"))
			act(frames.flush)
			expect(onFirstHeight).toHaveBeenCalledTimes(1)
			expect(onNextHeight).toHaveBeenCalledTimes(2)
		})

		it("releases the resize listener and pending frame when tracking stops or the list unmounts", () => {
			vi.stubGlobal("innerWidth", 1000)
			const frames = mockAnimationFrames()
			const subscribe = vi.spyOn(window, "addEventListener")
			const unsubscribe = vi.spyOn(window, "removeEventListener")
			const onHeightChange = vi.fn()
			const images = [firstImage]
			const view = render(<Thumbnails images={images} onHeightChange={onHeightChange} />)
			vi.stubGlobal("innerWidth", 900)
			fireEvent(window, new Event("resize"))

			view.rerender(<Thumbnails images={images} />)
			act(frames.flush)
			expect(frames.cancel).toHaveBeenCalledTimes(1)
			const firstListener = subscribe.mock.calls.find(([event]) => event === "resize")![1]
			expect(unsubscribe).toHaveBeenCalledWith("resize", firstListener)
			expect(onHeightChange).toHaveBeenCalledTimes(1)

			view.rerender(<Thumbnails images={images} onHeightChange={onHeightChange} />)
			vi.stubGlobal("innerWidth", 800)
			fireEvent(window, new Event("resize"))
			view.unmount()
			act(frames.flush)

			expect(frames.cancel).toHaveBeenCalledTimes(2)
			expect(unsubscribe.mock.calls.filter(([event]) => event === "resize")).toHaveLength(2)
			expect(onHeightChange).toHaveBeenCalledTimes(2)
		})
	})
})
