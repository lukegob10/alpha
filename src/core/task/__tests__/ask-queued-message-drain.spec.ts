import { Task } from "../Task"

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	const createAskOnlyTask = async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).taskId = "task-1"
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToClineMessages = vi.fn(async () => {})
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }
		return task
	}

	it.each(["followup", "tool", "command"] as const)(
		"does not consume queued messages while blocked on %s ask",
		async (askType) => {
			const task = await createAskOnlyTask()

			const askPromise = task.ask(askType, "Q?", false)
			;(task as any).messageQueueService.addMessage("queued next turn")

			setTimeout(() => {
				;(task as any).handleWebviewAskResponse("messageResponse", "manual response")
			}, 0)

			const result = await askPromise

			expect(result.response).toBe("messageResponse")
			expect(result.text).toBe("manual response")
			expect((task as any).messageQueueService.isEmpty()).toBe(false)
			expect((task as any).messageQueueService.messages[0]?.text).toBe("queued next turn")
		},
	)

	it("consumes queued message while blocked on completion ask", async () => {
		const task = await createAskOnlyTask()

		const askPromise = task.ask("completion_result", "Done", false)

		;(task as any).messageQueueService.addMessage("picked answer")

		const result = await askPromise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("picked answer")
	})

	it("does not consume queued messages for command_output asks", async () => {
		const task = await createAskOnlyTask()

		const askPromise = task.ask("command_output", "command is still running...", false)
		;(task as any).messageQueueService.addMessage("1+1=?")

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		expect((task as any).messageQueueService.messages[0]?.text).toBe("1+1=?")
	})

	it("auto-continues command output when the task is off-screen", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("command_output", "command is still running...", false)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBeUndefined()
	})

	it("auto-feeds recovery guidance for off-screen mistake-limit asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("mistake_limit_reached", "generic guidance", false)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toContain("Continue the current task without waiting for the user")
		expect(result.text).toContain("new_task by itself")
	})

	it("keeps on-screen mistake-limit asks interactive", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const askPromise = task.ask("mistake_limit_reached", "generic guidance", false)

		setTimeout(() => {
			;(task as any).handleWebviewAskResponse("messageResponse", "manual guidance")
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("manual guidance")
	})

	it("auto-approves off-screen delegation control asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("tool", JSON.stringify({ tool: "newTask", mode: "Code" }), false)

		expect(result.response).toBe("yesButtonClicked")
	})

	it("auto-approves on-screen delegation control asks when auto-approval is enabled", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					autoApprovalEnabled: true,
					alwaysAllowSubtasks: false,
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const result = await task.ask("tool", JSON.stringify({ tool: "newTask", mode: "Architect" }), false)

		expect(result.response).toBe("yesButtonClicked")
	})

	it("does not auto-approve protected off-screen tool asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const askPromise = task.ask("tool", JSON.stringify({ tool: "writeToFile" }), false, undefined, true)

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
	})
})
