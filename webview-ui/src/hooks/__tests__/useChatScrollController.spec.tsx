import React from "react"
import { act, renderHook } from "@/utils/test-utils"

import { useChatScrollController, type UseChatScrollControllerOptions } from "../useChatScrollController"

let nextFrameId = 1
let frameCallbacks = new Map<number, FrameRequestCallback>()
let resizeObserverCallback: ResizeObserverCallback | undefined

const flushFrame = () => {
	const callbacks = [...frameCallbacks.values()]
	frameCallbacks.clear()
	act(() => callbacks.forEach((callback) => callback(performance.now())))
}

const setScrollGeometry = (
	element: HTMLElement,
	{ scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number },
) => {
	Object.defineProperties(element, {
		scrollHeight: { configurable: true, value: scrollHeight },
		clientHeight: { configurable: true, value: clientHeight },
		scrollTop: { configurable: true, writable: true, value: scrollTop },
	})
}

const emitScroll = (result: { current: ReturnType<typeof useChatScrollController> }, scroller: HTMLElement) => {
	act(() => {
		result.current.handleScrollerScroll({
			target: scroller,
			currentTarget: scroller,
		} as unknown as React.UIEvent<HTMLElement>)
	})
}

const createHarness = (overrides: Partial<UseChatScrollControllerOptions> = {}) => {
	const initialProps: UseChatScrollControllerOptions = {
		taskTs: 100,
		itemCount: 3,
		...overrides,
	}
	const hook = renderHook((props: UseChatScrollControllerOptions) => useChatScrollController(props), {
		initialProps,
	})
	const scroller = document.createElement("div")
	const content = document.createElement("div")
	setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })
	act(() => {
		hook.result.current.setScrollerRef(scroller)
		hook.result.current.setContentRef(content)
	})

	return { ...hook, initialProps, scroller, content }
}

describe("useChatScrollController", () => {
	beforeEach(() => {
		nextFrameId = 1
		frameCallbacks = new Map()
		resizeObserverCallback = undefined
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			const id = nextFrameId++
			frameCallbacks.set(id, callback)
			return id
		})
		vi.stubGlobal("cancelAnimationFrame", (id: number) => {
			frameCallbacks.delete(id)
		})
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: ResizeObserverCallback) {
					resizeObserverCallback = callback
				}
				observe() {}
				disconnect() {}
			},
		)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("coalesces automatic bottom triggers through one frame and pins the exact native bottom", () => {
		const { result, scroller } = createHarness()
		scroller.scrollTop = 450

		act(() => {
			result.current.handleContentLoad()
			resizeObserverCallback?.([], {} as ResizeObserver)
			resizeObserverCallback?.([], {} as ResizeObserver)
		})

		expect(frameCallbacks).toHaveLength(1)
		flushFrame()
		expect(scroller.scrollTop).toBe(600)
	})

	it("releases follow immediately for an upward wheel gesture", () => {
		const { result } = createHarness()
		flushFrame()

		act(() => {
			result.current.handleScrollerWheel({ deltaY: -1 } as React.WheelEvent<HTMLElement>)
		})

		expect(result.current.scrollMode).toBe("BROWSING")
		expect(result.current.showScrollToBottom).toBe(true)
	})

	it("releases follow when a native scrollbar drag moves upward", () => {
		const { result, scroller } = createHarness()
		flushFrame()

		act(() => result.current.handleScrollerPointerDown())
		scroller.scrollTop = 550
		emitScroll(result, scroller)
		act(() => result.current.handleScrollerPointerUp())

		expect(result.current.scrollMode).toBe("BROWSING")
	})

	it("does not misclassify viewport or content resizing as user escape", () => {
		const { result, scroller } = createHarness()
		flushFrame()

		setScrollGeometry(scroller, { scrollHeight: 1_250, clientHeight: 250, scrollTop: 450 })
		emitScroll(result, scroller)
		flushFrame()

		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(scroller.scrollTop).toBe(1_000)
	})

	it("reattaches at the real bottom even if row geometry changed during the scroll", () => {
		const { result, scroller } = createHarness()
		flushFrame()
		act(() => result.current.releaseFollow("row-expansion"))

		scroller.scrollTop = 450
		emitScroll(result, scroller)
		setScrollGeometry(scroller, { scrollHeight: 1_100, clientHeight: 400, scrollTop: 700 })
		emitScroll(result, scroller)
		flushFrame()

		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)
		expect(scroller.scrollTop).toBe(700)
	})

	it("never follows content growth while the user is browsing", () => {
		const { result, scroller } = createHarness()
		flushFrame()
		act(() => result.current.releaseFollow("checkpoint-navigation"))
		scroller.scrollTop = 450

		setScrollGeometry(scroller, { scrollHeight: 1_500, clientHeight: 400, scrollTop: 450 })
		act(() => {
			result.current.handleContentLoad()
			resizeObserverCallback?.([], {} as ResizeObserver)
		})
		flushFrame()

		expect(scroller.scrollTop).toBe(450)
		expect(result.current.scrollMode).toBe("BROWSING")
	})

	it("cancels a pending pin as soon as browsing takes ownership", () => {
		const { result, scroller } = createHarness()
		scroller.scrollTop = 450
		act(() => result.current.releaseFollow("task-header-toggle"))
		flushFrame()

		expect(scroller.scrollTop).toBe(450)
	})

	it("re-enters follow mode and pins for the explicit bottom action", () => {
		const { result, scroller } = createHarness()
		flushFrame()
		act(() => result.current.releaseFollow("row-expansion"))
		scroller.scrollTop = 450

		act(() => result.current.handleScrollToBottomClick())
		flushFrame()

		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(scroller.scrollTop).toBe(600)
	})

	it("resets a switched task to follow mode without reviving follow on append", () => {
		const { result, rerender, initialProps, scroller } = createHarness()
		flushFrame()
		act(() => result.current.releaseFollow("row-expansion"))
		scroller.scrollTop = 450

		rerender({ ...initialProps, itemCount: 4 })
		flushFrame()
		expect(result.current.scrollMode).toBe("BROWSING")
		expect(scroller.scrollTop).toBe(450)

		rerender({ ...initialProps, taskTs: 200, itemCount: 4 })
		flushFrame()
		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(scroller.scrollTop).toBe(600)
	})
})
