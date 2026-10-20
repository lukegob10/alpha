import { afterEach, describe, expect, it, vi } from "vitest"

import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"
import { Task } from "../../task/Task"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type TranscriptWriter = { addToAlphaMessages: Task["addToAlphaMessages"] }

let harness: Harness | undefined

afterEach(async () => {
	try {
		await harness?.cleanup()
	} finally {
		harness = undefined
		vi.restoreAllMocks()
	}
})

describe("AlphaProvider Stop with pending human input", () => {
	it.each(["submit", "queue"] as const)(
		"preserves pre-Stop input until a fresh human %s admission resumes the chat",
		async (admission) => {
			harness = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
			const original = harness.root
			const originalTurn = harness.queueTurn(original.taskId, "Original request")
			original.start()
			await originalTurn.entered
			await original.submitUserMessage(
				"Keep this guidance for later",
				[],
				undefined,
				undefined,
				undefined,
				"before-stop",
			)
			expect(original.messageQueueService.messages).toMatchObject([{ id: "before-stop" }])

			const restoredResume = deferred<Task>()
			const transcript = Task.prototype as unknown as TranscriptWriter
			const appendMessage = transcript.addToAlphaMessages
			vi.spyOn(transcript, "addToAlphaMessages").mockImplementation(async function (this: Task, ...args) {
				const result = await appendMessage.apply(this, args)
				if (this !== original && args[0].ask === "resume_task") restoredResume.resolve(this)
				return result
			})
			const nextTurn = harness.queueTurn(original.taskId, "Explicitly resumed request")
			await harness.provider.cancelTask(original.taskId, "webview_stop")
			const restored = await restoredResume.promise
			// Ask's first queue-selection predicate runs after its publication resolves.
			// A check-phase checkpoint drains those microtasks without an arbitrary delay.
			await new Promise<void>((resolve) => setImmediate(resolve))

			expect(harness.provider.getLiveTask(original.taskId)).toBe(restored)
			expect(restored.getActiveAskTimestamp()).toEqual(expect.any(Number))
			expect(restored.messageQueueService.getClaimedMessageIds()).toEqual([])
			expect(restored.queuedMessages).toMatchObject([{ id: "before-stop", text: "Keep this guidance for later" }])
			expect(nextTurn.request).toBeUndefined()

			// Retrying an old admission and receiving agent guidance cannot undo Stop.
			await restored.submitUserMessage(
				"Keep this guidance for later",
				[],
				undefined,
				undefined,
				undefined,
				"before-stop",
			)
			await expect(
				restored.steerAgentMessage({
					id: "agent-update",
					senderTaskId: "peer-agent",
					text: "Worker report is ready",
				}),
			).resolves.toBe("buffered")
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(restored.getActiveAskTimestamp()).toEqual(expect.any(Number))
			expect(restored.messageQueueService.getClaimedMessageIds()).toEqual([])
			expect(nextTurn.request).toBeUndefined()
			await harness.provider.queueMessageForTaskDurably(
				restored.taskId,
				"Passive retained guidance",
				[],
				"passive-after-stop",
			)
			await harness.provider.queueMessageForTaskDurably(
				restored.taskId,
				"Keep this guidance for later",
				[],
				"before-stop",
				{ source: "human" },
			)
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(restored.getActiveAskTimestamp()).toEqual(expect.any(Number))
			expect(nextTurn.request).toBeUndefined()

			if (admission === "submit") await restored.submitUserMessage("Resume now")
			else {
				expect(
					await harness.provider.queueMessageForTaskDurably(
						restored.taskId,
						"Resume now",
						[],
						"fresh-after-stop",
						{ source: "human" },
					),
				).toBe(true)
			}
			await vi.waitFor(() => expect(nextTurn.request).toBeDefined())
			expect(nextTurn.request?.signal?.aborted).toBe(false)
			if (admission === "queue") {
				expect(
					restored.apiConversationHistory.some((message) =>
						message.queued_message_ids?.includes("before-stop"),
					),
				).toBe(true)
				expect(restored.messageQueueService.messages.map((message) => message.id)).toEqual([
					"passive-after-stop",
					"fresh-after-stop",
				])
				const stoppedAgain = deferred<Task>()
				vi.mocked(transcript.addToAlphaMessages).mockImplementation(async function (this: Task, ...args) {
					const result = await appendMessage.apply(this, args)
					if (this !== restored && args[0].ask === "resume_task") stoppedAgain.resolve(this)
					return result
				})
				const retryTurn = harness.queueTurn(restored.taskId, "Must remain stopped after receipt retry")
				await harness.provider.cancelTask(restored.taskId, "webview_stop")
				const stopped = await stoppedAgain.promise
				expect(
					await harness.provider.queueMessageForTaskDurably(
						stopped.taskId,
						"Resume now",
						[],
						"fresh-after-stop",
						{ source: "human" },
					),
				).toBe(true)
				await new Promise<void>((resolve) => setImmediate(resolve))
				expect(stopped.getActiveAskTimestamp()).toEqual(expect.any(Number))
				expect(stopped.messageQueueService.getClaimedMessageIds()).toEqual([])
				expect(retryTurn.request).toBeUndefined()
			}
		},
	)
})
