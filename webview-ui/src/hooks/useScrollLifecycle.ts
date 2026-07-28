/**
 * Chat scroll ownership.
 *
 * Virtuoso is the only code allowed to measure rows or follow content growth.
 * The application owns only the user-facing mode switch between following the
 * live output and browsing history, plus explicit navigation commands.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useEvent } from "react-use"
import type { VirtuosoHandle } from "react-virtuoso"

// Keep Virtuoso's own bottom calculation exact so existing-row growth is
// reported immediately instead of accumulating into a visible jump.
export const CHAT_BOTTOM_THRESHOLD_PX = 4

// Re-engage follow mode a little before the exact endpoint. This is deliberately
// separate from Virtuoso's measurement threshold: it makes reaching the bottom
// easy without allowing near-bottom row growth to move a browsing viewport.
export const CHAT_FOLLOW_RESUME_DISTANCE_PX = 48

// Virtuoso's autoscrollToBottom API listens for size-increase events for 100 ms.
// Coalescing calls to the same window avoids stacking multiple listeners during
// token streaming while keeping the listener armed before ResizeObserver runs.
const AUTOSCROLL_ARM_WINDOW_MS = 100

export type ScrollPhase = "ANCHORED_FOLLOWING" | "USER_BROWSING_HISTORY"

export type ScrollFollowDisengageSource =
	| "wheel"
	| "row-expansion"
	| "task-header-toggle"
	| "keyboard-navigation"
	| "pointer-scroll"

const isEditableKeyboardTarget = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) {
		return false
	}
	if (target.isContentEditable) {
		return true
	}
	const tagName = target.tagName
	return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT"
}

const distanceFromBottom = (element: HTMLElement): number =>
	Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)

export interface UseScrollLifecycleOptions {
	virtuosoRef: React.RefObject<VirtuosoHandle | null>
	scrollContainerRef: React.RefObject<HTMLDivElement | null>
	taskTs: number | undefined
	isHidden: boolean
	hasTask: boolean
	itemCount: number
	/** Identity changes whenever the rendered final message content changes. */
	bottomContentRevision: unknown
}

export interface UseScrollLifecycleReturn {
	scrollPhase: ScrollPhase
	showScrollToBottom: boolean
	handleScrollToBottomClick: () => void
	enterUserBrowsingHistory: (source: ScrollFollowDisengageSource) => void
	followOutputCallback: (isAtBottom: boolean) => "auto" | false
	atBottomStateChangeCallback: (isAtBottom: boolean) => void
	handleScrollerScroll: (event: React.UIEvent<HTMLElement>) => void
	handleContentLoad: () => void
}

export function useScrollLifecycle({
	virtuosoRef,
	scrollContainerRef,
	taskTs,
	isHidden,
	hasTask,
	itemCount,
	bottomContentRevision,
}: UseScrollLifecycleOptions): UseScrollLifecycleReturn {
	const [scrollPhase, setScrollPhase] = useState<ScrollPhase>("USER_BROWSING_HISTORY")
	const scrollPhaseRef = useRef<ScrollPhase>("USER_BROWSING_HISTORY")
	const [showScrollToBottom, setShowScrollToBottom] = useState(false)
	const isAtBottomRef = useRef(false)
	const itemCountRef = useRef(itemCount)
	const positionedTaskRef = useRef<number | undefined>(undefined)
	const autoscrollArmTimeoutRef = useRef<number | null>(null)
	const scrollerLastTopRef = useRef<number | null>(null)

	itemCountRef.current = itemCount

	const transitionScrollPhase = useCallback((nextPhase: ScrollPhase) => {
		if (scrollPhaseRef.current === nextPhase) {
			return
		}
		scrollPhaseRef.current = nextPhase
		setScrollPhase(nextPhase)
	}, [])

	const enterAnchoredFollowing = useCallback(() => {
		transitionScrollPhase("ANCHORED_FOLLOWING")
		setShowScrollToBottom(false)
	}, [transitionScrollPhase])

	const enterUserBrowsingHistory = useCallback(
		(_source: ScrollFollowDisengageSource) => {
			transitionScrollPhase("USER_BROWSING_HISTORY")
			setShowScrollToBottom(true)
		},
		[transitionScrollPhase],
	)

	const clearAutoscrollArm = useCallback(() => {
		if (autoscrollArmTimeoutRef.current !== null) {
			window.clearTimeout(autoscrollArmTimeoutRef.current)
			autoscrollArmTimeoutRef.current = null
		}
	}, [])

	const armBottomFollowing = useCallback(() => {
		if (
			scrollPhaseRef.current !== "ANCHORED_FOLLOWING" ||
			itemCountRef.current === 0 ||
			autoscrollArmTimeoutRef.current !== null
		) {
			return
		}

		virtuosoRef.current?.autoscrollToBottom()
		autoscrollArmTimeoutRef.current = window.setTimeout(() => {
			autoscrollArmTimeoutRef.current = null
		}, AUTOSCROLL_ARM_WINDOW_MS)
	}, [virtuosoRef])

	useEffect(() => clearAutoscrollArm, [clearAutoscrollArm])

	// A task switch starts in follow mode. Keep this independent from item-count
	// changes so incoming messages can never re-enable following while the user
	// is browsing history.
	useLayoutEffect(() => {
		isAtBottomRef.current = false
		clearAutoscrollArm()
		positionedTaskRef.current = undefined
		scrollerLastTopRef.current = null

		if (!taskTs) {
			transitionScrollPhase("USER_BROWSING_HISTORY")
			setShowScrollToBottom(false)
			return
		}

		enterAnchoredFollowing()
	}, [clearAutoscrollArm, enterAnchoredFollowing, taskTs, transitionScrollPhase])

	// Task initialization is event-driven: as soon as the first rows exist, use
	// one Virtuoso-coordinated navigation command. No retries or raw scrollTop
	// writes are allowed to race later row measurements.
	useLayoutEffect(() => {
		if (!taskTs) {
			return
		}
		if (itemCount > 0 && positionedTaskRef.current !== taskTs) {
			positionedTaskRef.current = taskTs
			virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" })
		}
	}, [itemCount, taskTs, virtuosoRef])

	// React layout effects run before ResizeObserver delivery. Arming Virtuoso
	// here lets its own size-increase pipeline keep the final row pinned without
	// a second observer or an application scroll command fighting it afterward.
	useLayoutEffect(() => {
		armBottomFollowing()
	}, [armBottomFollowing, bottomContentRevision, itemCount])

	const handleContentLoad = useCallback(() => {
		// Image/iframe load events can change row height without changing the
		// message object. Capture them before the subsequent size measurement.
		armBottomFollowing()
	}, [armBottomFollowing])

	const handleScrollToBottomClick = useCallback(() => {
		if (itemCountRef.current === 0) {
			return
		}
		enterAnchoredFollowing()
		virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" })
	}, [enterAnchoredFollowing, virtuosoRef])

	const followOutputCallback = useCallback((isAtBottom: boolean): "auto" | false => {
		return isAtBottom || scrollPhaseRef.current === "ANCHORED_FOLLOWING" ? "auto" : false
	}, [])

	const atBottomStateChangeCallback = useCallback(
		(isAtBottom: boolean) => {
			isAtBottomRef.current = isAtBottom
			if (isAtBottom) {
				enterAnchoredFollowing()
			} else if (scrollPhaseRef.current === "USER_BROWSING_HISTORY") {
				setShowScrollToBottom(true)
			}
		},
		[enterAnchoredFollowing],
	)

	const handleScrollerScroll = useCallback(
		(event: React.UIEvent<HTMLElement>) => {
			const scroller = event.currentTarget
			const previousTop = scrollerLastTopRef.current
			const currentTop = scroller.scrollTop
			const remainingDistance = distanceFromBottom(scroller)
			scrollerLastTopRef.current = currentTop

			const reachedExactBottom = remainingDistance <= CHAT_BOTTOM_THRESHOLD_PX
			const movedTowardBottom = previousTop !== null && currentTop > previousTop
			if (reachedExactBottom || (movedTowardBottom && remainingDistance <= CHAT_FOLLOW_RESUME_DISTANCE_PX)) {
				isAtBottomRef.current = true
				enterAnchoredFollowing()
			} else if (scrollPhaseRef.current === "USER_BROWSING_HISTORY") {
				setShowScrollToBottom(true)
			}
		},
		[enterAnchoredFollowing],
	)

	const handleWheel = useCallback(
		(event: Event) => {
			const wheelEvent = event as WheelEvent
			if (!scrollContainerRef.current?.contains(wheelEvent.target as Node) || wheelEvent.deltaY === 0) {
				return
			}
			const eventTarget = wheelEvent.target
			if (eventTarget instanceof HTMLElement) {
				const scroller = eventTarget.closest(".scrollable") as HTMLElement | null
				if (scroller) {
					scrollerLastTopRef.current = scroller.scrollTop
				}
			}

			// Upward wheel input always takes ownership. Downward input also takes
			// ownership if measurement drift has left the viewport away from bottom.
			if (wheelEvent.deltaY < 0 || !isAtBottomRef.current) {
				enterUserBrowsingHistory("wheel")
			}
		},
		[enterUserBrowsingHistory, scrollContainerRef],
	)
	useEvent("wheel", handleWheel, window, { passive: true })

	const pointerScrollActiveRef = useRef(false)
	const pointerScrollElementRef = useRef<HTMLElement | null>(null)
	const pointerScrollLastTopRef = useRef<number | null>(null)

	const handlePointerDown = useCallback(
		(event: Event) => {
			const pointerTarget = (event as PointerEvent).target
			if (!(pointerTarget instanceof HTMLElement) || !scrollContainerRef.current?.contains(pointerTarget)) {
				pointerScrollActiveRef.current = false
				pointerScrollElementRef.current = null
				pointerScrollLastTopRef.current = null
				return
			}

			const scroller = pointerTarget.closest(".scrollable") as HTMLElement | null
			pointerScrollActiveRef.current = scroller !== null
			pointerScrollElementRef.current = scroller
			pointerScrollLastTopRef.current = scroller?.scrollTop ?? null
			scrollerLastTopRef.current = scroller?.scrollTop ?? null
		},
		[scrollContainerRef],
	)

	const handlePointerEnd = useCallback(() => {
		pointerScrollActiveRef.current = false
		pointerScrollElementRef.current = null
		pointerScrollLastTopRef.current = null
	}, [])

	const handlePointerActiveScroll = useCallback(
		(event: Event) => {
			if (!pointerScrollActiveRef.current) {
				return
			}
			const scrollTarget = event.target
			if (!(scrollTarget instanceof HTMLElement) || pointerScrollElementRef.current !== scrollTarget) {
				return
			}

			const previousTop = pointerScrollLastTopRef.current
			pointerScrollLastTopRef.current = scrollTarget.scrollTop
			if (previousTop === null || previousTop === scrollTarget.scrollTop) {
				return
			}

			const movedTowardBottom = scrollTarget.scrollTop > previousTop
			if (movedTowardBottom && distanceFromBottom(scrollTarget) <= CHAT_FOLLOW_RESUME_DISTANCE_PX) {
				isAtBottomRef.current = true
				enterAnchoredFollowing()
			} else {
				enterUserBrowsingHistory("pointer-scroll")
			}
		},
		[enterAnchoredFollowing, enterUserBrowsingHistory],
	)

	useEvent("pointerdown", handlePointerDown, window, { passive: true })
	useEvent("pointerup", handlePointerEnd, window, { passive: true })
	useEvent("pointercancel", handlePointerEnd, window, { passive: true })
	useEvent("scroll", handlePointerActiveScroll, window, { passive: true, capture: true })

	const handleScrollKeyDown = useCallback(
		(event: Event) => {
			const keyEvent = event as KeyboardEvent
			if (!hasTask || isHidden || keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey) {
				return
			}

			const upwardKey = keyEvent.key === "PageUp" || keyEvent.key === "Home" || keyEvent.key === "ArrowUp"
			const downwardKey =
				keyEvent.key === "PageDown" ||
				keyEvent.key === "End" ||
				keyEvent.key === "ArrowDown" ||
				keyEvent.key === " "
			if ((!upwardKey && !downwardKey) || isEditableKeyboardTarget(keyEvent.target)) {
				return
			}

			const activeElement = document.activeElement
			const focusInsideChat =
				activeElement instanceof HTMLElement && !!scrollContainerRef.current?.contains(activeElement)
			const eventTargetInsideChat =
				keyEvent.target instanceof Node && !!scrollContainerRef.current?.contains(keyEvent.target)
			if (!(focusInsideChat || eventTargetInsideChat || activeElement === document.body)) {
				return
			}
			const scroller = scrollContainerRef.current?.querySelector<HTMLElement>(".scrollable")
			if (scroller) {
				scrollerLastTopRef.current = scroller.scrollTop
			}

			if (upwardKey || !isAtBottomRef.current) {
				enterUserBrowsingHistory("keyboard-navigation")
			}
		},
		[enterUserBrowsingHistory, hasTask, isHidden, scrollContainerRef],
	)
	useEvent("keydown", handleScrollKeyDown, window)

	return {
		scrollPhase,
		showScrollToBottom,
		handleScrollToBottomClick,
		enterUserBrowsingHistory,
		followOutputCallback,
		atBottomStateChangeCallback,
		handleScrollerScroll,
		handleContentLoad,
	}
}
