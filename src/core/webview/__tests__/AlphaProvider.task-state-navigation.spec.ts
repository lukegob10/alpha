import { describe, expect, it, vi } from "vitest"
import type { ExtensionMessage, TaskReasoningProjection } from "@alpha-code/types"
import { TaskStatus } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import type { Task } from "../../task/Task"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const reasoning: TaskReasoningProjection = {
	requested: { kind: "default" },
	effective: { kind: "off" },
	capabilities: { kind: "unavailable", canDisable: false },
	fallbackReason: "unavailable",
}

const createTask = (taskId: string): Task =>
	({
		taskId,
		taskKind: "primary",
		taskStatus: TaskStatus.Running,
		taskMode: "code",
		taskApiConfigName: taskId,
		apiConfiguration: { apiProvider: "anthropic", apiModelId: taskId },
		clineMessages: [{ ts: 1, type: "say", say: "text", text: taskId }],
		getTaskMode: vi.fn(async () => "code"),
		getTaskApiConfigName: vi.fn(async () => taskId),
	}) as unknown as Task

const createProvider = () => {
	const taskSessions = new TaskSessionRegistry()
	const post = vi.fn(async (_message: ExtensionMessage) => undefined)
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		taskSessions,
		taskNavigationGeneration: 0,
		clineMessagesSeq: 0,
		taskStateSeq: 0,
		messageQueueSeq: 0,
		currentTaskTodosSeq: 0,
		currentView: { type: "newTaskDraft" },
		newTaskDraftMode: "code",
		publishedTaskTranscriptRevisions: new Map(),
		taskHistoryStoreReady: Promise.resolve(),
		taskHistoryStore: { get: () => undefined, getByWorkspace: () => [] },
		context: { extension: { packageJSON: { version: "3.2.4" } } },
		contextProxy: { getValue: vi.fn(), getValues: () => ({}) },
		getState: vi.fn(async () => ({ apiConfiguration: { apiProvider: "anthropic" }, mode: "code" })),
		getGlobalState: vi.fn(),
		getReasoningProjection: vi.fn(async () => reasoning),
		getProviderSettingsSnapshot: () => ({ apiProvider: "anthropic" }),
		mergeAllowedCommands: () => [],
		mergeDeniedCommands: () => [],
		buildManagedAgentTreeProjection: vi.fn(async () => undefined),
		getAgentLifecycleSnapshots: () => ({}),
		getAgentLifecycleDegraded: () => ({}),
		getHostProviders: () => [provider],
		postMessageToWebview: post,
		log: vi.fn(),
	})
	const select = (task: Task | undefined, advanceNavigation = true) => {
		Object.assign(provider, {
			taskNavigationGeneration: provider.getTaskNavigationGeneration() + (advanceNavigation ? 1 : 0),
			currentView: task ? { type: "task", taskId: task.taskId } : { type: "newTaskDraft" },
		})
		if (task) taskSessions.register(task)
		else taskSessions.clearFocus()
	}
	return { provider, taskSessions, post, select }
}

describe("task state navigation ownership", () => {
	it.each(["task", "blank"] as const)(
		"does not publish an old task transition after a newer %s selection during reasoning projection",
		async (destination) => {
			const { provider, post, select } = createProvider()
			const entered = barrier()
			const finish = barrier()
			Object.assign(provider, {
				getReasoningProjection: vi.fn(async () => {
					entered.resolve()
					await finish.promise
					return reasoning
				}),
			})
			select(createTask("first"))
			const publishing = provider.postTaskStateToWebview()
			await entered.promise
			select(destination === "task" ? createTask("second") : undefined)
			finish.resolve()
			await publishing

			expect(post).not.toHaveBeenCalled()
		},
	)

	it("keeps a full snapshot internally associated with the selection captured before task metadata awaits", async () => {
		const { provider, select } = createProvider()
		const entered = barrier()
		const finish = barrier()
		const first = createTask("first")
		first.getTaskMode = vi.fn(async () => {
			entered.resolve()
			await finish.promise
			return "code"
		})
		select(first)
		const projecting = provider.getStateToPostToWebview()
		await entered.promise
		select(createTask("second"))
		finish.resolve()
		const snapshot = await projecting

		expect(snapshot.currentTaskId).toBe("first")
		expect(snapshot.currentView).toEqual({ type: "task", taskId: "first" })
		expect(snapshot.activeTaskId).toBe("first")
		expect(snapshot.currentApiConfigName).toBe("first")
		expect(snapshot.clineMessages[0].text).toBe("first")
	})

	it.each([
		"postStateToWebview",
		"postStateToWebviewWithoutTaskHistory",
		"postStateToWebviewWithoutAlphaMessages",
	] as const)("%s does not deliver an obsolete full projection after navigation", async (method) => {
		const { provider, post, select } = createProvider()
		const entered = barrier()
		const finish = barrier()
		const first = createTask("first")
		first.getTaskMode = vi.fn(async () => {
			entered.resolve()
			await finish.promise
			return "code"
		})
		select(first)
		const publishing = provider[method]()
		await entered.promise
		select(createTask("second"))
		finish.resolve()
		await publishing

		expect(post).not.toHaveBeenCalled()
	})

	it("does not deliver the old managed-agent tree after selection changes during its projection", async () => {
		const { provider, post, select } = createProvider()
		const entered = barrier()
		const finish = barrier()
		Object.assign(provider, {
			buildManagedAgentTreeProjection: vi.fn(async () => {
				entered.resolve()
				await finish.promise
				return undefined
			}),
		})
		select(createTask("first"))
		const publishing = provider.postTaskSessionStateToWebview()
		await entered.promise
		select(createTask("second"))
		finish.resolve()
		await publishing

		expect(post).not.toHaveBeenCalled()
	})

	it("still broadcasts a global submission preference when its local full snapshot loses navigation ownership", async () => {
		const { provider, post, select } = createProvider()
		const entered = barrier()
		const finish = barrier()
		const peerPost = vi.fn(async (_message: ExtensionMessage) => undefined)
		const peer = { postMessageToWebview: peerPost }
		Object.assign(provider, {
			contextProxy: { getValue: (key: string) => (key === "autoSteer" ? true : undefined) },
			getHostProviders: () => [provider, peer],
		})
		const first = createTask("first")
		first.getTaskMode = vi.fn(async () => {
			entered.resolve()
			await finish.promise
			return "code"
		})
		select(first)
		const publishing = provider.postStateToWebview()
		await entered.promise
		select(createTask("second"))
		finish.resolve()
		await publishing

		expect(post).not.toHaveBeenCalled()
		expect(peerPost).toHaveBeenCalledWith({ type: "state", state: { autoSteer: true } })
	})

	it.each([
		"postTaskStateToWebview",
		"postStateToWebview",
		"postStateToWebviewWithoutTaskHistory",
		"postStateToWebviewWithoutAlphaMessages",
		"postTaskSessionStateToWebview",
	] as const)("%s does not deliver state from a selection replaced by task creation", async (method) => {
		const { provider, post, select } = createProvider()
		const entered = barrier()
		const finish = barrier()
		Object.assign(provider, {
			getReasoningProjection: vi.fn(async () => {
				entered.resolve()
				await finish.promise
				return reasoning
			}),
			buildManagedAgentTreeProjection: vi.fn(async () => {
				if (method === "postTaskSessionStateToWebview") {
					entered.resolve()
					await finish.promise
				}
				return undefined
			}),
		})
		select(createTask("first"))
		const publishing = provider[method]()
		await entered.promise
		// Task creation and close fallback replace selection directly, independently
		// of showTaskWithId/startBlankTask's explicit navigation generation.
		select(createTask("second"), false)
		finish.resolve()
		await publishing

		expect(post).not.toHaveBeenCalled()
	})

	it("does not restore a closed task into a fresh draft while its transition projection settles", async () => {
		const { provider, taskSessions, post, select } = createProvider()
		const entered = barrier()
		const finish = barrier()
		Object.assign(provider, {
			getReasoningProjection: vi.fn(async () => {
				entered.resolve()
				await finish.promise
				return reasoning
			}),
		})
		const first = createTask("first")
		select(first)
		const publishing = provider.postTaskStateToWebview()
		await entered.promise
		taskSessions.unregister(first.taskId, first)
		select(undefined, false)
		finish.resolve()
		await publishing

		expect(post).not.toHaveBeenCalled()
	})

	it("delivers normal same-selection task state", async () => {
		const { provider, post, select } = createProvider()
		select(createTask("first"))
		await provider.postTaskStateToWebview()

		expect(post).toHaveBeenCalledWith({
			type: "state",
			state: expect.objectContaining({
				currentTaskId: "first",
				currentView: { type: "task", taskId: "first" },
				activeTaskId: "first",
			}),
		})
	})
})
