import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

export const INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT = 80
export const CHAT_TRANSCRIPT_RENDER_BATCH_SIZE = 100

interface TranscriptWindow {
	taskKey: string | undefined
	/** An omitted start follows the latest rows; a number anchors browsing. */
	startIndex?: number
	wasFollowing: boolean
}

type IdleWindow = Window & {
	requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
	cancelIdleCallback?: (handle: number) => void
}

interface ProgressiveTranscript<T> {
	items: T[]
	startIndex: number
	hasOlder: boolean
	loadOlder: () => void
	revealIndex: (index: number) => void
}

/**
 * Mounts the newest transcript rows first. Older rows stay reachable through
 * Load older / Load all and through revealIndex (checkpoints). Auto-prepending
 * every historical row made long tasks pay full DOM cost after first paint.
 * Follow mode keeps that bound during live appends; browsing retains its first row.
 */
export function useProgressiveTranscript<T>(
	items: T[],
	taskKey: string | undefined,
	autoLoadOlder = false,
	followLatest = true,
): ProgressiveTranscript<T> {
	const initialStartIndex = Math.max(0, items.length - INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT)
	const [renderWindow, setRenderWindow] = useState<TranscriptWindow>({
		taskKey,
		startIndex: autoLoadOlder || !followLatest ? initialStartIndex : undefined,
		wasFollowing: followLatest,
	})
	const committedWindow = useRef({ taskKey, startIndex: initialStartIndex })
	let currentWindow = renderWindow
	if (renderWindow.taskKey !== taskKey) {
		currentWindow = {
			taskKey,
			startIndex: autoLoadOlder || !followLatest ? initialStartIndex : undefined,
			wasFollowing: followLatest,
		}
	} else if (
		renderWindow.wasFollowing !== followLatest ||
		(renderWindow.startIndex !== undefined && renderWindow.startIndex > initialStartIndex)
	) {
		const browsingStartIndex =
			renderWindow.startIndex ??
			(committedWindow.current.taskKey === taskKey ? committedWindow.current.startIndex : initialStartIndex)
		currentWindow = {
			...renderWindow,
			startIndex:
				followLatest && !renderWindow.wasFollowing && !autoLoadOlder
					? undefined
					: Math.min(browsingStartIndex, initialStartIndex),
			wasFollowing: followLatest,
		}
	}
	if (currentWindow !== renderWindow) {
		// Capture browsing/reattachment before rendering rows; following appends need no state update.
		setRenderWindow(currentWindow)
	}
	const startIndex = Math.min(currentWindow.startIndex ?? initialStartIndex, initialStartIndex)
	useLayoutEffect(() => {
		// A wheel gesture and a transcript append can arrive in one render; retain the row the reader actually saw.
		committedWindow.current = { taskKey, startIndex }
	}, [startIndex, taskKey])

	useEffect(() => {
		if (!autoLoadOlder || !taskKey || startIndex === 0) {
			return
		}

		let cancelled = false
		const idleWindow = window as IdleWindow
		const loadNextBatch = () => {
			if (cancelled) {
				return
			}

			setRenderWindow((current) => {
				const currentStartIndex =
					current.taskKey === taskKey
						? Math.min(current.startIndex ?? initialStartIndex, initialStartIndex)
						: initialStartIndex
				return {
					taskKey,
					startIndex: Math.max(0, currentStartIndex - CHAT_TRANSCRIPT_RENDER_BATCH_SIZE),
					wasFollowing: current.wasFollowing,
				}
			})
		}

		let idleHandle: number | undefined
		let timeoutHandle: number | undefined
		if (idleWindow.requestIdleCallback) {
			idleHandle = idleWindow.requestIdleCallback(loadNextBatch, { timeout: 100 })
		} else {
			timeoutHandle = window.setTimeout(loadNextBatch, 16)
		}

		return () => {
			cancelled = true
			if (idleHandle !== undefined) {
				idleWindow.cancelIdleCallback?.(idleHandle)
			}
			if (timeoutHandle !== undefined) {
				window.clearTimeout(timeoutHandle)
			}
		}
	}, [autoLoadOlder, initialStartIndex, startIndex, taskKey])

	const revealIndex = useCallback(
		(index: number) => {
			if (!taskKey || index < 0 || index >= items.length) {
				return
			}

			setRenderWindow((current) => {
				const currentStartIndex =
					current.taskKey === taskKey
						? Math.min(current.startIndex ?? initialStartIndex, initialStartIndex)
						: initialStartIndex
				if (index >= currentStartIndex) {
					return current
				}
				return { taskKey, startIndex: index, wasFollowing: current.wasFollowing }
			})
		},
		[initialStartIndex, items.length, taskKey],
	)

	const loadOlder = useCallback(() => {
		if (!taskKey || startIndex === 0) {
			return
		}

		setRenderWindow((current) => {
			const currentStartIndex =
				current.taskKey === taskKey
					? Math.min(current.startIndex ?? initialStartIndex, initialStartIndex)
					: initialStartIndex
			if (currentStartIndex === 0) {
				return current
			}
			return {
				taskKey,
				startIndex: Math.max(0, currentStartIndex - CHAT_TRANSCRIPT_RENDER_BATCH_SIZE),
				wasFollowing: current.wasFollowing,
			}
		})
	}, [initialStartIndex, startIndex, taskKey])

	const renderedItems = useMemo(() => items.slice(startIndex), [items, startIndex])

	return { items: renderedItems, startIndex, hasOlder: startIndex > 0, loadOlder, revealIndex }
}
