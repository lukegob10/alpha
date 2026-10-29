import { describe, expect, it, vi } from "vitest"
import { TaskLifecycleState, TaskStatus, type ExtensionMessage } from "@alpha-code/types"

import type { Task } from "../../task/Task"
import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const createView = (taskId: string) => {
	const taskSessions = new TaskSessionRegistry()
	const task = {
		taskId,
		taskKind: "primary",
		taskStatus: TaskStatus.Running,
		isStreaming: false,
		isTurnActive: () => true,
		alphaMessages: [],
		metadata: {},
	} as unknown as Task
	taskSessions.register(task)
	const post = vi.fn(async (_message: ExtensionMessage): Promise<void> => undefined)
	const projectTree = vi.fn(async () => undefined)
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		taskSessions,
		currentView: { type: "task", taskId },
		taskNavigationGeneration: 0,
		taskStateSeq: 0,
		taskHistoryStore: { get: () => undefined },
		contextProxy: { getValues: () => ({}) },
		getAgentLifecycleDegraded: () => ({}),
		buildManagedAgentTreeProjection: projectTree,
		getHostProviders: () => [provider],
		postMessageToWebview: post,
		log: vi.fn(),
	})
	return { provider, taskSessions, post, projectTree }
}

describe("independent session state delivery across views", () => {
	it("delivers completion metadata to a peer while the first view's transport is pending and awaits both", async () => {
		const sidebar = createView("sidebar-task")
		const editor = createView("editor-task")
		const finishSidebar = barrier()
		sidebar.post.mockImplementationOnce(async () => finishSidebar.promise)
		editor.taskSessions.markLifecycle("editor-task", TaskLifecycleState.Waiting, "completion")
		Object.assign(sidebar.provider, { getHostProviders: () => [sidebar.provider, editor.provider] })
		const pending = sidebar.provider.postTaskSessionStateToWebview({ includeManagedAgentTree: false })
		let settled = false
		void pending.then(() => {
			settled = true
		})

		try {
			expect(sidebar.post).toHaveBeenCalledOnce()
			expect(editor.post).toHaveBeenCalledWith({
				type: "state",
				state: expect.objectContaining({
					currentTaskId: "editor-task",
					currentView: { type: "task", taskId: "editor-task" },
					liveTasksById: expect.objectContaining({
						"editor-task": expect.objectContaining({
							lifecycle: TaskLifecycleState.Waiting,
							waitingReason: "completion",
						}),
					}),
				}),
			})
			await Promise.resolve()
			expect(settled).toBe(false)
		} finally {
			finishSidebar.resolve()
			await pending
		}
		expect(settled).toBe(true)
	})

	it.each([false, true])(
		"preserves each view's navigation ownership while its tree is pending, advance generation: %s",
		async (advanceGeneration) => {
			const sidebar = createView("sidebar-task")
			const editor = createView("editor-task")
			const finishTree = barrier()
			sidebar.projectTree.mockImplementationOnce(async () => {
				await finishTree.promise
				return undefined
			})
			Object.assign(sidebar.provider, { getHostProviders: () => [sidebar.provider, editor.provider] })
			const pending = sidebar.provider.postTaskSessionStateToWebview()
			try {
				await Promise.resolve()
				expect(editor.post).toHaveBeenCalledOnce()
				Object.assign(sidebar.provider, {
					currentView: { type: "newTaskDraft" },
					taskNavigationGeneration: advanceGeneration ? 1 : 0,
				})
			} finally {
				finishTree.resolve()
				await pending
			}
			expect(sidebar.post).not.toHaveBeenCalled()
			expect(editor.post).toHaveBeenCalledOnce()
			expect(editor.post.mock.calls[0][0]).toMatchObject({
				type: "state",
				state: { currentTaskId: "editor-task", taskStateSeq: 1 },
			})
		},
	)

	it("skips a disposed peer while preserving delivery to the remaining views", async () => {
		const sidebar = createView("sidebar-task")
		const closed = createView("closed-task")
		const editor = createView("editor-task")
		Object.assign(closed.provider, { _disposed: true })
		Object.assign(sidebar.provider, {
			getHostProviders: () => [sidebar.provider, closed.provider, editor.provider],
		})

		await sidebar.provider.postTaskSessionStateToWebview({ includeManagedAgentTree: false })

		expect(sidebar.post).toHaveBeenCalledOnce()
		expect(closed.post).not.toHaveBeenCalled()
		expect(editor.post).toHaveBeenCalledOnce()
	})
})
