import React from "react"
import { act, renderHook } from "@/utils/test-utils"
import type { VirtuosoHandle } from "react-virtuoso"

import {
	CHAT_BOTTOM_MAGNET_VIEWPORT_RATIO,
	useChatScrollController,
	type UseChatScrollControllerOptions,
} from "../useChatScrollController"

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
	const scrollTo = vi.fn()
	const scrollToIndex = vi.fn()
	const autoscrollToBottom = vi.fn()
	const virtuosoRef = {
		current: {
			scrollTo,
			scrollToIndex,
			autoscrollToBottom,
		} as unknown as VirtuosoHandle,
	}
	const initialProps: UseChatScrollControllerOptions = {
		virtuosoRef,
		taskTs: 100,
		itemCount: 3,
		...overrides,
	}
	const hook = renderHook((props: UseChatScrollControllerOptions) => useChatScrollController(props), {
		initialProps,
	})
	const scroller = document.createElement("div")
	setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })
	act(() => hook.result.current.setScrollerRef(scroller))

	return {
		...hook,
		initialProps,
		scroller,
		scrollTo,
		scrollToIndex,
		autoscrollToBottom,
	}
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

	it("coalesces every automatic bottom trigger through one frame and one command", () => {
		const { result, scrollTo, scrollToIndex, autoscrollToBottom } = createHarness()

		act(() => {
			result.current.handleContentHeightChange(1_200)
			result.current.handleContentLoad()
			resizeObserverCallback?.([], {} as ResizeObserver)
		})
		flushFrame()

		expect(scrollTo).toHaveBeenCalledTimes(1)
		expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
		expect(scrollToIndex).not.toHaveBeenCalled()
		expect(autoscrollToBottom).not.toHaveBeenCalled()
	})

	it("keeps a small upward nudge captured and re-pins only after scrolling becomes idle", () => {
		const { result, scroller, scrollTo } = createHarness()
		flushFrame()
		scrollTo.mockClear()

		scroller.scrollTop = 570
		emitScroll(result, scroller)
		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(frameCallbacks).toHaveLength(0)

		act(() => result.current.handleScrollerIdleChange(false))
		flushFrame()
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it("requires a stable-geometry upward yank beyond the release zone", () => {
		const { result, scroller, scrollTo } = createHarness()
		flushFrame()
		scrollTo.mockClear()

		scroller.scrollTop = 450
		emitScroll(result, scroller)

		expect(result.current.scrollMode).toBe("BROWSING")
		expect(result.current.showScrollToBottom).toBe(true)
		act(() => result.current.handleScrollerIdleChange(false))
		flushFrame()
		expect(scrollTo).not.toHaveBeenCalled()
	})

	it("does not misclassify a viewport or content resize as user escape", () => {
		const { result, scroller, scrollTo } = createHarness()
		flushFrame()
		scrollTo.mockClear()

		setScrollGeometry(scroller, { scrollHeight: 1_250, clientHeight: 250, scrollTop: 450 })
		emitScroll(result, scroller)
		flushFrame()

		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it("magnetically captures downward scrolling in the final five percent", () => {
		const { result, scroller, scrollTo } = createHarness()
		flushFrame()
		scrollTo.mockClear()
		act(() => result.current.releaseFollow("row-expansion"))

		scroller.scrollTop = 400
		emitScroll(result, scroller)
		scroller.scrollTop = 600 - 400 * CHAT_BOTTOM_MAGNET_VIEWPORT_RATIO
		emitScroll(result, scroller)
		flushFrame()

		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it("never follows content growth while the user is browsing", () => {
		const { result, scrollTo } = createHarness()
		flushFrame()
		scrollTo.mockClear()
		act(() => result.current.releaseFollow("checkpoint-navigation"))

		act(() => {
			result.current.handleContentHeightChange(1_500)
			result.current.handleContentLoad()
			resizeObserverCallback?.([], {} as ResizeObserver)
		})
		flushFrame()

		expect(scrollTo).not.toHaveBeenCalled()
		expect(result.current.scrollMode).toBe("BROWSING")
	})

	it("cancels a pending automatic pin as soon as browsing takes ownership", () => {
		const { result, scrollTo } = createHarness()
		act(() => result.current.releaseFollow("task-header-toggle"))
		flushFrame()

		expect(scrollTo).not.toHaveBeenCalled()
	})

	it("re-enters follow mode and schedules exactly one pin for the bottom action", () => {
		const { result, scrollTo } = createHarness()
		flushFrame()
		scrollTo.mockClear()
		act(() => result.current.releaseFollow("row-expansion"))

		act(() => result.current.handleScrollToBottomClick())
		flushFrame()

		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it("resets a switched task to follow mode without reviving follow on message append", () => {
		const { result, rerender, initialProps, scrollTo } = createHarness()
		flushFrame()
		scrollTo.mockClear()
		act(() => result.current.releaseFollow("row-expansion"))

		rerender({ ...initialProps, itemCount: 4 })
		flushFrame()
		expect(result.current.scrollMode).toBe("BROWSING")
		expect(scrollTo).not.toHaveBeenCalled()

		rerender({ ...initialProps, taskTs: 200, itemCount: 4 })
		flushFrame()
		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})
})
