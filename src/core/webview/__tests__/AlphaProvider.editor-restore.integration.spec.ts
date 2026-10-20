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

describe("editor restore with durable queued input", () => {
	it("reopens the saved chat without submitting queued input until a fresh human continuation", async () => {
		harness = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
		const original = harness.root
		const originalTurn = harness.queueTurn(original.taskId, "Original request")
		original.start()
		await originalTurn.entered
		await original.submitUserMessage(
			"Keep this draft for later",
			[],
			undefined,
			undefined,
			undefined,
			"saved-draft",
		)
		await harness.provider.removeTaskFromStack({ taskId: original.taskId })
		expect(harness.provider.getLiveTask(original.taskId)).toBeUndefined()

		const resumedAsk = deferred<Task>()
		const transcript = Task.prototype as unknown as TranscriptWriter
		const appendMessage = transcript.addToAlphaMessages
		vi.spyOn(transcript, "addToAlphaMessages").mockImplementation(async function (this: Task, ...args) {
			const result = await appendMessage.apply(this, args)
			if (this !== original && args[0].ask === "resume_task") resumedAsk.resolve(this)
			return result
		})
		const nextTurn = harness.queueTurn(original.taskId, "Explicit continuation")
		await expect(harness.provider.restoreEditorTask(original.taskId, () => true)).resolves.toBe(true)
		const restored = await resumedAsk.promise
		// Drain ask admission microtasks, without waiting for a wall-clock race.
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(harness.provider.getActiveTaskId()).toBe(original.taskId)
		expect(restored.getActiveAskTimestamp()).toEqual(expect.any(Number))
		expect(restored.messageQueueService.getClaimedMessageIds()).toEqual([])
		expect(restored.queuedMessages).toMatchObject([{ id: "saved-draft", text: "Keep this draft for later" }])
		expect(nextTurn.request).toBeUndefined()

		await restored.submitUserMessage("Continue this chat now")
		await nextTurn.entered
		expect(nextTurn.request?.signal?.aborted).toBe(false)
	})
})
