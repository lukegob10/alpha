import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AlphaCodeEventName } from "@alpha-code/types"

import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"
import { WorkspaceMutationGate } from "../WorkspaceMutationGate"

async function completionFixture() {
	const taskId = "completion-observer-task"
	const persistence = new InMemoryAgentControlPersistence()
	const store = new AgentControlStore(persistence)
	await store.initialize()
	await store.ensureRoot({ taskId, objective: "Finish the task", status: "running" })
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		agentControlStore: store,
		agentControlStoreReady: Promise.resolve(),
		agentControlRootStatusWrites: new Map(),
		workspaceMutationGate: new WorkspaceMutationGate(),
	}) as AlphaProvider
	const task = Object.assign(Object.setPrototypeOf(new EventEmitter(), Task.prototype), {
		taskId,
		taskKind: "primary",
		abort: false,
		didComplete: false,
		didEmitTaskCompleted: false,
		taskCancellationController: new AbortController(),
		alphaMessages: [],
		userMessageContent: [],
		toolUsage: {},
		debouncedEmitTokenUsage: { cancel: () => undefined },
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => provider },
		getCompletionGateDecision: async () => ({ allowed: true }),
	}) as Task
	return { task, persistence }
}

afterEach(() => vi.restoreAllMocks())

describe("Task completion publication", () => {
	it.each([AlphaCodeEventName.TaskTokenUsageUpdated, AlphaCodeEventName.TaskCompleted] as const)(
		"keeps accepted completion durable when a %s observer throws",
		async (event) => {
			const { task, persistence } = await completionFixture()
			vi.spyOn(console, "error").mockImplementation(() => undefined)
			const failingObserver = vi.fn(() => {
				throw new Error("fixture: observer failed")
			})
			const finalUsage = vi.fn()
			const completed = vi.fn()
			task.once(event, failingObserver)
			task.once(AlphaCodeEventName.TaskTokenUsageUpdated, finalUsage)
			task.once(AlphaCodeEventName.TaskCompleted, completed)

			const [completion] = await Promise.allSettled([task.finalizeTaskCompletion()])
			const reloaded = new AgentControlStore(persistence)
			await reloaded.initialize()

			expect(failingObserver).toHaveBeenCalledOnce()
			expect(task.isCompleted()).toBe(true)
			expect(reloaded.getAgent(task.taskId, task.taskId)?.status).toBe("completed")
			expect(completion).toEqual({ status: "fulfilled", value: true })
			expect(finalUsage).toHaveBeenCalledExactlyOnceWith(task.taskId, task.getTokenUsage(), {})
			expect(completed).toHaveBeenCalledExactlyOnceWith(task.taskId, task.getTokenUsage(), {})
			await expect(task.finalizeTaskCompletion()).resolves.toBe(false)
		},
	)
})
