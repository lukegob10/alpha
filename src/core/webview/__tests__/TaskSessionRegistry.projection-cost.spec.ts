import { describe, expect, it, vi } from "vitest"
import {
	agentLifecycleSnapshotSchema,
	type AgentLifecycleSnapshot,
	type AlphaMessage,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

import type { Task } from "../../task/Task"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

const createTask = (taskId: string, overrides: Partial<Task> = {}): Task =>
	({
		taskId,
		taskStatus: TaskStatus.Running,
		isStreaming: true,
		alphaMessages: [{ ts: 1, type: "say", say: "text", text: taskId }],
		getActiveAskTimestamp: vi.fn(() => undefined),
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

describe("task metadata projection cost", () => {
	it.each([1, 10, 50])("reads each current input slot once across %i sessions", (sessionCount) => {
		const registry = new TaskSessionRegistry(50)
		const tasks = Array.from({ length: sessionCount }, (_, index) => createTask(`task-${index}`))
		for (const task of tasks) registry.register(task, { lifecycleSnapshot: createSnapshot(task.taskId) })

		const metadata = registry.getMetadata()

		expect(Object.keys(metadata)).toHaveLength(sessionCount)
		for (const task of tasks) {
			expect(task.getActiveAskTimestamp).toHaveBeenCalledOnce()
			expect(metadata[task.taskId]).toMatchObject({
				lifecycle: TaskLifecycleState.Running,
				hasPendingToolCalls: false,
			})
		}
	})

	it("does not revisit completed tool history during repeated metadata reads", () => {
		const registry = new TaskSessionRegistry(50)
		const toolIds = Array.from({ length: 200 }, (_, index) => `finished-${index}`)
		for (let index = 0; index < 50; index++) {
			const task = createTask(`task-${index}`)
			registry.register(task, {
				lifecycleSnapshot: createSnapshot(task.taskId, {
					acceptedToolCallIds: toolIds,
					terminalToolCallIds: toolIds,
				}),
			})
		}
		const NativeSet = globalThis.Set
		let terminalToolIdsVisited = 0
		vi.stubGlobal(
			"Set",
			class extends NativeSet<unknown> {
				constructor(values?: Iterable<unknown> | null) {
					super(values)
					if (Array.isArray(values) && values[0] === toolIds[0]) terminalToolIdsVisited += values.length
				}
			},
		)
		let metadata: ReturnType<TaskSessionRegistry["getMetadata"]> = {}
		try {
			for (let index = 0; index < 100; index++) metadata = registry.getMetadata()
		} finally {
			vi.unstubAllGlobals()
		}

		expect(terminalToolIdsVisited).toBe(0)
		expect(Object.values(metadata)).toHaveLength(50)
		expect(Object.values(metadata).every((task) => !task.hasPendingToolCalls)).toBe(true)
	})

	it("reads fresh input, usage, queue, and turn controls with each projection", () => {
		const registry = new TaskSessionRegistry()
		const activeAsk = vi.fn<() => number | undefined>(() => undefined)
		const task = createTask("target", {
			getActiveAskTimestamp: activeAsk,
			isTurnActive: () => true,
			canInterruptCurrentTurn: () => true,
		})
		registry.register(task, { lifecycleSnapshot: createSnapshot(task.taskId) })
		expect(registry.getMetadataForTask(task.taskId)).toMatchObject({
			isWaitingForInput: false,
			queueCount: 0,
			tokensIn: 0,
			canInterrupt: true,
		})

		const ask: AlphaMessage = { ts: 2, type: "ask", ask: "followup", text: "Continue?" }
		task.alphaMessages.push(ask)
		activeAsk.mockReturnValue(ask.ts)
		Object.assign(task, {
			lastMessageTs: ask.ts,
			tokenUsage: { totalTokensIn: 30, totalTokensOut: 5, totalCost: 0.05, contextTokens: 35 },
			queuedMessages: [{ id: "queued", text: "Next", images: [], timestamp: 3 }],
			canInterruptCurrentTurn: () => false,
		})
		expect(registry.getMetadataForTask(task.taskId)).toMatchObject({
			lifecycle: TaskLifecycleState.Waiting,
			isWaitingForInput: true,
			waitingReason: "interactive",
			queueCount: 1,
			tokensIn: 30,
			tokensOut: 5,
			canInterrupt: false,
		})

		ask.isAnswered = true
		activeAsk.mockReturnValue(undefined)
		expect(registry.getMetadataForTask(task.taskId)).toMatchObject({
			lifecycle: TaskLifecycleState.Running,
			isWaitingForInput: false,
		})
		expect(activeAsk).toHaveBeenCalledTimes(3)
	})

	it.each(["registration", "publication"] as const)(
		"isolates the derived pending state from external snapshot mutation after %s",
		(source) => {
			const registry = new TaskSessionRegistry()
			const task = createTask("target")
			const snapshot = createSnapshot(task.taskId, { acceptedToolCallIds: ["pending"] })
			if (source === "registration") registry.register(task, { lifecycleSnapshot: snapshot })
			else {
				registry.register(task)
				registry.markLifecycleSnapshot(task.taskId, snapshot)
			}
			snapshot.terminalToolCallIds.push("pending")
			registry.getLifecycleSnapshot(task.taskId)?.terminalToolCallIds.push("pending")
			registry.getLifecycleSnapshots()[task.taskId].terminalToolCallIds.push("pending")

			expect(registry.getMetadataForTask(task.taskId)?.hasPendingToolCalls).toBe(true)
			expect(registry.getLifecycleSnapshot(task.taskId)?.terminalToolCallIds).toEqual([])
			registry.markLifecycleSnapshot(task.taskId, snapshot)
			expect(registry.getMetadataForTask(task.taskId)?.hasPendingToolCalls).toBe(false)
		},
	)

	it("refreshes pending state across degradation, replacement, and snapshot removal", () => {
		const registry = new TaskSessionRegistry()
		const task = createTask("target")
		const pending = createSnapshot(task.taskId, { acceptedToolCallIds: ["pending"] })
		registry.markLifecycleSnapshot(task.taskId, pending)
		registry.register(task)
		registry.markLifecycleDegraded(task.taskId)
		expect(registry.getMetadataForTask(task.taskId)).toMatchObject({
			hasPendingToolCalls: true,
			isWaitingForInput: false,
		})
		registry.clearLifecycleDegraded(task.taskId)
		const replacement = createTask(task.taskId)
		registry.replaceTask(task, replacement)
		expect(registry.getMetadataForTask(task.taskId)?.hasPendingToolCalls).toBe(true)

		registry.clearLifecycleSnapshot(task.taskId)
		expect(registry.getMetadataForTask(task.taskId)).toMatchObject({
			hasPendingToolCalls: false,
			activityPhase: undefined,
			turnId: undefined,
		})
		registry.markLifecycleSnapshot(task.taskId, { ...pending, turnId: "next-turn", runId: "next-run" })
		expect(registry.getMetadataForTask(task.taskId)).toMatchObject({
			hasPendingToolCalls: true,
			turnId: "next-turn",
		})
		registry.clearLifecycleSnapshot()
		expect(registry.getMetadataForTask(task.taskId)?.hasPendingToolCalls).toBe(false)
		registry.unregister(task.taskId, replacement)
		expect(registry.getMetadataForTask(task.taskId)).toBeUndefined()
	})
})
