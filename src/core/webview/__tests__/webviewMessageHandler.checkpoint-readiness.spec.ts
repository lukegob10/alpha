import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import type { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

const taskId = "checkpoint-task"
const payload = { ts: 42, commitHash: "checkpoint-hash", mode: "restore" } as const

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

function fixture(isInitialized = true) {
	const task = {
		taskId,
		isInitialized,
		abort: false,
		checkpointRestore: vi.fn(async () => {
			task.abort = true
			return true
		}),
	}
	const historyItem = { id: taskId }
	const host = {
		cancelTask: vi.fn(async () => undefined),
		getLiveTask: vi.fn(() => task),
		getCurrentTask: vi.fn(() => task),
		getTaskOwner: vi.fn(() => undefined),
		canAcceptTaskInput: vi.fn(() => true),
		getTaskWithId: vi.fn(async () => ({ historyItem })),
		createTaskWithHistoryItem: vi.fn(async () => undefined),
		runWorkspaceMutation: vi.fn(async (_task, _label, run: () => Promise<unknown>) => run()),
		log: vi.fn(),
	}
	return { task, historyItem, host, provider: host as unknown as AlphaProvider }
}

describe("direct webview checkpoint restore", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("never admits a workspace mutation when task initialization times out", async () => {
		vi.useFakeTimers()
		const showError = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
		const { task, host, provider } = fixture(false)
		const restore = webviewMessageHandler(provider, { type: "checkpointRestore", taskId, payload })
		await vi.advanceTimersByTimeAsync(3_000)
		await restore
		expect(showError).toHaveBeenCalledOnce()
		expect(host.runWorkspaceMutation).not.toHaveBeenCalled()
		expect(task.checkpointRestore).not.toHaveBeenCalled()
	})

	it("does not restore a replaced runtime after its initialization settles", async () => {
		vi.useFakeTimers()
		const { task, host, provider } = fixture(false)
		const restore = webviewMessageHandler(provider, { type: "checkpointRestore", taskId, payload })
		await vi.advanceTimersByTimeAsync(0)
		const successor = { ...task, checkpointRestore: vi.fn() }
		host.getLiveTask.mockReturnValue(successor)
		task.isInitialized = true
		await vi.advanceTimersByTimeAsync(100)
		await restore
		expect(host.runWorkspaceMutation).not.toHaveBeenCalled()
		expect(task.checkpointRestore).not.toHaveBeenCalled()
		expect(successor.checkpointRestore).not.toHaveBeenCalled()
	})

	it("rechecks runtime ownership after the workspace mutation gate opens", async () => {
		const { task, host, provider } = fixture()
		const admitted = deferred()
		const releaseGate = deferred()
		host.runWorkspaceMutation.mockImplementationOnce(async (_task, _label, run) => {
			admitted.resolve()
			await releaseGate.promise
			return run()
		})
		const restore = webviewMessageHandler(provider, { type: "checkpointRestore", taskId, payload })
		await admitted.promise
		const successor = { ...task, checkpointRestore: vi.fn() }
		host.getLiveTask.mockReturnValue(successor)
		releaseGate.resolve()
		await restore
		expect(task.checkpointRestore).not.toHaveBeenCalled()
		expect(successor.checkpointRestore).not.toHaveBeenCalled()
		expect(host.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it.each(["preview", "restore"] as const)("reopens the stopped task after a successful %s", async (mode) => {
		const { task, historyItem, host, provider } = fixture()
		await webviewMessageHandler(provider, { type: "checkpointRestore", taskId, payload: { ...payload, mode } })
		expect(task.abort).toBe(true)
		expect(task.checkpointRestore).toHaveBeenCalledExactlyOnceWith({ ...payload, mode })
		expect(host.getTaskWithId).toHaveBeenCalledExactlyOnceWith(taskId, { includeApiConversationHistory: false })
		expect(host.createTaskWithHistoryItem).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining(historyItem),
			expect.objectContaining({ preserveExisting: true, requireExplicitResume: true, background: false }),
		)
	})
})
