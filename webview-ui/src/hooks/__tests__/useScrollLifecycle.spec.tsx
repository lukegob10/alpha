import React from "react"
import { act, fireEvent, renderHook } from "@/utils/test-utils"
import type { VirtuosoHandle } from "react-virtuoso"

import {
	CHAT_BOTTOM_MAGNET_SETTLE_MS,
	CHAT_BOTTOM_MAGNET_VIEWPORT_RATIO,
	useScrollLifecycle,
	type UseScrollLifecycleOptions,
} from "../useScrollLifecycle"

const createHarness = (overrides: Partial<UseScrollLifecycleOptions> = {}) => {
	const scrollToIndex = vi.fn()
	const scrollTo = vi.fn()
	const autoscrollToBottom = vi.fn()
	const virtuosoRef = {
		current: {
			scrollToIndex,
			scrollTo,
			autoscrollToBottom,
		} as unknown as VirtuosoHandle,
	}
	const scrollContainer = document.createElement("div")
	const scroller = document.createElement("div")
	scroller.className = "scrollable"
	scrollContainer.appendChild(scroller)
	document.body.appendChild(scrollContainer)
	const scrollContainerRef = { current: scrollContainer }

	const initialProps: UseScrollLifecycleOptions = {
		virtuosoRef,
		scrollContainerRef,
		taskTs: 100,
		isHidden: false,
		hasTask: true,
		itemCount: 3,
		bottomContentRevision: { text: "initial" },
		...overrides,
	}

	const hook = renderHook((props: UseScrollLifecycleOptions) => useScrollLifecycle(props), {
		initialProps,
	})

	return {
		...hook,
		initialProps,
		scrollToIndex,
		scrollTo,
		autoscrollToBottom,
		scrollContainer,
		scroller,
	}
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

describe("useScrollLifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
		vi.unstubAllGlobals()
		document.body.replaceChildren()
	})

	it("positions a task once and never repositions it when messages append", () => {
		const { result, rerender, initialProps, scrollToIndex } = createHarness()

		expect(scrollToIndex).toHaveBeenCalledTimes(1)
		expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" })

		rerender({ ...initialProps, itemCount: 4, bottomContentRevision: { text: "appended" } })
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
		expect(result.current.followOutputCallback(false)).toBe("auto")
	})

	it("waits for asynchronous task rows before issuing the single initial position", () => {
		const { rerender, initialProps, scrollToIndex } = createHarness({ itemCount: 0 })
		expect(scrollToIndex).not.toHaveBeenCalled()

		rerender({ ...initialProps, itemCount: 2, bottomContentRevision: { text: "loaded" } })
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
	})

	it("pre-arms Virtuoso for streamed row growth and coalesces rapid revisions", () => {
		const { rerender, initialProps, autoscrollToBottom } = createHarness()
		expect(autoscrollToBottom).toHaveBeenCalledTimes(1)

		for (let index = 0; index < 8; index += 1) {
			rerender({ ...initialProps, bottomContentRevision: { text: `chunk-${index}` } })
		}
		expect(autoscrollToBottom).toHaveBeenCalledTimes(1)

		act(() => vi.advanceTimersByTime(100))
		rerender({ ...initialProps, bottomContentRevision: { text: "next-window" } })
		expect(autoscrollToBottom).toHaveBeenCalledTimes(2)
	})

	it("requires a deliberate upward yank before wheel scrolling leaves follow mode", () => {
		const { result, rerender, initialProps, scroller, autoscrollToBottom, scrollToIndex, scrollTo } =
			createHarness()
		setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })
		act(() => result.current.atBottomStateChangeCallback(true))

		fireEvent.wheel(scroller, { deltaY: -30 })
		scroller.scrollTop = 570
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")

		act(() => vi.advanceTimersByTime(CHAT_BOTTOM_MAGNET_SETTLE_MS))
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
		expect(scrollTo).toHaveBeenCalledTimes(1)

		scroller.scrollTop = 450
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(result.current.followOutputCallback(false)).toBe(false)
		expect(result.current.showScrollToBottom).toBe(true)

		act(() => vi.advanceTimersByTime(100))
		rerender({ ...initialProps, itemCount: 4, bottomContentRevision: { text: "streaming while browsing" } })
		expect(autoscrollToBottom).toHaveBeenCalledTimes(1)
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it("does not leave follow mode because Virtuoso transiently reports away from bottom", () => {
		const { result, scroller } = createHarness()
		act(() => result.current.atBottomStateChangeCallback(false))

		fireEvent.wheel(scroller, { deltaY: 120 })
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("magnetically re-engages following in the final five percent of the viewport", () => {
		const { result, scroller, scrollToIndex, scrollTo } = createHarness()
		fireEvent.keyDown(window, { key: "PageUp" })
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")

		setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 400 })
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)
		setScrollGeometry(scroller, {
			scrollHeight: 1_000,
			clientHeight: 400,
			scrollTop: 600 - 400 * CHAT_BOTTOM_MAGNET_VIEWPORT_RATIO,
		})
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)

		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it("keeps a small upward scroll captured and returns it to the physical bottom", () => {
		const { result, scroller, scrollTo } = createHarness()
		setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })
		act(() => result.current.atBottomStateChangeCallback(true))

		fireEvent.wheel(scroller, { deltaY: -120 })
		scroller.scrollTop = 570
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)

		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)

		act(() => vi.advanceTimersByTime(CHAT_BOTTOM_MAGNET_SETTLE_MS))
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it("does not mistake viewport resizing at the physical bottom for an upward user scroll", () => {
		const { result, scroller } = createHarness()
		setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)

		setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 450, scrollTop: 550 })
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)

		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)
	})

	it("re-pins after the transcript viewport resizes only while follow mode is active", () => {
		let resizeObserverCallback: ResizeObserverCallback | undefined
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

		const { result, scrollTo } = createHarness()
		expect(resizeObserverCallback).toBeDefined()

		act(() => {
			resizeObserverCallback?.([{ contentRect: { height: 300 } } as ResizeObserverEntry], {} as ResizeObserver)
			vi.advanceTimersByTime(16)
		})
		expect(scrollTo).toHaveBeenCalledTimes(1)

		fireEvent.keyDown(window, { key: "PageUp" })
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		act(() => {
			resizeObserverCallback?.([{ contentRect: { height: 240 } } as ResizeObserverEntry], {} as ResizeObserver)
			vi.advanceTimersByTime(16)
		})

		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it("detects upward native scrollbar movement without pointer events", () => {
		const { result, scroller } = createHarness()
		setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)

		scroller.scrollTop = 200
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)

		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("uses exactly one coordinated command for the explicit bottom action", () => {
		const { result, scroller, scrollToIndex, scrollTo } = createHarness()
		fireEvent.wheel(scroller, { deltaY: -120 })
		const indexCallsBeforeClick = scrollToIndex.mock.calls.length

		act(() => result.current.handleScrollToBottomClick())

		expect(scrollToIndex).toHaveBeenCalledTimes(indexCallsBeforeClick)
		expect(scrollTo).toHaveBeenCalledTimes(1)
		expect(scrollTo).toHaveBeenLastCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})
})
