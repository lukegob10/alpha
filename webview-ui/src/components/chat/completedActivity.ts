import { TaskLifecycleState, type ClineMessage, type LiveTaskMetadata } from "@alpha-code/types"

export interface CompletedActivity {
	id: number
	startIndex: number
	endIndex: number
	durationMs: number
}

const isFinalResponse = (message: ClineMessage) =>
	(message.say === "completion_result" || message.ask === "completion_result") &&
	message.partial !== true &&
	Boolean(message.text?.trim() || message.images?.length)

/**
 * Presentation only: final-response rows and the host's review boundary seal an
 * activity segment. A candidate result during verification is still live work.
 * Read the unfiltered transcript so hidden completion asks can supply the end
 * timestamp; never use a render/reload timestamp for elapsed time.
 */
export function getCompletedActivity(
	messages: ClineMessage[],
	sourceMessages: ClineMessage[],
	liveTask?: LiveTaskMetadata,
): Map<number, CompletedActivity> {
	const completed = new Map<number, number>()
	let candidate: ClineMessage | undefined
	let endedAt: number | undefined
	let hasReviewBoundary = false
	const finish = (historical: boolean) => {
		if (!candidate) return
		const hostAllowsCollapse =
			!liveTask ||
			liveTask.lifecycle === TaskLifecycleState.Completed ||
			(liveTask.lifecycle === TaskLifecycleState.Waiting &&
				(hasReviewBoundary || liveTask.waitingReason === "completion"))
		if (historical || hostAllowsCollapse) {
			completed.set(candidate.ts, endedAt ?? candidate.ts)
		}
	}
	for (const message of sourceMessages) {
		if (message.say === "user_feedback") {
			finish(true)
			candidate = undefined
			endedAt = undefined
			hasReviewBoundary = false
		} else if (isFinalResponse(message)) {
			candidate = message
			endedAt = undefined
			hasReviewBoundary = message.type === "ask"
		} else if (candidate && message.ask === "completion_result" && message.partial !== true) {
			hasReviewBoundary = true
			endedAt ??= message.ts
		} else if (candidate && message.ask === "resume_completed_task") {
			hasReviewBoundary = true
		}
	}
	finish(false)

	const activityByIndex = new Map<number, CompletedActivity>()
	let startIndex = 0
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		if (message.say === "user_feedback") {
			startIndex = index + 1
		} else if (isFinalResponse(message)) {
			const terminalAt = completed.get(message.ts)
			if (terminalAt !== undefined && index > startIndex) {
				const activity: CompletedActivity = {
					id: message.ts,
					startIndex,
					endIndex: index - 1,
					durationMs: Math.max(0, terminalAt - messages[startIndex].ts),
				}
				for (let row = startIndex; row < index; row++) activityByIndex.set(row, activity)
			}
			if (terminalAt !== undefined) startIndex = index + 1
		}
	}
	return activityByIndex
}
