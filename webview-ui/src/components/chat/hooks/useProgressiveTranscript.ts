import { useCallback, useEffect, useMemo, useState } from "react"

export const INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT = 80
export const CHAT_TRANSCRIPT_RENDER_BATCH_SIZE = 100

interface TranscriptWindow {
	taskKey: string | undefined
	startIndex: number
}

interface ProgressiveTranscript<T> {
	items: T[]
	startIndex: number
	revealIndex: (index: number) => void
}

type IdleWindow = Window & {
	requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
	cancelIdleCallback?: (handle: number) => void
}

/**
 * Mounts the newest transcript rows first, then prepends older rows in idle
 * batches. Every row is eventually mounted, preserving native scroll geometry
 * and browser find behavior without making task selection wait for the entire
 * transcript tree.
 */
export function useProgressiveTranscript<T>(
	items: T[],
	taskKey: string | undefined,
	loadOlderRows: boolean,
): ProgressiveTranscript<T> {
	const initialStartIndex = Math.max(0, items.length - INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT)
	const [renderWindow, setRenderWindow] = useState<TranscriptWindow>({
		taskKey,
		startIndex: initialStartIndex,
	})
	const startIndex =
		renderWindow.taskKey === taskKey ? Math.min(renderWindow.startIndex, initialStartIndex) : initialStartIndex

	useEffect(() => {
		if (!loadOlderRows || !taskKey || startIndex === 0) {
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
					current.taskKey === taskKey ? Math.min(current.startIndex, initialStartIndex) : initialStartIndex
				return {
					taskKey,
					startIndex: Math.max(0, currentStartIndex - CHAT_TRANSCRIPT_RENDER_BATCH_SIZE),
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
	}, [initialStartIndex, loadOlderRows, startIndex, taskKey])

	const revealIndex = useCallback(
		(index: number) => {
			if (!taskKey || index < 0 || index >= items.length) {
				return
			}

			setRenderWindow((current) => {
				const currentStartIndex =
					current.taskKey === taskKey ? Math.min(current.startIndex, initialStartIndex) : initialStartIndex
				if (index >= currentStartIndex) {
					return current
				}
				return { taskKey, startIndex: index }
			})
		},
		[initialStartIndex, items.length, taskKey],
	)

	const renderedItems = useMemo(() => items.slice(startIndex), [items, startIndex])

	return { items: renderedItems, startIndex, revealIndex }
}
