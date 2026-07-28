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

// The magnetic entry zone is relative to the visible viewport, not the full
// transcript. A document-relative percentage would grow to multiple screens in
// a long conversation and unexpectedly steal users out of history browsing.
export const CHAT_BOTTOM_MAGNET_VIEWPORT_RATIO = 0.05
export const CHAT_BOTTOM_MAGNET_MIN_PX = 16

// Once following, use a much wider release zone than the entry zone. This
// hysteresis absorbs trackpad noise and viewport-height changes while still
// allowing a deliberate scrollbar, wheel, or keyboard yank to take ownership.
export const CHAT_BOTTOM_RELEASE_VIEWPORT_RATIO = 0.25
export const CHAT_BOTTOM_RELEASE_MIN_PX = 96
export const CHAT_BOTTOM_MAGNET_SETTLE_MS = 120

// Virtuoso's autoscrollToBottom API listens for size-increase events for 100 ms.
// Coalescing calls to the same window avoids stacking multiple listeners during
// token streaming while keeping the listener armed before ResizeObserver runs.
const AUTOSCROLL_ARM_WINDOW_MS = 100

export type ScrollPhase = "ANCHORED_FOLLOWING" | "USER_BROWSING_HISTORY"

export type ScrollFollowDisengageSource = "scroll" | "row-expansion" | "task-header-toggle" | "keyboard-navigation"

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

const magneticEntryDistance = (element: HTMLElement): number =>
	Math.max(CHAT_BOTTOM_MAGNET_MIN_PX, element.clientHeight * CHAT_BOTTOM_MAGNET_VIEWPORT_RATIO)

const magneticReleaseDistance = (element: HTMLElement): number =>
	Math.max(CHAT_BOTTOM_RELEASE_MIN_PX, element.clientHeight * CHAT_BOTTOM_RELEASE_VIEWPORT_RATIO)

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
	const itemCountRef = useRef(itemCount)
	const positionedTaskRef = useRef<number | undefined>(undefined)
	const autoscrollArmTimeoutRef = useRef<number | null>(null)
	const magnetSnapTimeoutRef = useRef<number | null>(null)
	const viewportResizeFrameRef = useRef<number | null>(null)
	const scrollerLastTopRef = useRef<number | null>(null)

	itemCountRef.current = itemCount

	const transitionScrollPhase = useCallback((nextPhase: ScrollPhase) => {
		if (scrollPhaseRef.current === nextPhase) {
			return
		}
		scrollPhaseRef.current = nextPhase
		setScrollPhase(nextPhase)
	}, [])

	const clearMagnetSnap = useCallback(() => {
		if (magnetSnapTimeoutRef.current !== null) {
			window.clearTimeout(magnetSnapTimeoutRef.current)
			magnetSnapTimeoutRef.current = null
		}
	}, [])

	const clearViewportResizeCorrection = useCallback(() => {
		if (viewportResizeFrameRef.current !== null) {
			window.cancelAnimationFrame(viewportResizeFrameRef.current)
			viewportResizeFrameRef.current = null
		}
	}, [])

	const enterAnchoredFollowing = useCallback(() => {
		transitionScrollPhase("ANCHORED_FOLLOWING")
		setShowScrollToBottom(false)
	}, [transitionScrollPhase])

	const enterUserBrowsingHistory = useCallback(
		(_source: ScrollFollowDisengageSource) => {
			clearMagnetSnap()
			clearViewportResizeCorrection()
			transitionScrollPhase("USER_BROWSING_HISTORY")
			setShowScrollToBottom(true)
		},
		[clearMagnetSnap, clearViewportResizeCorrection, transitionScrollPhase],
	)

	const clearAutoscrollArm = useCallback(() => {
		if (autoscrollArmTimeoutRef.current !== null) {
			window.clearTimeout(autoscrollArmTimeoutRef.current)
			autoscrollArmTimeoutRef.current = null
		}
	}, [])

	const positionLastItem = useCallback(() => {
		virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" })
	}, [virtuosoRef])

	const scrollToPhysicalBottom = useCallback(() => {
		// scrollToIndex aligns the final row, but margins in that row can still
		// leave the native scroller several pixels above its real maximum. Use the
		// Virtuoso handle's native-coordinate command when exact bottom matters.
		virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
	}, [virtuosoRef])

	const scheduleMagnetSnap = useCallback(() => {
		clearMagnetSnap()
		magnetSnapTimeoutRef.current = window.setTimeout(() => {
			magnetSnapTimeoutRef.current = null
			if (scrollPhaseRef.current === "ANCHORED_FOLLOWING" && itemCountRef.current > 0) {
				scrollToPhysicalBottom()
			}
		}, CHAT_BOTTOM_MAGNET_SETTLE_MS)
	}, [clearMagnetSnap, scrollToPhysicalBottom])

	const scheduleViewportResizeCorrection = useCallback(() => {
		if (viewportResizeFrameRef.current !== null) {
			return
		}

		viewportResizeFrameRef.current = window.requestAnimationFrame(() => {
			viewportResizeFrameRef.current = null
			if (
				scrollPhaseRef.current === "ANCHORED_FOLLOWING" &&
				positionedTaskRef.current === taskTs &&
				itemCountRef.current > 0
			) {
				scrollToPhysicalBottom()
			}
		})
	}, [scrollToPhysicalBottom, taskTs])

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

	useEffect(
		() => () => {
			clearAutoscrollArm()
			clearMagnetSnap()
			clearViewportResizeCorrection()
		},
		[clearAutoscrollArm, clearMagnetSnap, clearViewportResizeCorrection],
	)

	// A task switch starts in follow mode. Keep this independent from item-count
	// changes so incoming messages can never re-enable following while the user
	// is browsing history.
	useLayoutEffect(() => {
		clearAutoscrollArm()
		clearMagnetSnap()
		clearViewportResizeCorrection()
		positionedTaskRef.current = undefined
		scrollerLastTopRef.current = null

		if (!taskTs) {
			transitionScrollPhase("USER_BROWSING_HISTORY")
			setShowScrollToBottom(false)
			return
		}

		enterAnchoredFollowing()
	}, [
		clearAutoscrollArm,
		clearMagnetSnap,
		clearViewportResizeCorrection,
		enterAnchoredFollowing,
		taskTs,
		transitionScrollPhase,
	])

	// Task initialization is event-driven: as soon as the first rows exist, use
	// one Virtuoso-coordinated navigation command. No retries or raw scrollTop
	// writes are allowed to race later row measurements.
	useLayoutEffect(() => {
		if (!taskTs) {
			return
		}
		if (itemCount > 0 && positionedTaskRef.current !== taskTs) {
			positionedTaskRef.current = taskTs
			positionLastItem()
		}
	}, [itemCount, positionLastItem, taskTs])

	// Bottom controls and the composer are outside the transcript, so changes to
	// their height correctly resize this viewport. Virtuoso owns row measurement,
	// but it does not consistently re-pin after a viewport-only resize. Correct
	// that geometry once on the next frame only while follow mode owns scrolling.
	useEffect(() => {
		const viewport = scrollContainerRef.current
		if (!viewport || typeof ResizeObserver === "undefined") {
			return
		}

		let previousHeight = viewport.getBoundingClientRect().height
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? viewport.getBoundingClientRect().height
			if (Math.abs(nextHeight - previousHeight) < 0.5) {
				return
			}

			previousHeight = nextHeight
			scheduleViewportResizeCorrection()
		})
		observer.observe(viewport)

		return () => observer.disconnect()
	}, [scrollContainerRef, scheduleViewportResizeCorrection])

	// React layout effects run before ResizeObserver delivery. Arming Virtuoso
	// here lets its own size-increase pipeline keep the final row pinned without
	// a second row observer or a competing content-growth correction afterward.
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
		clearMagnetSnap()
		enterAnchoredFollowing()
		scrollToPhysicalBottom()
	}, [clearMagnetSnap, enterAnchoredFollowing, scrollToPhysicalBottom])

	const followOutputCallback = useCallback((isAtBottom: boolean): "auto" | false => {
		return isAtBottom || scrollPhaseRef.current === "ANCHORED_FOLLOWING" ? "auto" : false
	}, [])

	const atBottomStateChangeCallback = useCallback(
		(isAtBottom: boolean) => {
			if (isAtBottom) {
				clearMagnetSnap()
				enterAnchoredFollowing()
			} else if (scrollPhaseRef.current === "USER_BROWSING_HISTORY") {
				setShowScrollToBottom(true)
			}
		},
		[clearMagnetSnap, enterAnchoredFollowing],
	)

	const handleScrollerScroll = useCallback(
		(event: React.UIEvent<HTMLElement>) => {
			const scroller = event.currentTarget
			const previousTop = scrollerLastTopRef.current
			const currentTop = scroller.scrollTop
			const remainingDistance = distanceFromBottom(scroller)
			scrollerLastTopRef.current = currentTop

			const reachedExactBottom = remainingDistance <= CHAT_BOTTOM_THRESHOLD_PX
			const movedAwayFromBottom = previousTop !== null && currentTop < previousTop
			const movedTowardBottom = previousTop !== null && currentTop > previousTop

			// Viewport growth can reduce scrollTop while keeping the viewport at the
			// physical bottom. Bottom distance must win over scroll direction or that
			// ordinary layout clamp is misclassified as an upward user scroll.
			if (reachedExactBottom) {
				clearMagnetSnap()
				enterAnchoredFollowing()
				return
			}

			if (scrollPhaseRef.current === "USER_BROWSING_HISTORY") {
				if (movedTowardBottom && remainingDistance <= magneticEntryDistance(scroller)) {
					enterAnchoredFollowing()
					scrollToPhysicalBottom()
					return
				}
				setShowScrollToBottom(true)
				return
			}

			if (movedAwayFromBottom) {
				if (remainingDistance >= magneticReleaseDistance(scroller)) {
					enterUserBrowsingHistory("scroll")
				} else {
					// Wait for the gesture to settle. Repeated wheel/key/drag events can
					// cross the wider release boundary; a small nudge is pulled back once.
					scheduleMagnetSnap()
				}
			}
		},
		[clearMagnetSnap, enterAnchoredFollowing, enterUserBrowsingHistory, scheduleMagnetSnap, scrollToPhysicalBottom],
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
		},
		[scrollContainerRef],
	)
	useEvent("wheel", handleWheel, window, { passive: true })

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

			// PageUp/Home are explicit large navigation commands. Arrow-key and
			// wheel nudges use the same distance hysteresis in handleScrollerScroll.
			if (keyEvent.key === "PageUp" || keyEvent.key === "Home") {
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
