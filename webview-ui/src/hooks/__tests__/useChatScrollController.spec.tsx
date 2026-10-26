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

const createReadingAnchor = (
	scroller: HTMLElement,
	attribute: "data-chat-message-ts" | "data-activity-trace-id",
	identity: string,
	position: { top: number; height: number },
) => {
	const element = document.createElement("div")
	element.setAttribute(attribute, identity)
	vi.spyOn(element, "getBoundingClientRect").mockImplementation(
		() =>
			new DOMRect(
				0,
				scroller.getBoundingClientRect().top + position.top - scroller.scrollTop,
				300,
				position.height,
			),
	)
	scroller.append(element)
	return element
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

	it("preserves the visible message offset when history prepends and output appends in one commit", () => {
		const { result, rerender, initialProps, scroller } = createHarness()
		flushFrame()
		act(() => result.current.releaseFollow("load-older"))
		scroller.scrollTop = 450
		vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 40, 300, 400))
		createReadingAnchor(scroller, "data-chat-message-ts", "200", { top: 200, height: 100 })
		const position = { top: 430, height: 120 }
		const message = createReadingAnchor(scroller, "data-chat-message-ts", "400", position)
		message.setAttribute("data-chat-message-index", "1")
		const viewportOffset = message.getBoundingClientRect().top - scroller.getBoundingClientRect().top

		act(() => {
			result.current.preserveReadingAnchor(() => {
				// Prepending moves this row by 300px; independently appended output adds another 600px.
				position.top += 300
				message.setAttribute("data-chat-message-index", "20")
				setScrollGeometry(scroller, { scrollHeight: 1_900, clientHeight: 400, scrollTop: 450 })
				rerender(initialProps)
			})
		})

		expect(scroller.scrollTop).toBe(750)
		expect(message.getBoundingClientRect().top - scroller.getBoundingClientRect().top).toBe(viewportOffset)
		expect(result.current.scrollMode).toBe("BROWSING")
	})

	it("tracks a trace control when loading history moves its header into another row", () => {
		const { result, rerender, initialProps, scroller } = createHarness()
		flushFrame()
		act(() => result.current.releaseFollow("load-older"))
		scroller.scrollTop = 450
		const traceId = 'turn:run"id]:turn\\id'
		const previousPosition = { top: 500, height: 80 }
		const previousRow = createReadingAnchor(scroller, "data-chat-message-ts", "500", previousPosition)
		const previousControl = createReadingAnchor(scroller, "data-activity-trace-id", traceId, {
			top: 500,
			height: 30,
		})
		previousRow.append(previousControl)
		const viewportOffset = previousControl.getBoundingClientRect().top
		let nextControl: HTMLElement | undefined

		act(() => {
			result.current.preserveReadingAnchor(() => {
				previousPosition.height = 0
				previousControl.remove()
				const nextRow = createReadingAnchor(scroller, "data-chat-message-ts", "300", { top: 730, height: 80 })
				nextControl = createReadingAnchor(scroller, "data-activity-trace-id", traceId, { top: 730, height: 30 })
				nextRow.append(nextControl)
				setScrollGeometry(scroller, { scrollHeight: 1_300, clientHeight: 400, scrollTop: 450 })
				rerender(initialProps)
			})
		})

		expect(scroller.scrollTop).toBe(680)
		expect(nextControl?.getBoundingClientRect().top).toBe(viewportOffset)
		expect(result.current.scrollMode).toBe("BROWSING")
	})

	it("lets explicit checkpoint navigation supersede a pending history anchor", () => {
		const { result, rerender, initialProps, scroller } = createHarness()
		flushFrame()
		act(() => result.current.releaseFollow("load-older"))
		scroller.scrollTop = 450
		const position = { top: 500, height: 80 }
		createReadingAnchor(scroller, "data-chat-message-ts", "500", position)

		act(() => {
			result.current.preserveReadingAnchor(() => {
				position.top += 300
			})
			result.current.releaseFollow("checkpoint-navigation")
			rerender(initialProps)
		})

		expect(scroller.scrollTop).toBe(450)
	})

	it("does not carry a pending history anchor into a task with the same transcript timestamps", () => {
		const { result, rerender, initialProps, scroller } = createHarness({ taskKey: "task-one" })
		flushFrame()
		act(() => result.current.releaseFollow("load-older"))
		scroller.scrollTop = 450
		const position = { top: 500, height: 80 }
		createReadingAnchor(scroller, "data-chat-message-ts", "500", position)

		act(() => {
			result.current.preserveReadingAnchor(() => {
				position.top += 300
				rerender({ ...initialProps, taskKey: "task-two" })
			})
		})

		expect(scroller.scrollTop).toBe(450)
		flushFrame()
		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(scroller.scrollTop).toBe(600)
	})

	it("does not restore a history anchor onto a replacement scroller", () => {
		const { result, rerender, initialProps, scroller } = createHarness()
		flushFrame()
		act(() => result.current.releaseFollow("load-older"))
		scroller.scrollTop = 450
		const position = { top: 500, height: 80 }
		createReadingAnchor(scroller, "data-chat-message-ts", "500", position)
		const replacement = document.createElement("div")
		setScrollGeometry(replacement, { scrollHeight: 1_300, clientHeight: 400, scrollTop: 100 })
		createReadingAnchor(replacement, "data-chat-message-ts", "500", { top: 800, height: 80 })

		act(() => {
			result.current.preserveReadingAnchor(() => {
				position.top += 300
				result.current.setScrollerRef(replacement)
				rerender(initialProps)
			})
		})

		expect(scroller.scrollTop).toBe(450)
		expect(replacement.scrollTop).toBe(100)
	})

	it("keeps following output when a preserving update runs without browsing ownership", () => {
		const { result, rerender, initialProps, scroller } = createHarness()
		flushFrame()
		const position = { top: 650, height: 80 }
		createReadingAnchor(scroller, "data-chat-message-ts", "650", position)

		act(() => {
			result.current.preserveReadingAnchor(() => {
				position.top += 300
				setScrollGeometry(scroller, { scrollHeight: 1_300, clientHeight: 400, scrollTop: 600 })
				rerender({ ...initialProps, itemCount: 4 })
			})
		})
		flushFrame()

		expect(result.current.scrollMode).toBe("FOLLOWING")
		expect(scroller.scrollTop).toBe(900)
	})
})
