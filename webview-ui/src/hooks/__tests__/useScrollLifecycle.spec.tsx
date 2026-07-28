import React from "react"
import { act, fireEvent, renderHook } from "@/utils/test-utils"
import type { VirtuosoHandle } from "react-virtuoso"

import { CHAT_BOTTOM_THRESHOLD_PX, useScrollLifecycle, type UseScrollLifecycleOptions } from "../useScrollLifecycle"

const createHarness = (overrides: Partial<UseScrollLifecycleOptions> = {}) => {
	const scrollToIndex = vi.fn()
	const autoscrollToBottom = vi.fn()
	const virtuosoRef = {
		current: {
			scrollToIndex,
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

	it("gives wheel scrolling full ownership and does no streaming work while browsing", () => {
		const { result, rerender, initialProps, scroller, autoscrollToBottom, scrollToIndex } = createHarness()
		act(() => result.current.atBottomStateChangeCallback(true))

		fireEvent.wheel(scroller, { deltaY: -120 })
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(result.current.followOutputCallback(false)).toBe(false)
		expect(result.current.showScrollToBottom).toBe(true)

		act(() => vi.advanceTimersByTime(100))
		rerender({ ...initialProps, itemCount: 4, bottomContentRevision: { text: "streaming while browsing" } })
		expect(autoscrollToBottom).toHaveBeenCalledTimes(1)
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
	})

	it("also yields to downward wheel input when the viewport has drifted from bottom", () => {
		const { result, scroller } = createHarness()
		act(() => result.current.atBottomStateChangeCallback(false))

		fireEvent.wheel(scroller, { deltaY: 120 })
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("re-engages following only at the physical bottom", () => {
		const { result, scroller } = createHarness()
		fireEvent.keyDown(window, { key: "PageUp" })
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")

		setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 400 })
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)
		setScrollGeometry(scroller, {
			scrollHeight: 1_000,
			clientHeight: 400,
			scrollTop: 600 - CHAT_BOTTOM_THRESHOLD_PX,
		})
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)

		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)
	})

	it("does not recapture an upward scroll near the physical bottom", () => {
		const { result, scroller } = createHarness()
		setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })
		act(() => result.current.atBottomStateChangeCallback(true))

		fireEvent.wheel(scroller, { deltaY: -120 })
		scroller.scrollTop = 570
		act(() =>
			result.current.handleScrollerScroll({ currentTarget: scroller } as unknown as React.UIEvent<HTMLElement>),
		)

		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(result.current.showScrollToBottom).toBe(true)
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
		const { result, scroller, scrollToIndex } = createHarness()
		fireEvent.wheel(scroller, { deltaY: -120 })
		const callsBeforeClick = scrollToIndex.mock.calls.length

		act(() => result.current.handleScrollToBottomClick())

		expect(scrollToIndex).toHaveBeenCalledTimes(callsBeforeClick + 1)
		expect(scrollToIndex).toHaveBeenLastCalledWith({ index: "LAST", align: "end", behavior: "auto" })
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})
})
