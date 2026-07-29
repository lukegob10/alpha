/**
 * Native chat transcript scroll controller.
 *
 * The transcript deliberately uses the browser's real scroll container instead
 * of a virtualizer. Chat rows have highly variable, asynchronous heights; a
 * virtualizer must estimate the total height and those corrections make the
 * scrollbar thumb jump even when the view remains pinned to the bottom.
 *
 * This controller is the sole owner of automatic scrolling. It follows live
 * output while attached, releases when the user deliberately scrolls upward,
 * and reattaches when native scrolling reaches the real bottom.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

export const CHAT_BOTTOM_EPSILON_PX = 1
export const CHAT_BOTTOM_ATTACH_DISTANCE_PX = 12
export const CHAT_USER_RELEASE_DISTANCE_PX = 24

const GEOMETRY_EPSILON_PX = 0.5

export type ChatScrollMode = "FOLLOWING" | "BROWSING"

export type ChatScrollReleaseReason = "user-scroll" | "row-expansion" | "task-header-toggle" | "checkpoint-navigation"

interface ScrollGeometry {
	scrollTop: number
	clientHeight: number
	scrollHeight: number
}

const readGeometry = (element: HTMLElement): ScrollGeometry => ({
	scrollTop: element.scrollTop,
	clientHeight: element.clientHeight,
	scrollHeight: element.scrollHeight,
})

const distanceFromBottom = ({ scrollTop, clientHeight, scrollHeight }: ScrollGeometry): number =>
	Math.max(0, scrollHeight - clientHeight - scrollTop)

const dimensionsChanged = (previous: ScrollGeometry, current: ScrollGeometry): boolean =>
	Math.abs(previous.clientHeight - current.clientHeight) > GEOMETRY_EPSILON_PX ||
	Math.abs(previous.scrollHeight - current.scrollHeight) > GEOMETRY_EPSILON_PX

export interface UseChatScrollControllerOptions {
	taskTs: number | undefined
	itemCount: number
}

export interface UseChatScrollControllerReturn {
	scrollMode: ChatScrollMode
	showScrollToBottom: boolean
	handleScrollToBottomClick: () => void
	releaseFollow: (reason: ChatScrollReleaseReason) => void
	setScrollerRef: (element: HTMLElement | null) => void
	setContentRef: (element: HTMLElement | null) => void
	handleScrollerScroll: (event: React.UIEvent<HTMLElement>) => void
	handleScrollerWheel: (event: React.WheelEvent<HTMLElement>) => void
	handleScrollerPointerDown: () => void
	handleScrollerPointerUp: () => void
	handleContentLoad: () => void
}

export function useChatScrollController({
	taskTs,
	itemCount,
}: UseChatScrollControllerOptions): UseChatScrollControllerReturn {
	const hasTask = taskTs !== undefined
	const [scrollMode, setScrollMode] = useState<ChatScrollMode>(hasTask ? "FOLLOWING" : "BROWSING")
	const scrollModeRef = useRef<ChatScrollMode>(hasTask ? "FOLLOWING" : "BROWSING")
	const taskTsRef = useRef(taskTs)
	const itemCountRef = useRef(itemCount)
	const scrollerRef = useRef<HTMLElement | null>(null)
	const contentRef = useRef<HTMLElement | null>(null)
	const previousGeometryRef = useRef<ScrollGeometry | null>(null)
	const pointerScrollingRef = useRef(false)
	const resizeObserverRef = useRef<ResizeObserver | null>(null)
	const bottomPinFrameRef = useRef<number | null>(null)

	taskTsRef.current = taskTs
	itemCountRef.current = itemCount

	const cancelBottomPin = useCallback(() => {
		if (bottomPinFrameRef.current === null) {
			return
		}
		window.cancelAnimationFrame(bottomPinFrameRef.current)
		bottomPinFrameRef.current = null
	}, [])

	const transitionTo = useCallback((nextMode: ChatScrollMode) => {
		if (scrollModeRef.current === nextMode) {
			return
		}
		scrollModeRef.current = nextMode
		setScrollMode(nextMode)
	}, [])

	// This is the controller's only automatic scroll write. It targets the
	// browser's exact maximum instead of an estimated virtual-list position.
	const scheduleBottomPin = useCallback(() => {
		if (
			scrollModeRef.current !== "FOLLOWING" ||
			taskTsRef.current === undefined ||
			itemCountRef.current === 0 ||
			bottomPinFrameRef.current !== null
		) {
			return
		}

		bottomPinFrameRef.current = window.requestAnimationFrame(() => {
			bottomPinFrameRef.current = null
			const scroller = scrollerRef.current
			if (
				!scroller ||
				scrollModeRef.current !== "FOLLOWING" ||
				taskTsRef.current === undefined ||
				itemCountRef.current === 0
			) {
				return
			}

			const geometry = readGeometry(scroller)
			const bottom = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
			if (Math.abs(geometry.scrollTop - bottom) > CHAT_BOTTOM_EPSILON_PX) {
				scroller.scrollTop = bottom
			}
			previousGeometryRef.current = readGeometry(scroller)
		})
	}, [])

	const reconnectResizeObserver = useCallback(() => {
		resizeObserverRef.current?.disconnect()
		resizeObserverRef.current = null

		if (typeof ResizeObserver === "undefined") {
			return
		}

		const scroller = scrollerRef.current
		const content = contentRef.current
		if (!scroller && !content) {
			return
		}

		const observer = new ResizeObserver(() => {
			if (scrollModeRef.current === "FOLLOWING") {
				scheduleBottomPin()
			}
		})
		if (scroller) {
			observer.observe(scroller)
		}
		if (content) {
			observer.observe(content)
		}
		resizeObserverRef.current = observer
	}, [scheduleBottomPin])

	const releaseFollow = useCallback(
		(_reason: ChatScrollReleaseReason) => {
			cancelBottomPin()
			transitionTo("BROWSING")
		},
		[cancelBottomPin, transitionTo],
	)

	const enterFollowMode = useCallback(() => {
		transitionTo("FOLLOWING")
		scheduleBottomPin()
	}, [scheduleBottomPin, transitionTo])

	const setScrollerRef = useCallback(
		(element: HTMLElement | null) => {
			scrollerRef.current = element
			previousGeometryRef.current = element ? readGeometry(element) : null
			reconnectResizeObserver()
			scheduleBottomPin()
		},
		[reconnectResizeObserver, scheduleBottomPin],
	)

	const setContentRef = useCallback(
		(element: HTMLElement | null) => {
			contentRef.current = element
			reconnectResizeObserver()
			scheduleBottomPin()
		},
		[reconnectResizeObserver, scheduleBottomPin],
	)

	useEffect(
		() => () => {
			cancelBottomPin()
			resizeObserverRef.current?.disconnect()
		},
		[cancelBottomPin],
	)

	// A new task starts attached to its output. Appending to the same task never
	// overrides an explicit browsing decision.
	useLayoutEffect(() => {
		cancelBottomPin()
		pointerScrollingRef.current = false
		previousGeometryRef.current = scrollerRef.current ? readGeometry(scrollerRef.current) : null

		if (taskTs === undefined) {
			transitionTo("BROWSING")
			return
		}

		transitionTo("FOLLOWING")
		scheduleBottomPin()
	}, [cancelBottomPin, scheduleBottomPin, taskTs, transitionTo])

	useLayoutEffect(() => {
		if (itemCount > 0 && scrollModeRef.current === "FOLLOWING") {
			scheduleBottomPin()
		}
	}, [itemCount, scheduleBottomPin])

	const handleScrollerScroll = useCallback(
		(event: React.UIEvent<HTMLElement>) => {
			if (event.target !== event.currentTarget) {
				return
			}

			const current = readGeometry(event.currentTarget)
			const previous = previousGeometryRef.current
			previousGeometryRef.current = current

			if (!previous || taskTsRef.current === undefined) {
				return
			}

			const remaining = distanceFromBottom(current)
			const movedUp = current.scrollTop < previous.scrollTop - GEOMETRY_EPSILON_PX
			const movedDown = current.scrollTop > previous.scrollTop + GEOMETRY_EPSILON_PX
			const layoutChanged = dimensionsChanged(previous, current)

			if (scrollModeRef.current === "BROWSING") {
				// Reaching the real native bottom always reattaches. Unlike the former
				// virtualized implementation, a simultaneous row resize cannot veto it.
				if (remaining <= CHAT_BOTTOM_ATTACH_DISTANCE_PX && (movedDown || remaining <= CHAT_BOTTOM_EPSILON_PX)) {
					enterFollowMode()
				}
				return
			}

			if (
				movedUp &&
				!layoutChanged &&
				(pointerScrollingRef.current || remaining >= CHAT_USER_RELEASE_DISTANCE_PX)
			) {
				releaseFollow("user-scroll")
				return
			}

			if (remaining > CHAT_BOTTOM_EPSILON_PX) {
				scheduleBottomPin()
			}
		},
		[enterFollowMode, releaseFollow, scheduleBottomPin],
	)

	const handleScrollerWheel = useCallback(
		(event: React.WheelEvent<HTMLElement>) => {
			if (event.deltaY < 0 && scrollModeRef.current === "FOLLOWING") {
				releaseFollow("user-scroll")
			}
		},
		[releaseFollow],
	)

	const handleScrollerPointerDown = useCallback(() => {
		pointerScrollingRef.current = true
	}, [])

	const handleScrollerPointerUp = useCallback(() => {
		pointerScrollingRef.current = false
	}, [])

	const handleContentLoad = useCallback(() => {
		scheduleBottomPin()
	}, [scheduleBottomPin])

	const handleScrollToBottomClick = useCallback(() => {
		if (itemCountRef.current === 0) {
			return
		}
		enterFollowMode()
	}, [enterFollowMode])

	return {
		scrollMode,
		showScrollToBottom: hasTask && itemCount > 0 && scrollMode === "BROWSING",
		handleScrollToBottomClick,
		releaseFollow,
		setScrollerRef,
		setContentRef,
		handleScrollerScroll,
		handleScrollerWheel,
		handleScrollerPointerDown,
		handleScrollerPointerUp,
		handleContentLoad,
	}
}
