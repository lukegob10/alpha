import { describe, expect, it, vi } from "vitest"
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

let nextHostId = 0
const createHostViews = (maxLiveTasks = 3) => {
	const storage = `task-session-registry-tests/host-${++nextHostId}`
	return {
		storage,
		sidebar: TaskSessionRegistry.forGlobalStorage(storage, maxLiveTasks),
		panel: TaskSessionRegistry.forGlobalStorage(storage, maxLiveTasks),
	}
}

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("host task ownership", () => {
	it("reserves prepared child capacity across views and roots before any child starts", () => {
		const { sidebar, panel } = createHostViews(3)
		sidebar.register(createTask("parent"))
		const options = {
			rootTaskId: "parent",
			count: 1,
			maxTotalTasks: 3,
			maxRootTasks: 1,
			activeRootTasks: 0,
			isRootTaskRegistered: () => false,
		}
		sidebar.reserveTaskSlots("first-group", options)
		expect(() => panel.reserveTaskSlots("same-root", options)).toThrow("root-wide child capacity")
		panel.reserveTaskSlots("other-root", { ...options, rootTaskId: "other" })
		expect(sidebar.canCreateTask()).toBe(false)
		expect(() => sidebar.reserveTaskSlots("over-capacity", { ...options, rootTaskId: "third" })).toThrow(
			"task capacity",
		)
		expect(() => panel.releaseTaskSlots("first-group")).toThrow("current owner")
		sidebar.releaseTaskSlots("first-group")
		expect(panel.getAvailableTaskCapacity()).toBe(1)
	})

	it("does not count registered child or control identities twice against a reservation", () => {
		const { sidebar, panel } = createHostViews(3)
		const controls = new Set<string>()
		const isRootTaskRegistered = (taskId: string) => controls.has(taskId)
		sidebar.reserveTaskSlots("group", {
			rootTaskId: "parent",
			count: 1,
			maxTotalTasks: 3,
			maxRootTasks: 2,
			activeRootTasks: 0,
			isRootTaskRegistered,
		})
		sidebar.setReservedTaskIds("group", ["child"])
		expect(panel.getReservedTaskSlots("parent", isRootTaskRegistered)).toEqual({ total: 1, root: 1 })
		controls.add("child")
		expect(panel.getReservedTaskSlots("parent", isRootTaskRegistered)).toEqual({ total: 1, root: 0 })
		sidebar.register(createTask("child"), { focus: false })
		expect(panel.getReservedTaskSlots("parent", isRootTaskRegistered)).toEqual({ total: 0, root: 0 })
		expect(panel.getAvailableTaskCapacity()).toBe(2)
		sidebar.releaseTaskSlots("group")
		sidebar.releaseTaskSlots("group")
	})

	it("shares canonical tasks, capacity and lifecycle without sharing view selection", () => {
		const { sidebar, panel } = createHostViews(2)
		const first = createTask("first")
		const second = createTask("second")
		sidebar.register(first)
		panel.register(second)

		expect(sidebar.getTask("second")).toBe(second)
		expect(panel.getTask("first")).toBe(first)
		expect(sidebar.getOwner("first")).toBe(sidebar)
		expect(panel.getOwnedTasks()).toEqual([second])
		expect(sidebar.getActiveTask()).toBe(first)
		expect(panel.getActiveTask()).toBe(second)
		expect(sidebar.canCreateTask()).toBe(false)
		expect(panel.getAvailableTaskCapacity()).toBe(0)

		sidebar.markLifecycle("first", TaskLifecycleState.Completed)
		panel.setMaxLiveTasks(3)
		expect(panel.getMetadata().first.lifecycle).toBe(TaskLifecycleState.Completed)
		expect(sidebar.getMaxLiveTasks()).toBe(3)
		expect(sidebar.getAvailableTaskCapacity()).toBe(2)
		panel.clearFocus()
		expect(sidebar.getActiveTask()).toBe(first)
		expect(panel.getActiveTask()).toBeUndefined()
	})

	it("does not share tasks or recovery across global storage identities", async () => {
		const firstHost = createHostViews()
		const secondHost = createHostViews()
		firstHost.sidebar.register(createTask("first"))
		expect(secondHost.sidebar.getTask("first")).toBeUndefined()
		const recoverFirst = vi.fn(async () => undefined)
		const recoverSecond = vi.fn(async () => undefined)
		await firstHost.sidebar.runStartupRecovery(recoverFirst)
		await secondHost.sidebar.runStartupRecovery(recoverSecond)
		expect(recoverFirst).toHaveBeenCalledOnce()
		expect(recoverSecond).toHaveBeenCalledOnce()
	})

	it("attaches the same Task to another view without replacing its owner or revision", () => {
		const { sidebar, panel } = createHostViews()
		const task = createTask("shared")
		sidebar.register(task)
		const revision = sidebar.markTranscriptChanged(task.taskId)
		panel.register(task)

		expect(panel.getOwner(task.taskId)).toBe(sidebar)
		expect(panel.getOwnedTasks()).toEqual([])
		expect(panel.getActiveTask()).toBe(task)
		expect(panel.getTranscriptRevision(task.taskId)).toBe(revision)
		expect(sidebar.getLiveTaskCount()).toBe(1)
	})

	it("rejects a second runtime for a registered stable ID", () => {
		const { sidebar, panel } = createHostViews()
		const task = createTask("shared")
		sidebar.register(task)
		expect(() => panel.register(createTask("shared"))).toThrow("already has a registered runtime owner")
		expect(sidebar.getTask(task.taskId)).toBe(task)
		expect(panel.getActiveTask()).toBeUndefined()
	})

	it("allows only the current owner to replace or release a runtime", () => {
		const { sidebar, panel } = createHostViews()
		const original = createTask("shared")
		const replacement = createTask("shared")
		sidebar.register(original)
		panel.focus(original.taskId)
		expect(() => panel.replaceTask(original, replacement)).toThrow("current session owner")
		expect(() => panel.unregister(original.taskId)).toThrow("current session owner")

		sidebar.replaceTask(original, replacement)
		expect(panel.getActiveTask()).toBe(replacement)
		expect(panel.getOwner(original.taskId)).toBe(sidebar)
		expect(() => sidebar.unregister(original.taskId, original)).toThrow("current session owner")
		sidebar.unregister(replacement.taskId, replacement)
		expect(panel.getActiveTask()).toBeUndefined()
		expect(sidebar.getOwnedTasks()).toEqual([])
	})

	it("serializes one task's ownership transitions across views while other tasks progress", async () => {
		const { sidebar, panel } = createHostViews()
		const entered = deferred()
		const finishFirst = deferred()
		const calls: string[] = []
		const first = sidebar.runOwnershipOperation("shared", async () => {
			calls.push("first")
			entered.resolve()
			await finishFirst.promise
		})
		await entered.promise
		const second = panel.runOwnershipOperation("shared", async () => {
			calls.push("second")
		})
		await panel.runOwnershipOperation("independent", async () => {
			calls.push("independent")
		})
		expect(calls).toEqual(["first", "independent"])
		finishFirst.resolve()
		await Promise.all([first, second])
		expect(calls).toEqual(["first", "independent", "second"])
	})

	it("runs startup recovery once and protects even terminal Tasks retained for cleanup", async () => {
		const { storage, sidebar, panel } = createHostViews()
		const task = createTask("retained")
		sidebar.register(task)
		sidebar.markLifecycle(task.taskId, TaskLifecycleState.Closed)
		const entered = deferred()
		const finishRecovery = deferred()
		const recover = vi.fn(async (hasOwner: (taskId: string) => boolean) => {
			expect(hasOwner(task.taskId)).toBe(true)
			expect(hasOwner("orphan")).toBe(false)
			entered.resolve()
			await finishRecovery.promise
		})
		const first = sidebar.runStartupRecovery(recover)
		await entered.promise
		const unexpectedRecovery = vi.fn(async () => undefined)
		const second = panel.runStartupRecovery(unexpectedRecovery)
		expect(second).toBe(first)
		finishRecovery.resolve()
		await Promise.all([first, second])
		await TaskSessionRegistry.forGlobalStorage(storage).runStartupRecovery(unexpectedRecovery)
		expect(recover).toHaveBeenCalledOnce()
		expect(unexpectedRecovery).not.toHaveBeenCalled()
	})

	it("does not rerun a failed startup recovery when a new view attaches", async () => {
		const { sidebar, panel } = createHostViews()
		await expect(
			sidebar.runStartupRecovery(async () => {
				throw new Error("recovery failed")
			}),
		).rejects.toThrow("recovery failed")
		const retry = vi.fn(async () => undefined)
		await expect(panel.runStartupRecovery(retry)).rejects.toThrow("recovery failed")
		expect(retry).not.toHaveBeenCalled()
	})

	it("retains cleanup ownership after failure and view disposal until a retry succeeds", async () => {
		const { sidebar, panel } = createHostViews(1)
		const task = createTask("cleanup")
		sidebar.register(task)
		panel.focus(task.taskId)
		await expect(
			sidebar.releaseAfterCleanup(task, async () => {
				throw new Error("process still live")
			}),
		).rejects.toThrow("process still live")
		sidebar.disposeView()
		expect(panel.getTask(task.taskId)).toBe(task)
		expect(panel.getOwner(task.taskId)).toBe(sidebar)
		expect(sidebar.getOwnedTasks()).toEqual([task])
		expect(panel.canCreateTask()).toBe(false)
		await sidebar.releaseAfterCleanup(task, async () => undefined)
		expect(panel.getTask(task.taskId)).toBeUndefined()
		expect(panel.getActiveTask()).toBeUndefined()
		expect(panel.canCreateTask()).toBe(true)
	})
})

describe("TaskSessionRegistry", () => {
	it("finds legacy ask state without cloning the task transcript", () => {
		const messages = new Proxy(
			[
				{ ts: 1, type: "say", say: "text", text: "prompt" },
				{ ts: 2, type: "ask", ask: "followup", text: "Question?" },
				{ ts: 3, type: "say", say: "text", text: "response" },
			] as Task["clineMessages"],
			{
				get(target, property, receiver) {
					if (property === Symbol.iterator) throw new Error("transcript must not be copied")
					return Reflect.get(target, property, receiver)
				},
			},
		)
		const registry = new TaskSessionRegistry(1)
		registry.register(createTask("legacy", { clineMessages: messages }))

		expect(registry.getMetadata().legacy).toMatchObject({
			status: TaskStatus.Interactive,
			isWaitingForInput: true,
			waitingReason: "interactive",
		})
	})

	it("advances transcript revisions when a live transcript changes", () => {
		const registry = new TaskSessionRegistry(1)
		registry.register(createTask("revision"))
		const initialRevision = registry.getTranscriptRevision("revision")

		const updatedRevision = registry.markTranscriptChanged("revision")

		expect(updatedRevision).toBeGreaterThan(initialRevision!)
		expect(registry.getMetadata().revision.transcriptRevision).toBe(updatedRevision)
	})

	it("projects each task's current provider input budget independently", () => {
		const registry = new TaskSessionRegistry(2)
		const model = (contextWindow: number) => ({
			id: "copilot-claude-opus-4.7",
			info: { contextWindow, maxTokens: 64_000, supportsPromptCache: false, contextWindowIncludesOutput: false },
		})
		const getModel = vi.fn(() => model(935_793))
		const task = createTask("extended", {
			api: { getModel, createMessage: vi.fn(), countTokens: vi.fn() },
		})
		registry.register(task)
		registry.register(
			createTask("standard", {
				api: { getModel: () => model(200_000), createMessage: vi.fn(), countTokens: vi.fn() },
			}),
		)
		expect(registry.getMetadata().extended.model).toEqual(model(935_793))
		expect(registry.getMetadata().standard.model).toEqual(model(200_000))
		getModel.mockReturnValue(model(199_793))
		expect(registry.getMetadata().extended.model).toEqual(model(199_793))
		registry.focus("extended")
		expect(registry.getMetadata().standard.model).toEqual(model(200_000))
	})

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

	it("keeps a task live when only its current canonical turn has completed", () => {
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

		expect(registry.getLiveTaskIds()).toEqual(["task-canonical-complete"])
		expect(registry.canAcceptInput("task-canonical-complete")).toBe(true)
		expect(registry.getMetadata()["task-canonical-complete"]).toMatchObject({
			status: TaskStatus.Running,
			lifecycle: TaskLifecycleState.Running,
			isWaitingForInput: false,
			waitingReason: undefined,
		})

		registry.markLifecycle("task-canonical-complete", TaskLifecycleState.Completed)
		registry.markLifecycleSnapshot(
			"task-canonical-complete",
			createLifecycleSnapshot("task-canonical-complete", {
				status: "completed",
				phase: "finalizing",
				lastSequence: 1,
				terminalEventId: "complete-event",
				terminalAt: 102,
				processedEvents: [{ eventId: "complete-event", sequence: 1, fingerprint: "complete" }],
			}),
		)

		expect(registry.getLiveTaskIds()).toEqual([])
		expect(registry.getMetadata()["task-canonical-complete"].lifecycle).toBe(TaskLifecycleState.Completed)
	})

	it("accepts a completion follow-up when the transcript ask arrives after the turn terminal event", () => {
		const registry = new TaskSessionRegistry(1)
		const task = createTask("task-completion-race", {
			isStreaming: false,
			taskAsk: undefined,
			clineMessages: [
				{ ts: 100, type: "say", say: "text", text: "Answer" },
				{ ts: 101, type: "ask", ask: "completion_result" },
			],
		} as Partial<Task>)
		registry.register(task)
		registry.markLifecycleSnapshot(
			task.taskId,
			createLifecycleSnapshot(task.taskId, {
				status: "completed",
				phase: "finalizing",
				lastSequence: 1,
				terminalEventId: "complete-event",
				terminalAt: 101,
				processedEvents: [{ eventId: "complete-event", sequence: 1, fingerprint: "complete" }],
			}),
		)

		expect(registry.canAcceptInput(task.taskId)).toBe(true)
		expect(registry.getLiveTaskIds()).toEqual([task.taskId])

		registry.markLifecycle(task.taskId, TaskLifecycleState.Waiting, "completion")
		registry.markLifecycleSnapshot(
			task.taskId,
			createLifecycleSnapshot(task.taskId, {
				status: "completed",
				phase: "finalizing",
				lastSequence: 1,
				terminalEventId: "complete-event",
				terminalAt: 102,
				processedEvents: [{ eventId: "complete-event", sequence: 1, fingerprint: "complete" }],
			}),
		)
		expect(registry.getMetadata()[task.taskId]).toMatchObject({
			lifecycle: TaskLifecycleState.Waiting,
			isWaitingForInput: true,
			waitingReason: "completion",
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
		expect(registry.getLiveTaskIds()).toEqual([task.taskId])
		expect(registry.getMetadata()[task.taskId].lifecycle).toBe(TaskLifecycleState.Running)
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
