import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskStatus } from "@alpha-code/types"
import type { ExtensionContext } from "vscode"

import { checkAutoApproval } from "../../auto-approval"
import { ContextProxy } from "../../config/ContextProxy"
import type { Task } from "../../task/Task"
import type { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import { webviewMessageHandler } from "../webviewMessageHandler"

let nextHostId = 0

function timedQuestion(taskId: string) {
	const autoAnswer = vi.fn()
	const timer = setTimeout(autoAnswer, 5_000)
	const cancelAutoApprovalTimeout = vi.fn((_notify?: boolean) => clearTimeout(timer))
	const abortTask = vi.fn(async () => {})
	const task = {
		taskId,
		taskStatus: TaskStatus.Running,
		isStreaming: true,
		alphaMessages: [],
		cancelAutoApprovalTimeout,
		abortTask,
	} as unknown as Task
	return { task, autoAnswer, cancelAutoApprovalTimeout, abortTask }
}

function hostFixture(previousTimeout: number | undefined = 60_000) {
	const storage = `question-wait-settings/host-${++nextHostId}`
	const sidebar = TaskSessionRegistry.forGlobalStorage(storage)
	const editor = TaskSessionRegistry.forGlobalStorage(storage)
	const otherHost = TaskSessionRegistry.forGlobalStorage(`${storage}-unrelated`)
	const visible = timedQuestion("visible-question")
	const offscreen = timedQuestion("offscreen-question")
	const editorQuestion = timedQuestion("editor-question")
	const unrelated = timedQuestion("unrelated-question")
	sidebar.register(visible.task)
	sidebar.register(offscreen.task, { focus: false })
	editor.register(editorQuestion.task)
	otherHost.register(unrelated.task)
	const contextProxy = {
		getValue: vi.fn(() => previousTimeout),
		setValue: vi.fn(async () => {}),
	}
	const postStateToWebview = vi.fn(async () => {})
	const getLiveTaskIds = vi.fn(() => sidebar.getLiveTaskIds())
	const provider = {
		contextProxy,
		getLiveTaskIds,
		getLiveTask: (taskId: string | undefined) => sidebar.getTask(taskId),
		postStateToWebview,
	} as unknown as AlphaProvider
	const cleanup = () => {
		sidebar.unregister(visible.task.taskId)
		sidebar.unregister(offscreen.task.taskId)
		editor.unregister(editorQuestion.task.taskId)
		otherHost.unregister(unrelated.task.taskId)
		for (const view of [sidebar, editor, otherHost]) view.disposeView()
	}
	return {
		provider,
		contextProxy,
		postStateToWebview,
		getLiveTaskIds,
		sidebar,
		editor,
		questions: [visible, offscreen, editorQuestion],
		unrelated,
		cleanup,
	}
}

describe("question waiting settings saves", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it.each(["autoSteer", "followupAutoApproveTimeoutMs"])(
		"new questions see indefinite waiting while %s persistence is deferred",
		async (deferredKey) => {
			const fixture = hostFixture()
			const update = vi.fn(async (_key: string, _value: unknown) => {})
			const contextProxy = new ContextProxy({ globalState: { update } } as unknown as ExtensionContext)
			await contextProxy.setValue("followupAutoApproveTimeoutMs", 5_000)
			update.mockClear()
			let releaseWrite!: () => void
			let markWriting!: () => void
			const writing = new Promise<void>((resolve) => (releaseWrite = resolve))
			const writeStarted = new Promise<void>((resolve) => (markWriting = resolve))
			update.mockImplementation(async (key) => {
				if (key === deferredKey) {
					markWriting()
					await writing
				}
			})
			const provider = Object.assign(fixture.provider, { contextProxy })
			const save = webviewMessageHandler(provider, {
				type: "updateSettings",
				updatedSettings: { autoSteer: false, followupAutoApproveTimeoutMs: 0 },
			})

			try {
				await writeStarted
				// A new question arrives after revocation, so its policy must read the newly published cache.
				const approval = await checkAutoApproval({
					state: {
						approvalMode: "bypass",
						followupAutoApproveTimeoutMs: contextProxy.getValue("followupAutoApproveTimeoutMs"),
					},
					ask: "followup",
					text: JSON.stringify({ question: "A later question", suggest: [{ answer: "Use the default" }] }),
				})
				expect(approval).toEqual({ decision: "ask" })
				expect(fixture.postStateToWebview).not.toHaveBeenCalled()
			} finally {
				releaseWrite()
				await save
				fixture.cleanup()
			}

			expect(update.mock.calls.filter(([key]) => key === "followupAutoApproveTimeoutMs")).toEqual([
				["followupAutoApproveTimeoutMs", 0],
			])
		},
	)

	it.each([0, 90_000, undefined])(
		"revokes every host question timer before any settings write settles when the timeout changes to %s",
		async (followupAutoApproveTimeoutMs) => {
			const fixture = hostFixture()
			let releaseWrite!: () => void
			const writing = new Promise<void>((resolve) => (releaseWrite = resolve))
			fixture.contextProxy.setValue.mockReturnValueOnce(writing)
			const save = webviewMessageHandler(fixture.provider, {
				type: "updateSettings",
				// Settings Save sends other fields first; their persistence must not delay revocation.
				updatedSettings: { autoSteer: false, followupAutoApproveTimeoutMs },
			})

			try {
				expect(fixture.contextProxy.setValue).toHaveBeenCalledExactlyOnceWith(
					"followupAutoApproveTimeoutMs",
					followupAutoApproveTimeoutMs,
				)
				expect(fixture.postStateToWebview).not.toHaveBeenCalled()
				for (const question of fixture.questions) {
					expect(question.cancelAutoApprovalTimeout).toHaveBeenCalledExactlyOnceWith(true)
					expect(question.abortTask).not.toHaveBeenCalled()
				}
				expect(fixture.sidebar.getOwner("editor-question")).toBe(fixture.editor)
				expect(fixture.sidebar.getActiveTaskId()).toBe("visible-question")
				expect(fixture.editor.getActiveTaskId()).toBe("editor-question")
				expect(fixture.unrelated.cancelAutoApprovalTimeout).not.toHaveBeenCalled()
				vi.advanceTimersByTime(5_000)
				for (const question of fixture.questions) expect(question.autoAnswer).not.toHaveBeenCalled()
				expect(fixture.unrelated.autoAnswer).toHaveBeenCalledOnce()
			} finally {
				releaseWrite()
				await save
				fixture.cleanup()
			}

			expect(fixture.contextProxy.setValue.mock.calls).toEqual([
				["followupAutoApproveTimeoutMs", followupAutoApproveTimeoutMs],
				["autoSteer", false],
			])
			expect(fixture.postStateToWebview).toHaveBeenCalledOnce()
		},
	)

	it.each([
		{ previousTimeout: 60_000, updatedSettings: { autoSteer: false } },
		{ previousTimeout: 60_000, updatedSettings: { followupAutoApproveTimeoutMs: 60_000 } },
		{ previousTimeout: 0, updatedSettings: { followupAutoApproveTimeoutMs: 0 } },
	])(
		"preserves question timers when the timeout does not change: %j",
		async ({ previousTimeout, updatedSettings }) => {
			const fixture = hostFixture(previousTimeout)
			try {
				await webviewMessageHandler(fixture.provider, { type: "updateSettings", updatedSettings })

				expect(fixture.getLiveTaskIds).not.toHaveBeenCalled()
				for (const question of fixture.questions) {
					expect(question.cancelAutoApprovalTimeout).not.toHaveBeenCalled()
					expect(question.abortTask).not.toHaveBeenCalled()
				}
				expect(fixture.postStateToWebview).toHaveBeenCalledOnce()
			} finally {
				fixture.cleanup()
			}
		},
	)
})
