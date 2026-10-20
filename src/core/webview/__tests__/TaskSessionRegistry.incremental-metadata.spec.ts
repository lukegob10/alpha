import { describe, expect, it, vi } from "vitest"
import {
	agentLifecycleSnapshotSchema,
	type AgentLifecycleSnapshot,
	type AlphaMessage,
	type ExtensionMessage,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

import type { Task } from "../../task/Task"
import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

const createTask = (taskId: string, overrides: Partial<Task> = {}): Task =>
	({
		taskId,
		taskKind: "primary",
		taskStatus: TaskStatus.Running,
		isStreaming: true,
		clineMessages: [{ ts: 100, type: "say", say: "text", text: taskId }],
		metadata: { task: taskId },
		api: {
			getModel: vi.fn(() => ({ id: "fixture", info: { contextWindow: 200_000, maxTokens: 10_000 } })),
		},
		tokenUsage: { totalTokensIn: 10, totalTokensOut: 2, totalCost: 0.03, contextTokens: 12 },
		...overrides,
	}) as unknown as Task

const createSnapshot = (taskId: string, overrides: Partial<AgentLifecycleSnapshot> = {}): AgentLifecycleSnapshot =>
	agentLifecycleSnapshotSchema.parse({
		version: 1,
		taskId,
		runId: `run-${taskId}`,
		turnId: `turn-${taskId}`,
		status: "in_progress",
		phase: "working",
		lastSequence: 0,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: [],
		...overrides,
	})

describe("incremental task metadata", () => {
	it("projects only the requested chat among fifty registered chats", () => {
		const registry = new TaskSessionRegistry(50)
		const tasks = Array.from({ length: 50 }, (_, index) => createTask(`task-${index}`))
		for (const task of tasks) registry.register(task, { lifecycleSnapshot: createSnapshot(task.taskId) })

		expect(registry.getMetadataForTask("task-0")).toMatchObject({
			id: "task-0",
			tokensIn: 10,
			tokensOut: 2,
			lifecycle: TaskLifecycleState.Running,
		})
		expect(tasks[0].api.getModel).toHaveBeenCalledOnce()
		for (const task of tasks.slice(1)) expect(task.api.getModel).not.toHaveBeenCalled()
	})

	it("does not inspect another chat when the requested runtime is missing", () => {
		const registry = new TaskSessionRegistry()
		const task = createTask("existing")
		registry.register(task)

		expect(registry.getMetadataForTask("missing")).toBeUndefined()
		expect(task.api.getModel).not.toHaveBeenCalled()
	})

	it.each(["running", "waiting", "legacy", "degraded", "terminal"] as const)(
		"preserves the existing %s metadata contract",
		(state) => {
			const registry = new TaskSessionRegistry()
			const ask: AlphaMessage = { ts: 101, type: "ask", ask: "followup", text: "Continue?" }
			const task = createTask("target", {
				...(state === "legacy" || state === "degraded" ? { taskAsk: ask } : {}),
				orchestrationParentTaskId: "root",
				orchestrationWorkspaceMode: "worktree",
			})
			registry.register(task, {
				lifecycleSnapshot:
					state === "legacy"
						? undefined
						: createSnapshot(task.taskId, { phase: state === "waiting" ? "awaiting_approval" : "working" }),
			})
			if (state === "degraded") registry.markLifecycleDegraded(task.taskId)
			if (state === "terminal") registry.markLifecycle(task.taskId, TaskLifecycleState.Completed)
			const metadata = registry.getMetadataForTask(task.taskId)

			expect(metadata).toEqual(registry.getMetadata()[task.taskId])
			expect(metadata).toMatchObject({
				id: task.taskId,
				orchestrationParentTaskId: "root",
				orchestrationWorkspaceMode: "worktree",
				orchestrationObjective: task.metadata.task,
				isWaitingForInput: state === "waiting" || state === "legacy" || state === "degraded",
				isActive: true,
			})
		},
	)

	it("reads current queue, usage, transcript revision, and turn controls without a cache", () => {
		const registry = new TaskSessionRegistry()
		const task = createTask("target", {
			isTurnActive: () => true,
			canInterruptCurrentTurn: () => true,
			hasPendingSteerMessage: () => false,
		})
		registry.register(task)
		const before = registry.getMetadataForTask(task.taskId)
		const revision = registry.markTranscriptChanged(task.taskId)
		Object.assign(task, {
			isStreaming: false,
			tokenUsage: { totalTokensIn: 20, totalTokensOut: 5, totalCost: 0.06, contextTokens: 25 },
			queuedMessages: [{ id: "queued", text: "Continue", images: [], timestamp: 102 }],
			isTurnActive: () => false,
			canInterruptCurrentTurn: () => false,
			hasPendingSteerMessage: () => true,
		})
		const after = registry.getMetadataForTask(task.taskId)

		expect(before).toMatchObject({ tokensIn: 10, queueCount: 0, canInterrupt: true, hasPendingSteer: false })
		expect(after).toEqual(registry.getMetadata()[task.taskId])
		expect(after).toMatchObject({
			tokensIn: 20,
			tokensOut: 5,
			totalCost: 0.06,
			queueCount: 1,
			transcriptRevision: revision,
			isStreaming: false,
			isTurnActive: false,
			canInterrupt: false,
			hasPendingSteer: true,
		})
	})

	it("keeps each view's selection when projecting a task owned by the same host", () => {
		const storage = "incremental-metadata-view-focus"
		const sidebar = TaskSessionRegistry.forGlobalStorage(storage)
		const editor = TaskSessionRegistry.forGlobalStorage(storage)
		const first = createTask("first")
		const second = createTask("second")
		try {
			sidebar.register(first)
			editor.register(second)
			expect(sidebar.getMetadataForTask(first.taskId)?.isActive).toBe(true)
			expect(editor.getMetadataForTask(first.taskId)?.isActive).toBe(false)
			expect(editor.getMetadataForTask(second.taskId)?.isActive).toBe(true)
			expect(sidebar.getMetadataForTask(second.taskId)?.isActive).toBe(false)
			editor.focus(first.taskId)
			expect(editor.getMetadataForTask(first.taskId)).toEqual(editor.getMetadata()[first.taskId])
			expect(sidebar.getActiveTaskId()).toBe(first.taskId)
		} finally {
			sidebar.disposeView()
			editor.disposeView()
		}
	})

	it("publishes an incremental message without projecting unrelated model metadata", async () => {
		const taskSessions = new TaskSessionRegistry(50)
		const tasks = Array.from({ length: 50 }, (_, index) => createTask(`task-${index}`))
		for (const task of tasks) taskSessions.register(task, { lifecycleSnapshot: createSnapshot(task.taskId) })
		const target = tasks[0]
		const post = vi.fn(async (_message: ExtensionMessage) => undefined)
		const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
			taskSessions,
			currentView: { type: "task", taskId: target.taskId },
			clineMessagesSeq: 0,
			publishedTaskTranscriptRevisions: new Map(),
			getHostProviders: () => [provider],
			postMessageToWebview: post,
			htmlDocumentAutoOpen: { handle: vi.fn(async () => undefined) },
		})

		await provider.postTaskMessageToWebview("messageUpdated", target.taskId, target.clineMessages[0])

		expect(post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "messageUpdated",
				taskId: target.taskId,
				clineMessagesSeq: 1,
				liveTask: expect.objectContaining({ id: target.taskId, tokensIn: 10 }),
			}),
		)
		expect(target.api.getModel).toHaveBeenCalledOnce()
		for (const task of tasks.slice(1)) expect(task.api.getModel).not.toHaveBeenCalled()
	})
})
