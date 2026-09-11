import { TaskLifecycleState, TaskStatus, type ClineMessage, type LiveTaskMetadata } from "@alpha-code/types"

import { getCompletedActivity } from "../completedActivity"

const activity: ClineMessage[] = [
	{ ts: 1000, type: "say", say: "api_req_started", text: "{}" },
	{ ts: 2000, type: "say", say: "reasoning", text: "Inspect the code" },
	{ ts: 3000, type: "ask", ask: "command", text: "pnpm test" },
	{ ts: 4000, type: "say", say: "completion_result", text: "Tests passed", partial: false },
]
const review: ClineMessage = { ts: 6500, type: "ask", ask: "completion_result", text: "", partial: false }
const liveTask = (lifecycle: TaskLifecycleState, waitingReason?: string): LiveTaskMetadata => ({
	id: "task",
	status: TaskStatus.Idle,
	lifecycle,
	isActive: true,
	isStreaming: false,
	isWaitingForInput: lifecycle === TaskLifecycleState.Waiting,
	waitingReason,
	lastUpdatedAt: 999_999,
	queueCount: 0,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
})

describe("completed activity projection", () => {
	it("folds activity above the final answer using the hidden review timestamp", () => {
		const result = getCompletedActivity(
			activity,
			[...activity, review],
			liveTask(TaskLifecycleState.Waiting, "completion"),
		)
		expect([...result.keys()]).toEqual([0, 1, 2])
		expect(result.get(0)).toEqual({ id: 4000, startIndex: 0, endIndex: 2, durationMs: 5500 })
		expect(result.get(3)).toBeUndefined()
	})

	it("keeps candidate completions visible during verification, failure, and cancellation", () => {
		for (const state of [TaskLifecycleState.Running, TaskLifecycleState.Failed, TaskLifecycleState.Closed]) {
			expect(getCompletedActivity(activity, [...activity, review], liveTask(state)).size).toBe(0)
		}
	})

	it("keeps streaming answers, approvals, errors, and questions visible", () => {
		for (const last of [
			{ ...activity[3], partial: true },
			{ ts: 4000, type: "ask", ask: "followup", text: "Which file?" },
			{ ts: 4000, type: "say", say: "error", text: "Command failed" },
		] satisfies ClineMessage[]) {
			const messages = [...activity.slice(0, 3), last]
			expect(getCompletedActivity(messages, messages).size).toBe(0)
		}
	})

	it("reconstructs saved history without counting time spent away from the task", () => {
		const source: ClineMessage[] = [...activity, review, { ts: 999_999, type: "ask", ask: "resume_completed_task" }]
		expect(getCompletedActivity(activity, source).get(0)?.durationMs).toBe(5500)
		expect(getCompletedActivity(activity, activity).get(0)?.durationMs).toBe(3000)
	})

	it("keeps previous turns collapsed while a follow-up runs and never hides user messages", () => {
		const messages: ClineMessage[] = [
			...activity,
			{ ts: 9000, type: "say", say: "user_feedback", text: "Now add a test" },
			{ ts: 10000, type: "say", say: "text", text: "Adding the test" },
		]
		const result = getCompletedActivity(
			messages,
			[...activity, review, ...messages.slice(4)],
			liveTask(TaskLifecycleState.Running),
		)
		expect([...result.keys()]).toEqual([0, 1, 2])
	})

	it("gives each completed response its own trace and keeps plain answers uncluttered", () => {
		const messages: ClineMessage[] = [
			...activity,
			{ ts: 9000, type: "say", say: "user_feedback", text: "Next" },
			...activity.map((message) => ({ ...message, ts: message.ts + 10000 })),
		]
		const result = getCompletedActivity(messages, messages)
		expect(result.get(0)?.id).toBe(4000)
		expect(result.get(5)?.id).toBe(14000)
		expect(result.has(4)).toBe(false)
		expect(getCompletedActivity([activity[3]], [activity[3]]).size).toBe(0)
	})

	it("does not alter transcript objects and handles a retracted completion", () => {
		const messages = activity.map((message) => Object.freeze({ ...message }))
		getCompletedActivity(messages, messages)
		expect(messages).toEqual(activity)
		const retracted: ClineMessage[] = [...activity.slice(0, 3), { ...activity[3], say: "text" }]
		expect(getCompletedActivity(retracted, retracted).size).toBe(0)
	})
})
