import { describe, expect, it, vi } from "vitest"

import { Task } from "../Task"

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
		},
	},
}))

describe("Task mistake-limit recovery", () => {
	const createTask = (provider: any) => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).taskId = "task-1"
		;(task as any).instanceId = "instance-1"
		;(task as any)._taskMode = "code"
		;(task as any)._taskApiConfigName = "5.4 nano"
		;(task as any).apiConfiguration = {
			apiProvider: "openai-native",
			openAiModelId: "gpt-5.4-nano",
		}
		;(task as any).consecutiveMistakeCount = 5
		;(task as any).consecutiveMistakeLimit = 3
		;(task as any).consecutiveNoToolUseCount = 2
		;(task as any).consecutiveNoAssistantMessagesCount = 0
		;(task as any).automaticMistakeRecoveryCount = 0
		;(task as any).lastToolFailure = {
			toolName: "attempt_completion",
			error: "Completion is still blocked by pending verification.",
		}
		;(task as any).providerRef = { deref: () => provider }
		;(task as any).messageQueueService = {
			isEmpty: vi.fn(() => true),
			dequeueMessage: vi.fn(() => undefined),
		}
		;(task as any).say = vi.fn(async () => {})
		;(task as any).ask = vi.fn()
		return task
	}

	it("auto-recovers on-screen mistake-limit asks when auto-approval is enabled", async () => {
		const provider = {
			isTaskOnScreen: vi.fn(() => true),
			getState: vi.fn(async () => ({ autoApprovalEnabled: true })),
		}
		const task = createTask(provider)
		const userContent: any[] = []

		await (task as any).handleConsecutiveMistakeLimit(userContent)

		expect((task as any).ask).not.toHaveBeenCalled()
		expect((task as any).say).toHaveBeenCalledWith("user_feedback", expect.stringContaining("Automatic recovery"))
		expect((task as any).consecutiveMistakeCount).toBe(0)
		expect((task as any).consecutiveNoToolUseCount).toBe(0)
		expect((task as any).consecutiveNoAssistantMessagesCount).toBe(0)
		expect((task as any).automaticMistakeRecoveryCount).toBe(1)
		expect(userContent).toHaveLength(1)

		const guidance = JSON.parse(userContent[0].text)
		expect(guidance.status).toBe("guidance")
		expect(guidance.feedback).toContain("Continue without waiting for user input")
		expect(guidance.feedback).toContain("Recovery attempt: 1/1")
		expect(guidance.feedback).toContain(
			"Most recent tool failure: attempt_completion — Completion is still blocked by pending verification.",
		)
		expect(guidance.feedback).toContain("The previous completion call failed. Do not repeat it unchanged")
		expect(guidance.feedback).toContain(
			"More reads, searches, todo updates, or status narration do not apply the change",
		)
		expect(guidance.feedback).toContain("new_task by itself")
	})

	it("keeps mistake-limit asks interactive when on-screen auto-approval is disabled", async () => {
		const provider = {
			isTaskOnScreen: vi.fn(() => true),
			getState: vi.fn(async () => ({ autoApprovalEnabled: false })),
		}
		const task = createTask(provider)
		;(task as any).ask = vi.fn(async () => ({
			response: "messageResponse",
			text: "manual recovery guidance",
			images: undefined,
		}))
		const userContent: any[] = []

		await (task as any).handleConsecutiveMistakeLimit(userContent)

		expect((task as any).ask).toHaveBeenCalledWith(
			"mistake_limit_reached",
			expect.stringContaining(
				"Most recent tool failure: attempt_completion — Completion is still blocked by pending verification.",
			),
			undefined,
			undefined,
			true,
		)
		expect((task as any).consecutiveMistakeCount).toBe(0)
		expect((task as any).consecutiveNoToolUseCount).toBe(0)
		expect((task as any).consecutiveNoAssistantMessagesCount).toBe(0)
		expect((task as any).automaticMistakeRecoveryCount).toBe(0)

		const guidance = JSON.parse(userContent[0].text)
		expect(guidance.feedback).toBe("manual recovery guidance")
	})

	it("auto-recovers off-screen without consulting auto-approval state", async () => {
		const provider = {
			isTaskOnScreen: vi.fn(() => false),
			getState: vi.fn(async () => ({ autoApprovalEnabled: false })),
		}
		const task = createTask(provider)
		const userContent: any[] = []

		await (task as any).handleConsecutiveMistakeLimit(userContent)

		expect(provider.getState).not.toHaveBeenCalled()
		expect((task as any).ask).not.toHaveBeenCalled()
		expect((task as any).automaticMistakeRecoveryCount).toBe(1)
		expect(userContent).toHaveLength(1)
	})

	it("keeps the one-recovery budget exhausted until protected human guidance arrives", async () => {
		const provider = {
			isTaskOnScreen: vi.fn(() => false),
			getState: vi.fn(async () => ({ autoApprovalEnabled: true })),
		}
		const task = createTask(provider)
		;(task as any).automaticMistakeRecoveryCount = 1
		;(task as any).ask = vi.fn(async () => ({
			response: "messageResponse",
			text: "human recovery guidance",
			images: undefined,
		}))
		const userContent: any[] = []

		await (task as any).handleConsecutiveMistakeLimit(userContent)

		expect(provider.isTaskOnScreen).not.toHaveBeenCalled()
		expect(provider.getState).not.toHaveBeenCalled()
		expect((task as any).ask).toHaveBeenCalledWith(
			"mistake_limit_reached",
			expect.stringContaining("Recent provider responses without tool use: 2"),
			undefined,
			undefined,
			true,
		)
		expect((task as any).automaticMistakeRecoveryCount).toBe(0)
		expect(userContent).toHaveLength(1)
		expect(JSON.parse(userContent[0].text).feedback).toBe("human recovery guidance")
	})
})
