/**
 * Single-owner controller for the chat transcript scroller.
 *
 * Virtuoso virtualizes and measures rows. This controller alone decides when
 * the transcript follows live output and is the only automatic path allowed to
 * issue a bottom-positioning command.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { VirtuosoHandle } from "react-virtuoso"

export const CHAT_BOTTOM_EPSILON_PX = 1
export const CHAT_BOTTOM_MAGNET_VIEWPORT_RATIO = 0.05
export const CHAT_BOTTOM_MAGNET_MIN_PX = 16
export const CHAT_BOTTOM_RELEASE_VIEWPORT_RATIO = 0.25
export const CHAT_BOTTOM_RELEASE_MIN_PX = 96

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

const magneticEntryDistance = ({ clientHeight }: ScrollGeometry): number =>
	Math.max(CHAT_BOTTOM_MAGNET_MIN_PX, clientHeight * CHAT_BOTTOM_MAGNET_VIEWPORT_RATIO)

const magneticReleaseDistance = ({ clientHeight }: ScrollGeometry): number =>
	Math.max(CHAT_BOTTOM_RELEASE_MIN_PX, clientHeight * CHAT_BOTTOM_RELEASE_VIEWPORT_RATIO)

const dimensionsChanged = (previous: ScrollGeometry, current: ScrollGeometry): boolean =>
	Math.abs(previous.clientHeight - current.clientHeight) > GEOMETRY_EPSILON_PX ||
	Math.abs(previous.scrollHeight - current.scrollHeight) > GEOMETRY_EPSILON_PX

export interface UseChatScrollControllerOptions {
	virtuosoRef: React.RefObject<VirtuosoHandle | null>
	taskTs: number | undefined
	itemCount: number
}

export interface UseChatScrollControllerReturn {
	scrollMode: ChatScrollMode
	showScrollToBottom: boolean
	handleScrollToBottomClick: () => void
	releaseFollow: (reason: ChatScrollReleaseReason) => void
	setScrollerRef: (element: HTMLElement | Window | null) => void
	handleScrollerScroll: (event: React.UIEvent<HTMLElement>) => void
	handleScrollerIdleChange: (isScrolling: boolean) => void
	handleContentHeightChange: (height: number) => void
	handleContentLoad: () => void
}

export function useChatScrollController({
	virtuosoRef,
	taskTs,
	itemCount,
}: UseChatScrollControllerOptions): UseChatScrollControllerReturn {
	const hasTask = taskTs !== undefined
	const [scrollMode, setScrollMode] = useState<ChatScrollMode>(hasTask ? "FOLLOWING" : "BROWSING")
	const scrollModeRef = useRef<ChatScrollMode>(hasTask ? "FOLLOWING" : "BROWSING")
	const taskTsRef = useRef(taskTs)
	const itemCountRef = useRef(itemCount)
	const scrollerRef = useRef<HTMLElement | null>(null)
	const previousGeometryRef = useRef<ScrollGeometry | null>(null)
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

	// This is the controller's only automatic scroll write. Every trigger is
	// coalesced through the same frame so row measurement, streaming, and layout
	// resizing cannot race separate correction mechanisms.
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
			if (scrollModeRef.current === "FOLLOWING" && taskTsRef.current !== undefined && itemCountRef.current > 0) {
				virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
			}
		})
	}, [virtuosoRef])

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
		(element: HTMLElement | Window | null) => {
			resizeObserverRef.current?.disconnect()
			resizeObserverRef.current = null

			if (!(element instanceof HTMLElement)) {
				scrollerRef.current = null
				previousGeometryRef.current = null
				return
			}

			scrollerRef.current = element
			previousGeometryRef.current = readGeometry(element)

			if (typeof ResizeObserver !== "undefined") {
				const observer = new ResizeObserver(() => {
					if (scrollModeRef.current === "FOLLOWING") {
						scheduleBottomPin()
					}
				})
				observer.observe(element)
				resizeObserverRef.current = observer
			}

			scheduleBottomPin()
		},
		[scheduleBottomPin],
	)

	useEffect(
		() => () => {
			cancelBottomPin()
			resizeObserverRef.current?.disconnect()
		},
		[cancelBottomPin],
	)

	// A new task starts attached to its live output. Message updates do not
	// change this mode; only a task switch or explicit/user geometry transition
	// does, so history browsing is never stolen by incoming output.
	useLayoutEffect(() => {
		cancelBottomPin()
		previousGeometryRef.current = scrollerRef.current ? readGeometry(scrollerRef.current) : null

		if (taskTs === undefined) {
			transitionTo("BROWSING")
			return
		}

		transitionTo("FOLLOWING")
		scheduleBottomPin()
	}, [cancelBottomPin, scheduleBottomPin, taskTs, transitionTo])

	// The first non-empty payload may arrive after the task shell mounts.
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
				const enteredMagnet =
					!layoutChanged &&
					(movedDown || remaining <= CHAT_BOTTOM_EPSILON_PX) &&
					remaining <= magneticEntryDistance(current)

				if (enteredMagnet) {
					enterFollowMode()
				}
				return
			}

			if (movedUp && !layoutChanged && remaining >= magneticReleaseDistance(current)) {
				releaseFollow("user-scroll")
				return
			}

			// A changed viewport or list height is layout work, not user intent.
			// Reconcile it immediately while follow mode owns the transcript.
			if (layoutChanged) {
				scheduleBottomPin()
			}
		},
		[enterFollowMode, releaseFollow, scheduleBottomPin],
	)

	const handleScrollerIdleChange = useCallback(
		(isScrolling: boolean) => {
			if (isScrolling || scrollModeRef.current !== "FOLLOWING") {
				return
			}

			const scroller = scrollerRef.current
			if (scroller && distanceFromBottom(readGeometry(scroller)) > CHAT_BOTTOM_EPSILON_PX) {
				scheduleBottomPin()
			}
		},
		[scheduleBottomPin],
	)

	const handleContentHeightChange = useCallback(
		(_height: number) => {
			scheduleBottomPin()
		},
		[scheduleBottomPin],
	)

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
		handleScrollerScroll,
		handleScrollerIdleChange,
		handleContentHeightChange,
		handleContentLoad,
	}
}
