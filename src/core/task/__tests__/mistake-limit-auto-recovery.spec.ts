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
		;(task as any).providerRef = { deref: () => provider }
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
		expect(userContent).toHaveLength(1)

		const guidance = JSON.parse(userContent[0].text)
		expect(guidance.status).toBe("guidance")
		expect(guidance.feedback).toContain("Continue without waiting for user input")
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
			expect.stringContaining("Task lane: mode=code, providerProfile=5.4 nano"),
		)
		expect((task as any).consecutiveMistakeCount).toBe(0)

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
		expect(userContent).toHaveLength(1)
	})
})
