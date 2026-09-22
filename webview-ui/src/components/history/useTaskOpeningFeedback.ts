import { useCallback, useEffect, useRef, useState } from "react"

import type { ExtensionMessage } from "@alpha-code/types"

import { vscode } from "@/utils/vscode"

export const TASK_OPENING_FEEDBACK_TIMEOUT_MS = 30_000

/**
 * Provides immediate selection feedback while the extension restores a task.
 * The host acknowledges with taskOpenResult; the timeout is only a failure escape.
 */
export function useTaskOpeningFeedback(taskId: string) {
	const [isOpening, setIsOpening] = useState(false)
	const isOpeningRef = useRef(false)
	const resetTimeoutRef = useRef<number | undefined>(undefined)

	const clearOpening = useCallback(() => {
		if (resetTimeoutRef.current !== undefined) {
			window.clearTimeout(resetTimeoutRef.current)
			resetTimeoutRef.current = undefined
		}
		isOpeningRef.current = false
		setIsOpening(false)
	}, [])

	useEffect(
		() => () => {
			if (resetTimeoutRef.current !== undefined) {
				window.clearTimeout(resetTimeoutRef.current)
			}
		},
		[],
	)

	useEffect(() => {
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message?.type !== "taskOpenResult" || message.taskId !== taskId) {
				return
			}
			clearOpening()
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [clearOpening, taskId])

	const openTask = useCallback(() => {
		if (isOpeningRef.current) {
			return
		}

		isOpeningRef.current = true
		setIsOpening(true)
		vscode.postMessage({ type: "showTaskWithId", text: taskId })
		resetTimeoutRef.current = window.setTimeout(() => {
			resetTimeoutRef.current = undefined
			isOpeningRef.current = false
			setIsOpening(false)
		}, TASK_OPENING_FEEDBACK_TIMEOUT_MS)
	}, [taskId])

	return { isOpening, openTask }
}
