import { describe, expect, it } from "vitest"
import {
	agentLifecycleSnapshotSchema,
	type AgentLifecycleSnapshot,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

import { TaskSessionRegistry } from "../TaskSessionRegistry"
import type { Task } from "../../task/Task"

const createTask = (taskId: string, overrides: Partial<Task> = {}): Task =>
	({
		taskId,
		taskStatus: TaskStatus.Running,
		isStreaming: true,
		taskAsk: undefined,
		clineMessages: [{ ts: 100, type: "say", say: "text", text: taskId }],
		tokenUsage: {
			totalTokensIn: 1,
			totalTokensOut: 2,
			totalCost: 0.03,
			contextTokens: 3,
		},
		...overrides,
	}) as Task

const createLifecycleSnapshot = (
	taskId: string,
	overrides: Partial<AgentLifecycleSnapshot> = {},
): AgentLifecycleSnapshot =>
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

describe("TaskSessionRegistry", () => {
	it("tracks live tasks and explicit active focus", () => {
		const registry = new TaskSessionRegistry(3)
		const taskA = createTask("task-a")
		const taskB = createTask("task-b", { isStreaming: false })

		registry.register(taskA)
		registry.register(taskB)

		expect(registry.getLiveTaskIds()).toEqual(["task-a", "task-b"])
		expect(registry.getActiveTask()?.taskId).toBe("task-b")

		registry.focus("task-a")
		expect(registry.getActiveTask()?.taskId).toBe("task-a")

		const metadata = registry.getMetadata()
		expect(metadata["task-a"]).toMatchObject({
			id: "task-a",
			isActive: true,
			isStreaming: true,
			lifecycle: TaskLifecycleState.Initializing,
			status: TaskStatus.Running,
			queueCount: 0,
			tokensIn: 1,
			tokensOut: 2,
			totalCost: 0.03,
		})
		expect(metadata["task-b"]).toMatchObject({
			id: "task-b",
			isActive: false,
			isStreaming: false,
		})
	})

	it("enforces the configured live task cap", () => {
		const registry = new TaskSessionRegistry(1)

		expect(registry.canCreateTask()).toBe(true)
		registry.register(createTask("task-a"))
		expect(registry.canCreateTask()).toBe(false)
		expect(registry.getAvailableTaskCapacity()).toBe(0)
	})

	it("updates the live task cap at runtime", () => {
		const registry = new TaskSessionRegistry(1)

		registry.register(createTask("task-a"))
		expect(registry.canCreateTask()).toBe(false)

		registry.setMaxLiveTasks(2)

		expect(registry.getMaxLiveTasks()).toBe(2)
		expect(registry.canCreateTask()).toBe(true)
	})

	it("does not count terminal task sessions against the live task cap", () => {
		const registry = new TaskSessionRegistry(1)

		registry.register(createTask("task-a"))
		registry.markLifecycle("task-a", TaskLifecycleState.Completed)

		expect(registry.getLiveTaskCount()).toBe(0)
		expect(registry.canCreateTask()).toBe(true)
		expect(registry.getMetadata()["task-a"]).toMatchObject({
			lifecycle: TaskLifecycleState.Completed,
		})
	})

	it("keeps completion-result candidates live and waiting for review", () => {
		const registry = new TaskSessionRegistry(1)

		registry.register(
			createTask("task-a", {
				isStreaming: false,
				taskAsk: { ts: 101, type: "ask", ask: "completion_result" },
			} as Partial<Task>),
		)
		registry.markLifecycle("task-a", TaskLifecycleState.Waiting, "completion")

		expect(registry.getLiveTaskIds()).toEqual(["task-a"])
		expect(registry.getLiveTaskCount()).toBe(1)
		expect(registry.canCreateTask()).toBe(false)
		expect(registry.canAcceptInput("task-a")).toBe(true)
		expect(registry.getMetadata()["task-a"]).toMatchObject({
			lifecycle: TaskLifecycleState.Waiting,
			isWaitingForInput: true,
			waitingReason: "completion",
		})
	})

	it("keeps persisted resume-completed asks terminal", () => {
		const registry = new TaskSessionRegistry(1)

		registry.register(
			createTask("task-a", {
				isStreaming: false,
				taskAsk: { ts: 101, type: "ask", ask: "resume_completed_task" },
			} as Partial<Task>),
		)
		registry.markLifecycle("task-a", TaskLifecycleState.Waiting, "resumable")

		expect(registry.getLiveTaskCount()).toBe(0)
		expect(registry.canCreateTask()).toBe(true)
		expect(registry.getMetadata()["task-a"]).toMatchObject({
			lifecycle: TaskLifecycleState.Completed,
			isWaitingForInput: false,
			waitingReason: undefined,
		})
	})

	it("does not expose stale follow-up asks on completed tasks as waiting input", () => {
		const registry = new TaskSessionRegistry(1)

		registry.register(
			createTask("task-a", {
				isStreaming: false,
				taskAsk: { ts: 101, type: "ask", ask: "followup", text: "Still need input?" },
			} as Partial<Task>),
		)
		registry.markLifecycle("task-a", TaskLifecycleState.Completed)

		expect(registry.getLiveTaskIds()).toEqual([])
		expect(registry.getLiveTaskCount()).toBe(0)
		expect(registry.canCreateTask()).toBe(true)
		expect(registry.canAcceptInput("task-a")).toBe(false)
		expect(registry.getMetadata()["task-a"]).toMatchObject({
			lifecycle: TaskLifecycleState.Completed,
			isWaitingForInput: false,
			waitingReason: undefined,
		})
	})

	it("counts a completed task again when it becomes active with feedback", () => {
		const registry = new TaskSessionRegistry(1)
		const task = createTask("task-a", {
			isStreaming: false,
			taskAsk: { ts: 101, type: "ask", ask: "completion_result" },
		} as Partial<Task>)

		registry.register(task)
		registry.markLifecycle("task-a", TaskLifecycleState.Waiting, "completion")
		expect(registry.canCreateTask()).toBe(false)
		;(task as any).taskAsk = undefined
		registry.markLifecycle("task-a", TaskLifecycleState.Running)

		expect(registry.getLiveTaskIds()).toEqual(["task-a"])
		expect(registry.getLiveTaskCount()).toBe(1)
		expect(registry.canCreateTask()).toBe(false)
	})

	it("tracks waiting reason and queued message count in metadata", () => {
		const registry = new TaskSessionRegistry(3)
		registry.register(
			createTask("task-a", {
				taskAsk: { ts: 101, type: "ask", ask: "tool" },
				messageQueueService: {
					messages: [
						{ id: "queued-1", text: "one", images: [] },
						{ id: "queued-2", text: "two", images: [] },
					],
				},
			} as unknown as Partial<Task>),
		)

		registry.markLifecycle("task-a", TaskLifecycleState.Waiting, "interactive")

		expect(registry.getMetadata()["task-a"]).toMatchObject({
			lifecycle: TaskLifecycleState.Waiting,
			isWaitingForInput: true,
			waitingReason: "interactive",
			queueCount: 2,
		})
	})

	it("projects canonical waiting status instead of retaining a stale running task status", () => {
		const registry = new TaskSessionRegistry(1)
		registry.register(createTask("task-canonical-waiting"))
		registry.markLifecycleSnapshot(
			"task-canonical-waiting",
			createLifecycleSnapshot("task-canonical-waiting", { phase: "awaiting_approval" }),
		)

		expect(registry.getMetadata()["task-canonical-waiting"]).toMatchObject({
			status: TaskStatus.Interactive,
			lifecycle: TaskLifecycleState.Waiting,
			isWaitingForInput: true,
			waitingReason: "awaiting_approval",
		})
	})

	it("projects canonical completion consistently even when the Task still reports running", () => {
		const registry = new TaskSessionRegistry(1)
		registry.register(createTask("task-canonical-complete"))
		registry.markLifecycleSnapshot(
			"task-canonical-complete",
			createLifecycleSnapshot("task-canonical-complete", {
				status: "completed",
				phase: "finalizing",
				lastSequence: 1,
				terminalEventId: "complete-event",
				terminalAt: 101,
				processedEvents: [{ eventId: "complete-event", sequence: 1, fingerprint: "complete" }],
			}),
		)

		expect(registry.getLiveTaskIds()).toEqual([])
		expect(registry.getMetadata()["task-canonical-complete"]).toMatchObject({
			status: TaskStatus.Idle,
			lifecycle: TaskLifecycleState.Completed,
			isWaitingForInput: false,
			waitingReason: undefined,
		})
	})

	it("falls back to legacy task status while lifecycle persistence is degraded", () => {
		const registry = new TaskSessionRegistry(1)
		const task = createTask("task-degraded")
		const completed = createLifecycleSnapshot("task-degraded", {
			status: "completed",
			phase: "finalizing",
			lastSequence: 1,
			terminalEventId: "complete-event",
			terminalAt: 101,
			processedEvents: [{ eventId: "complete-event", sequence: 1, fingerprint: "complete" }],
		})

		registry.register(task)
		registry.markLifecycleSnapshot(task.taskId, completed)
		registry.markLifecycleDegraded(task.taskId)

		expect(registry.isLifecycleDegraded(task.taskId)).toBe(true)
		expect(registry.getLiveTaskIds()).toEqual([task.taskId])
		expect(registry.getMetadata()[task.taskId]).toMatchObject({
			status: TaskStatus.Running,
			lifecycle: TaskLifecycleState.Running,
			isWaitingForInput: false,
		})
		// Keep the canonical snapshot available for recovery, but do not let it
		// override the legacy projection until an authoritative resync succeeds.
		expect(registry.getLifecycleSnapshot(task.taskId)?.status).toBe("completed")

		registry.clearLifecycleDegraded(task.taskId)
		expect(registry.isLifecycleDegraded(task.taskId)).toBe(false)
		expect(registry.getLiveTaskIds()).toEqual([])
		expect(registry.getMetadata()[task.taskId].lifecycle).toBe(TaskLifecycleState.Completed)
	})

	it("can clear focus without removing background tasks", () => {
		const registry = new TaskSessionRegistry(3)
		registry.register(createTask("task-a"))

		registry.clearFocus()

		expect(registry.getActiveTask()).toBeUndefined()
		expect(registry.getLiveTaskIds()).toEqual(["task-a"])
	})

	it("does not focus terminal sessions when unregistering the active task", () => {
		const registry = new TaskSessionRegistry(3)

		registry.register(createTask("completed-task"))
		registry.markLifecycle("completed-task", TaskLifecycleState.Completed)
		registry.register(createTask("running-task"))

		registry.unregister("running-task")

		expect(registry.getActiveTask()).toBeUndefined()
		expect(registry.getLiveTaskIds()).toEqual([])
	})

	it("falls back to another live task when unregistering the active task", () => {
		const registry = new TaskSessionRegistry(3)

		registry.register(createTask("completed-task"))
		registry.markLifecycle("completed-task", TaskLifecycleState.Completed)
		registry.register(createTask("running-task-a"))
		registry.register(createTask("running-task-b"))

		registry.unregister("running-task-b")

		expect(registry.getActiveTask()?.taskId).toBe("running-task-a")
		expect(registry.getLiveTaskIds()).toEqual(["running-task-a"])
	})
})
