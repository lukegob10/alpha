import { useCallback, useEffect, useRef, useState } from "react"

import { vscode } from "@/utils/vscode"

export const TASK_OPENING_FEEDBACK_TIMEOUT_MS = 30_000

/**
 * Provides immediate selection feedback while the extension restores a task.
 * Success unmounts the history row; the timeout is a failure escape because the
 * current host message has no response event.
 */
export function useTaskOpeningFeedback(taskId: string) {
	const [isOpening, setIsOpening] = useState(false)
	const isOpeningRef = useRef(false)
	const resetTimeoutRef = useRef<number | undefined>(undefined)

	useEffect(
		() => () => {
			if (resetTimeoutRef.current !== undefined) {
				window.clearTimeout(resetTimeoutRef.current)
			}
		},
		[],
	)

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
