import { describe, expect, it, vi } from "vitest"
import type { TaskApprovalModeUpdate, WebviewMessage } from "@alpha-code/types"
import type * as vscode from "vscode"

import { AlphaProvider } from "../AlphaProvider"
import type { Task } from "../../task/Task"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const selectionCommands: WebviewMessage[] = [
	{ type: "mode", text: "code" },
	{ type: "loadApiConfiguration", text: "selected-profile" },
	{ type: "loadApiConfigurationById", text: "selected-profile-id" },
]

const createProvider = () => {
	let selectedTask: Task | undefined = { taskId: "first" } as Task
	const entered = barrier()
	const finish = barrier()
	const handleModeSwitch = vi.fn(async () => undefined)
	const activateProviderProfile = vi.fn(async () => undefined)
	const updateTaskApprovalMode = vi.fn((update: TaskApprovalModeUpdate) => ({
		...update,
		status: "applied" as const,
	}))
	let receive!: (message: WebviewMessage) => Promise<void> | undefined
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		currentView: { type: "task", taskId: selectedTask.taskId },
		taskNavigationGeneration: 0,
		webviewDisposables: [],
		immediateWebviewOperations: new Set<Promise<void>>(),
		taskControlMessageQueues: new Map<string, Promise<void>>(),
		webviewMessageQueue: Promise.resolve(),
		getCurrentTask: () => selectedTask,
		getActiveTaskId: () => selectedTask?.taskId,
		contextProxy: { getValue: vi.fn(), setValue: vi.fn(async () => undefined) },
		condenseTaskContext: async () => {
			entered.resolve()
			await finish.promise
		},
		handleModeSwitch,
		activateProviderProfile,
		updateTaskApprovalMode,
		postMessageToWebview: vi.fn(async () => undefined),
		postStateToWebview: vi.fn(async () => undefined),
		postTaskStateToWebview: vi.fn(async () => undefined),
		log: vi.fn(),
	})
	const select = (taskId: string | undefined, advanceNavigation = true) => {
		selectedTask = taskId ? ({ taskId } as Task) : undefined
		Object.assign(provider, {
			currentView: taskId ? { type: "task", taskId } : { type: "newTaskDraft" },
			taskNavigationGeneration: provider.getTaskNavigationGeneration() + (advanceNavigation ? 1 : 0),
		})
	}
	Reflect.get(provider, "setWebviewMessageListener").call(provider, {
		onDidReceiveMessage: (callback: typeof receive) => {
			receive = callback
			return { dispose: vi.fn() }
		},
	} as unknown as vscode.Webview)
	return { provider, receive: (message: WebviewMessage) => receive(message), select, entered, finish }
}

describe("webview selection ownership at receipt", () => {
	it("applies a task approval change while global compaction is pending", async () => {
		const { provider, receive, entered, finish } = createProvider()
		const pending = receive({ type: "condenseTaskContextRequest", text: "first" })
		await entered.promise
		const update: TaskApprovalModeUpdate = { requestId: "approval-first", taskId: "first", approvalMode: "auto" }
		const changed = receive({ type: "setTaskApprovalMode", taskApprovalModeUpdate: update })
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(provider.updateTaskApprovalMode).toHaveBeenCalledExactlyOnceWith(update)
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "taskApprovalModeUpdated",
				taskApprovalModeUpdateResult: { ...update, status: "applied" },
			})
		} finally {
			finish.resolve()
			await Promise.all([pending, changed])
		}
	})

	it("orders approval changes by their addressed task even after focus changes", async () => {
		const { provider, receive, select } = createProvider()
		const firstControl = barrier()
		const queues: Map<string, Promise<void>> = Reflect.get(provider, "taskControlMessageQueues")
		queues.set("first", firstControl.promise)
		select("second")
		const first: TaskApprovalModeUpdate = { requestId: "approval-first", taskId: "first", approvalMode: "auto" }
		const second: TaskApprovalModeUpdate = { requestId: "approval-second", taskId: "second", approvalMode: "ask" }
		const pendingFirst = receive({ type: "setTaskApprovalMode", taskApprovalModeUpdate: first })
		const pendingSecond = receive({ type: "setTaskApprovalMode", taskApprovalModeUpdate: second })
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(provider.updateTaskApprovalMode).toHaveBeenCalledExactlyOnceWith(second)
		} finally {
			firstControl.resolve()
			await Promise.all([pendingFirst, pendingSecond])
		}
		expect(provider.updateTaskApprovalMode).toHaveBeenNthCalledWith(2, first)
		expect(queues.size).toBe(0)
	})

	it.each(selectionCommands)("does not retarget a queued $type after selecting another task", async (command) => {
		const { provider, receive, select, entered, finish } = createProvider()
		const pending = receive({ type: "condenseTaskContextRequest", text: "first" })
		await entered.promise
		const queued = receive(command)
		select("second")
		finish.resolve()
		await Promise.all([pending, queued])

		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
		expect(provider.postTaskStateToWebview).toHaveBeenCalledOnce()
	})

	it.each(selectionCommands)("does not apply a queued draft $type to a later task", async (command) => {
		const { provider, receive, select, entered, finish } = createProvider()
		select(undefined)
		const pending = receive({ type: "condenseTaskContextRequest", text: "first" })
		await entered.promise
		const queued = receive(command)
		select("second")
		finish.resolve()
		await Promise.all([pending, queued])

		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
	})

	it("does not apply a queued mode change to a replacement of the same task", async () => {
		const { provider, receive, select, entered, finish } = createProvider()
		const currentView = Reflect.get(provider, "currentView")
		const pending = receive({ type: "condenseTaskContextRequest", text: "first" })
		await entered.promise
		const queued = receive({ type: "mode", text: "code" })
		select("first", false)
		Object.assign(provider, { currentView })
		finish.resolve()
		await Promise.all([pending, queued])

		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
	})

	it("rejects a queued mode click after navigating away and back to the same task instance", async () => {
		const { provider, receive, select, entered, finish } = createProvider()
		const selectedTask = provider.getCurrentTask()
		const currentView = Reflect.get(provider, "currentView")
		const pending = receive({ type: "condenseTaskContextRequest", text: "first" })
		await entered.promise
		const queued = receive({ type: "mode", text: "code" })
		select("second")
		select("first")
		Object.assign(provider, { currentView, getCurrentTask: () => selectedTask })
		finish.resolve()
		await Promise.all([pending, queued])

		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
	})

	it("keeps an unchanged selection's mode and profile commands in arrival order", async () => {
		const { provider, receive, entered, finish } = createProvider()
		const pending = receive({ type: "condenseTaskContextRequest", text: "first" })
		await entered.promise
		const queued = selectionCommands.map((command) => receive(command))
		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
		finish.resolve()
		await Promise.all([pending, ...queued])

		expect(provider.handleModeSwitch).toHaveBeenCalledExactlyOnceWith("code")
		expect(provider.activateProviderProfile).toHaveBeenNthCalledWith(1, { name: "selected-profile" })
		expect(provider.activateProviderProfile).toHaveBeenNthCalledWith(2, { id: "selected-profile-id" })
		expect(vi.mocked(provider.handleModeSwitch).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(provider.activateProviderProfile).mock.invocationCallOrder[0],
		)
	})

	it("keeps queued global settings changes when task selection changes", async () => {
		const { provider, receive, select, entered, finish } = createProvider()
		const pending = receive({ type: "condenseTaskContextRequest", text: "first" })
		await entered.promise
		const queued = receive({ type: "allowedCommands", commands: ["git status"] })
		select("second")
		finish.resolve()
		await Promise.all([pending, queued])

		expect(provider.contextProxy.setValue).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["git status"])
		expect(provider.postTaskStateToWebview).not.toHaveBeenCalled()
	})
})
