import { describe, expect, it, vi } from "vitest"
import type { ExtensionMessage, HistoryItem } from "@alpha-code/types"

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

const createTask = (taskId: string): Task =>
	({ taskId, taskKind: "primary", clineMessages: [], emit: vi.fn() }) as unknown as Task

const createProvider = () => {
	const taskSessions = new TaskSessionRegistry()
	const post = vi.fn(async (_message: ExtensionMessage): Promise<void> => undefined)
	const finalize = vi.fn(async (): Promise<void> => undefined)
	const postTaskState = vi.fn(async (): Promise<void> => undefined)
	const postState = vi.fn(async (): Promise<void> => undefined)
	const publishTranscript = vi.fn()
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		taskSessions,
		taskNavigationGeneration: 0,
		currentView: { type: "newTaskDraft" },
		newTaskDraftMode: "code",
		subagentResidencyEvictions: new Map(),
		publishedTaskTranscriptRevisions: new Map(),
		getHostProviders: () => [provider],
		postMessageToWebview: post,
		finalizeActiveCompletionCandidate: finalize,
		postTaskStateToWebview: postTaskState,
		postStateToWebview: postState,
		postStateToWebviewWithoutAlphaMessages: postState,
		scheduleVisibleTranscript: publishTranscript,
		log: vi.fn(),
	})
	return { provider, taskSessions, post, finalize, postTaskState, postState, publishTranscript }
}

describe("blank-task navigation generations", () => {
	it("discards an old history lookup after the user opens a blank task", async () => {
		const { provider, taskSessions, publishTranscript } = createProvider()
		const lookupEntered = barrier()
		const historyReady = barrier()
		const oldTask = createTask("old-task")
		oldTask.clineMessages = Array.from({ length: 200 }, (_, index) => ({
			ts: index + 1,
			type: "say" as const,
			say: "text" as const,
			text: `row-${index}-${"x".repeat(2000)}`,
		}))
		let obsoleteTranscriptBytes = 0
		publishTranscript.mockImplementation(() => {
			obsoleteTranscriptBytes += Buffer.byteLength(JSON.stringify(oldTask.clineMessages))
		})
		const historyItem: HistoryItem = {
			id: oldTask.taskId,
			number: 1,
			ts: 1,
			task: "Historical task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		vi.spyOn(provider, "getTaskWithId").mockImplementation(async () => {
			lookupEntered.resolve()
			await historyReady.promise
			return {
				historyItem,
				taskDirPath: "/task",
				apiConversationHistoryFilePath: "/task/api.json",
				uiMessagesFilePath: "/task/ui.json",
				apiConversationHistory: [],
			}
		})
		const restore = vi.spyOn(provider, "createTaskWithHistoryItem").mockImplementation(async () => {
			taskSessions.register(oldTask)
			Object.assign(provider, { currentView: { type: "task", taskId: oldTask.taskId } })
			return oldTask
		})

		const opening = provider.showTaskWithId(oldTask.taskId)
		await lookupEntered.promise
		await provider.startBlankTask()
		historyReady.resolve()
		await opening

		expect.soft(restore).not.toHaveBeenCalled()
		expect.soft(provider.getActiveTaskId()).toBeUndefined()
		expect.soft(obsoleteTranscriptBytes).toBe(0)
		expect.soft(publishTranscript).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskOpenResult",
			taskId: oldTask.taskId,
			success: false,
		})
	})

	it("finishes mandatory completion finalization without replacing a newer selection", async () => {
		const { provider, taskSessions, finalize, postTaskState, post } = createProvider()
		const first = createTask("first")
		const second = createTask("second")
		taskSessions.register(second, { focus: false })
		taskSessions.register(first)
		const finalization = barrier()
		finalize.mockReturnValueOnce(finalization.promise)

		const blank = provider.startBlankTask()
		await provider.showTaskWithId(second.taskId)
		postTaskState.mockClear()
		post.mockClear()
		finalization.resolve()
		await blank

		expect(finalize).toHaveBeenCalledOnce()
		expect(provider.getActiveTaskId()).toBe(second.taskId)
		expect(postTaskState).not.toHaveBeenCalled()
		expect(post).not.toHaveBeenCalledWith({ type: "invoke", invoke: "newChat" })
	})

	it("stops a superseded blank transition after its chat action is delivered", async () => {
		const { provider, taskSessions, postTaskState, post } = createProvider()
		const next = createTask("next")
		taskSessions.register(next)
		const actionEntered = barrier()
		const actionDelivered = barrier()
		post.mockImplementationOnce(async () => {
			actionEntered.resolve()
			await actionDelivered.promise
		})

		const blank = provider.startBlankTask()
		await actionEntered.promise
		await provider.showTaskWithId(next.taskId)
		postTaskState.mockClear()
		post.mockClear()
		actionDelivered.resolve()
		await blank

		expect(provider.getActiveTaskId()).toBe(next.taskId)
		expect(postTaskState).not.toHaveBeenCalled()
		expect(post).not.toHaveBeenCalledWith({ type: "invoke", invoke: "newChat" })
	})

	it("does not clear newer task input after a delayed blank-state delivery", async () => {
		const { provider, taskSessions, postTaskState, post, postState } = createProvider()
		const next = createTask("next")
		taskSessions.register(next)
		const stateEntered = barrier()
		const stateDelivered = barrier()
		postTaskState.mockImplementationOnce(async () => {
			stateEntered.resolve()
			await stateDelivered.promise
		})

		const blank = provider.startBlankTask()
		await stateEntered.promise
		await provider.showTaskWithId(next.taskId)
		post.mockClear()
		postState.mockClear()
		stateDelivered.resolve()
		await blank

		expect(provider.getActiveTaskId()).toBe(next.taskId)
		expect(postState).not.toHaveBeenCalled()
		expect(post).not.toHaveBeenCalledWith({ type: "invoke", invoke: "newChat" })
	})
})
