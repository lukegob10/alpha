import {
	agentLifecycleSnapshotSchema,
	AlphaCodeEventName,
	TaskLifecycleState,
	TaskStatus,
	type AgentLifecycleSnapshot,
	type AlphaMessage,
} from "@alpha-code/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../../task/Task"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

function createRecoveryTask(registry: TaskSessionRegistry) {
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "published-recovery",
		instanceId: "published-recovery-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isWaitingForFirstChunk: false,
		isStreaming: false,
		clineMessages: [{ ts: 100, type: "say", say: "error", text: "The turn failed." }] as AlphaMessage[],
		apiConversationHistory: [],
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => undefined },
		addToAlphaMessages: vi.fn(async (message: AlphaMessage) => task.clineMessages.push(message)),
		saveAlphaMessages: vi.fn(async () => undefined),
		updateAlphaMessage: vi.fn(async () => undefined),
		cancelAutoApprovalTimeout: vi.fn(),
		checkpointSave: vi.fn(async () => undefined),
		getTokenUsage: vi.fn(() => ({ totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, contextTokens: 0 })),
		emit: vi.fn((event: AlphaCodeEventName) => {
			if (event === AlphaCodeEventName.TaskResumable) {
				registry.markLifecycle(task.taskId, TaskLifecycleState.Waiting, "resumable")
			} else if (event === AlphaCodeEventName.TaskActive) {
				registry.markLifecycle(task.taskId, TaskLifecycleState.Running)
			}
		}),
	}) as Task
	return task
}

function terminalSnapshot(taskId: string, status: AgentLifecycleSnapshot["status"]) {
	return agentLifecycleSnapshotSchema.parse({
		version: 1,
		taskId,
		runId: "run-1",
		turnId: "turn-1",
		status,
		phase: "finalizing",
		lastSequence: 1,
		terminalEventId: "terminal-1",
		terminalAt: 100,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: [{ eventId: "terminal-1", sequence: 1, fingerprint: "terminal" }],
	})
}

describe("TaskSessionRegistry published recovery ownership", () => {
	it.each(["failed", "interrupted"] as const)(
		"projects an owned resume ask before the delayed attention status for a %s turn",
		async (status) => {
			vi.useFakeTimers()
			const registry = new TaskSessionRegistry(2)
			const task = createRecoveryTask(registry)
			registry.register(task, { focus: false })
			registry.markLifecycle(task.taskId, TaskLifecycleState.Running)
			registry.markLifecycleSnapshot(task.taskId, terminalSnapshot(task.taskId, status))
			const pending = task.ask("resume_task", "Resume with new guidance", false)
			void pending.catch(() => undefined)
			try {
				await vi.waitFor(() => expect(task.clineMessages.at(-1)?.ask).toBe("resume_task"))
				expect(task.getActiveAskTimestamp()).toBe(task.clineMessages.at(-1)?.ts)
				expect(task.taskAsk).toBeUndefined()
				expect(task.emit).not.toHaveBeenCalledWith(AlphaCodeEventName.TaskResumable, task.taskId)
				expect(registry.getLifecycleSnapshot(task.taskId)?.status).toBe(status)
				expect(registry.getMetadata()[task.taskId]).toMatchObject({
					status: TaskStatus.Resumable,
					lifecycle: TaskLifecycleState.Waiting,
					isWaitingForInput: true,
					waitingReason: "resumable",
					isActive: false,
					isTurnActive: false,
					canInterrupt: false,
				})
				expect(registry.canAcceptInput(task.taskId)).toBe(true)

				await vi.advanceTimersByTimeAsync(2_000)
				expect(task.taskAsk?.ask).toBe("resume_task")
				expect(registry.getMetadata()[task.taskId].lifecycle).toBe(TaskLifecycleState.Waiting)
			} finally {
				task.abort = true
				await vi.advanceTimersByTimeAsync(100)
				await pending.catch(() => undefined)
				vi.useRealTimers()
			}
		},
	)

	it("does not keep an answered follow-up waiting while the ask response settles", async () => {
		vi.useFakeTimers()
		const registry = new TaskSessionRegistry(2)
		const task = createRecoveryTask(registry)
		registry.register(task)
		registry.markLifecycle(task.taskId, TaskLifecycleState.Running)
		registry.markLifecycleSnapshot(task.taskId, terminalSnapshot(task.taskId, "failed"))
		const pending = task.ask("followup", "Which repair should continue?", false)
		void pending.catch(() => undefined)
		try {
			await vi.waitFor(() => expect(task.clineMessages.at(-1)?.ask).toBe("followup"))
			const askTs = task.getActiveAskTimestamp()
			expect(registry.getMetadata()[task.taskId].isWaitingForInput).toBe(true)
			expect(task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, undefined, askTs)).toBe(true)
			expect(task.clineMessages.at(-1)?.isAnswered).toBe(true)
			expect(task.getActiveAskTimestamp()).toBe(askTs)
			expect(registry.getMetadata()[task.taskId]).toMatchObject({
				lifecycle: TaskLifecycleState.Running,
				isWaitingForInput: false,
				waitingReason: undefined,
			})
			await vi.advanceTimersByTimeAsync(100)
			await expect(pending).resolves.toMatchObject({ response: "yesButtonClicked" })
			expect(task.getActiveAskTimestamp()).toBeUndefined()
			expect(registry.getLifecycleSnapshot(task.taskId)?.status).toBe("failed")
		} finally {
			task.abort = true
			await vi.advanceTimersByTimeAsync(100)
			await pending.catch(() => undefined)
			vi.useRealTimers()
		}
	})

	it("ignores a superseded ask identity before its pending waiter releases", async () => {
		vi.useFakeTimers()
		const registry = new TaskSessionRegistry(2)
		const task = createRecoveryTask(registry)
		registry.register(task)
		registry.markLifecycle(task.taskId, TaskLifecycleState.Running)
		registry.markLifecycleSnapshot(task.taskId, terminalSnapshot(task.taskId, "interrupted"))
		const pending = task.ask("resume_task", "Old recovery question", false)
		void pending.catch(() => undefined)
		try {
			await vi.waitFor(() => expect(task.clineMessages.at(-1)?.ask).toBe("resume_task"))
			const askTs = task.getActiveAskTimestamp()
			task.supersedePendingAsk()
			expect(task.getActiveAskTimestamp()).toBe(askTs)
			expect(task.lastMessageTs).not.toBe(askTs)
			expect(registry.getMetadata()[task.taskId]).toMatchObject({
				lifecycle: TaskLifecycleState.Running,
				isWaitingForInput: false,
				waitingReason: undefined,
			})
			await vi.advanceTimersByTimeAsync(100)
			await expect(pending).rejects.toThrow("superseded")
			expect(task.getActiveAskTimestamp()).toBeUndefined()
			expect(registry.getLifecycleSnapshot(task.taskId)?.status).toBe("interrupted")
		} finally {
			task.abort = true
			await vi.advanceTimersByTimeAsync(100)
			await pending.catch(() => undefined)
			vi.useRealTimers()
		}
	})

	it("keeps historical recovery asks out of a subsequent live turn", async () => {
		vi.useFakeTimers()
		const registry = new TaskSessionRegistry(2)
		const task = createRecoveryTask(registry)
		registry.register(task, { focus: false })
		registry.markLifecycle(task.taskId, TaskLifecycleState.Running)
		registry.markLifecycleSnapshot(task.taskId, terminalSnapshot(task.taskId, "failed"))
		const pending = task.ask("resume_task", "Resume the failed turn", false)
		void pending.catch(() => undefined)
		try {
			await vi.waitFor(() => expect(task.clineMessages.at(-1)?.ask).toBe("resume_task"))
			await vi.advanceTimersByTimeAsync(2_000)
			expect(task.taskAsk?.ask).toBe("resume_task")
			expect(task.handleWebviewAskResponse("yesButtonClicked")).toBe(true)
			await vi.advanceTimersByTimeAsync(100)
			await expect(pending).resolves.toMatchObject({ response: "yesButtonClicked" })
			expect(task.taskAsk).toBeUndefined()
			expect(task.getActiveAskTimestamp()).toBeUndefined()
			expect(task.clineMessages.at(-1)?.ask).toBe("resume_task")
			expect(registry.getLifecycleSnapshot(task.taskId)?.status).toBe("failed")
			expect(registry.getMetadata()[task.taskId]).toMatchObject({
				lifecycle: TaskLifecycleState.Running,
				isWaitingForInput: false,
				waitingReason: undefined,
			})

			Object.assign(task, { isAgentTurnEngineActive: true })
			registry.markLifecycleSnapshot(
				task.taskId,
				agentLifecycleSnapshotSchema.parse({
					...terminalSnapshot(task.taskId, "failed"),
					turnId: "turn-2",
					status: "in_progress",
					phase: "working",
					lastSequence: 0,
					processedEvents: [],
					terminalAt: undefined,
					terminalEventId: undefined,
				}),
			)
			expect(registry.getMetadata()[task.taskId]).toMatchObject({
				lifecycle: TaskLifecycleState.Running,
				status: TaskStatus.Running,
				isWaitingForInput: false,
				isTurnActive: true,
				canInterrupt: true,
				isActive: false,
			})
			expect(registry.getLifecycleSnapshot(task.taskId)).toMatchObject({
				turnId: "turn-2",
				status: "in_progress",
			})
		} finally {
			task.abort = true
			await vi.advanceTimersByTimeAsync(100)
			await pending.catch(() => undefined)
			vi.useRealTimers()
		}
	})

	it.each([TaskLifecycleState.Completed, TaskLifecycleState.Failed, TaskLifecycleState.Closed])(
		"preserves an explicit %s task lifecycle and rejects input after cancellation",
		async (lifecycle) => {
			vi.useFakeTimers()
			const registry = new TaskSessionRegistry(2)
			const task = createRecoveryTask(registry)
			registry.register(task, { focus: false })
			registry.markLifecycle(task.taskId, TaskLifecycleState.Running)
			registry.markLifecycleSnapshot(task.taskId, terminalSnapshot(task.taskId, "failed"))
			const pending = task.ask("resume_task", "A pending recovery question", false)
			void pending.catch(() => undefined)
			try {
				await vi.waitFor(() => expect(task.clineMessages.at(-1)?.ask).toBe("resume_task"))
				await vi.advanceTimersByTimeAsync(2_000)
				expect(task.taskAsk?.ask).toBe("resume_task")
				registry.markLifecycle(task.taskId, lifecycle)
				expect(registry.getMetadata()[task.taskId]).toMatchObject({
					lifecycle,
					status: TaskStatus.Idle,
					isWaitingForInput: false,
					waitingReason: undefined,
				})
				task.abort = true
				expect(registry.getMetadata()[task.taskId].lifecycle).toBe(lifecycle)
				expect(registry.canAcceptInput(task.taskId)).toBe(false)
				await vi.advanceTimersByTimeAsync(100)
				await expect(pending).rejects.toThrow("aborted")
				expect(task.getActiveAskTimestamp()).toBeUndefined()
				expect(task.taskAsk?.ask).toBe("resume_task")
				expect(registry.canAcceptInput(task.taskId)).toBe(false)
				expect(registry.getLifecycleSnapshot(task.taskId)?.status).toBe("failed")
			} finally {
				task.abort = true
				await vi.advanceTimersByTimeAsync(100)
				await pending.catch(() => undefined)
				vi.useRealTimers()
			}
		},
	)
})
