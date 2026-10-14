import type { AlphaAsk, AlphaMessage } from "@alpha-code/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../../task/Task"
import type { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

describe("published ask response admission", () => {
	afterEach(() => vi.useRealTimers())

	it.each<AlphaAsk>(["followup", "completion_result", "resume_task", "resume_completed_task"])(
		"accepts a reply to %s before delayed attention status is populated",
		async (askType) => {
			vi.useFakeTimers()
			const task = Object.assign(Object.create(Task.prototype), {
				taskId: "published-ask-task",
				instanceId: "published-ask-instance",
				taskKind: "primary",
				workspacePath: "F:/roo-fork/Alpha-Code",
				abort: false,
				clineMessages: [] as AlphaMessage[],
				messageQueueService: new MessageQueueService(),
				providerRef: { deref: () => undefined },
				addToAlphaMessages: vi.fn(async (message: AlphaMessage) => task.clineMessages.push(message)),
				saveAlphaMessages: vi.fn(async () => undefined),
				updateAlphaMessage: vi.fn(async () => undefined),
				cancelAutoApprovalTimeout: vi.fn(),
				checkpointSave: vi.fn(async () => undefined),
				emit: vi.fn(),
			}) as Task
			const provider = {
				getLiveTask: vi.fn(() => task),
				canAcceptTaskInput: vi.fn(() => true),
				getState: vi.fn(async () => ({})),
				log: vi.fn(),
			} as unknown as AlphaProvider
			const pending = task.ask(askType, "Ready for a reply", false)
			void pending.catch(() => undefined)
			try {
				await vi.waitFor(() => expect(task["activeAsk"]?.type).toBe(askType))
				const publishedAsk = task.clineMessages.at(-1)!
				expect(task.taskAsk).toBeUndefined()
				await webviewMessageHandler(provider, {
					type: "askResponse",
					taskId: task.taskId,
					askMessageTs: publishedAsk.ts,
					askResponse: "messageResponse",
					text: "Continue with this answer",
					images: [],
				})
				expect(task["askResponseText"]).toBe("Continue with this answer")
				await vi.advanceTimersByTimeAsync(100)
				await expect(pending).resolves.toMatchObject({
					response: "messageResponse",
					text: "Continue with this answer",
				})
			} finally {
				task.abort = true
				await vi.advanceTimersByTimeAsync(100)
				await pending.catch(() => undefined)
			}
		},
	)
})
