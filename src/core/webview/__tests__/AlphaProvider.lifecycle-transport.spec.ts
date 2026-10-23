import { describe, expect, it, vi } from "vitest"
import {
	type AgentLifecycleSnapshot,
	type ExtensionMessage,
	type LiveTaskMetadata,
	type ManagedAgentTreeProjection,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

import type { Task } from "../../task/Task"
import { AgentLifecycleProjector } from "../AgentLifecycleProjection"
import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

const snapshot = (itemCount: number): AgentLifecycleSnapshot => ({
	version: 1,
	taskId: "task",
	runId: "run",
	turnId: "turn",
	status: "in_progress",
	phase: "compacting",
	lastSequence: itemCount,
	items: Array.from({ length: itemCount }, (_, index) => ({
		itemId: `text-${index}`,
		type: "assistant_text",
		text: "x".repeat(8_000),
	})),
	steps: [],
	acceptedToolCallIds: ["pending-call"],
	effectStartedToolCallIds: [],
	terminalToolCallIds: [],
	processedEvents: Array.from({ length: itemCount }, (_, index) => ({
		eventId: `event-${index}`,
		sequence: index + 1,
		fingerprint: "x".repeat(8_000),
	})),
})

const createProvider = (taskSessions = new TaskSessionRegistry()) => {
	const task = {
		taskId: "task",
		taskStatus: TaskStatus.Running,
		isStreaming: false,
		isTurnActive: () => true,
		clineMessages: [],
		metadata: {},
	} as unknown as Task
	taskSessions.register(task)
	const post = vi.fn(async (_message: ExtensionMessage) => undefined)
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		taskSessions,
		currentView: { type: "newTaskDraft" },
		taskNavigationGeneration: 0,
		taskStateSeq: 0,
		agentLifecycleMessageQueue: Promise.resolve(),
		agentLifecycleDegradedSignals: new Map(),
		getHostProviders: () => [provider],
		getAgentLifecycleJournal: async () => ({ getSnapshot: () => undefined }),
		taskHistoryStore: { get: () => undefined },
		contextProxy: { getValues: () => ({}) },
		isIncidentDashboardEnabled: () => false,
		postMessageToWebview: post,
		log: vi.fn(),
	})
	const projector = new AgentLifecycleProjector({
		onSnapshotUpdated: (next) => {
			taskSessions.markLifecycleSnapshot(next.taskId, next)
		},
	})
	Object.assign(provider, { agentLifecycleProjector: projector })
	return { provider, taskSessions, post }
}

describe("compact webview lifecycle transport", () => {
	it("keeps a delayed tree update newer than compact lifecycle metadata without restoring an old phase", async () => {
		const { provider, post } = createProvider()
		const tree: ManagedAgentTreeProjection = {
			version: 1,
			rootTaskId: "task",
			observedAt: 1,
			nodes: [
				{
					taskId: "task",
					rootTaskId: "task",
					path: "/root",
					nickname: "Root task",
					role: "root",
					objective: "Complete the task",
					status: "running",
					createdAt: 1,
					updatedAt: 1,
					depth: 0,
					usage: { inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0 },
				},
			],
			activity: [],
			capacity: { active: 0, queued: 0, terminal: 0, limit: 1 },
			budgets: { tokenLimit: null, costLimit: null },
			omittedNodeCount: 0,
			omittedActivityCount: 0,
		}
		let finishTree!: (value: ManagedAgentTreeProjection) => void
		const pendingTree = new Promise<ManagedAgentTreeProjection>((resolve) => {
			finishTree = resolve
		})
		const projectTree = vi.fn(() => pendingTree)
		Object.assign(provider, {
			currentView: { type: "task", taskId: "task" },
			buildManagedAgentTreeProjection: projectTree,
		})

		const delayed = provider.postTaskSessionStateToWebview()
		expect(projectTree).toHaveBeenCalledOnce()
		await provider.publishAgentLifecycleSnapshot(snapshot(1))
		expect(post).toHaveBeenCalledOnce()
		const compact = post.mock.calls[0][0]
		finishTree(tree)
		await delayed
		const refreshed = post.mock.calls[1][0]
		if (compact.type !== "state" || refreshed.type !== "state") throw new Error("Expected task state publications")
		expect(refreshed.state?.taskStateSeq).toBeGreaterThan(compact.state?.taskStateSeq ?? 0)
		expect(refreshed.state?.liveTasksById?.task).toMatchObject({ activityPhase: "compacting", turnId: "turn" })
		expect(refreshed.state?.managedAgentTree).toEqual(tree)
	})

	it("does not wait for managed-agent startup while publishing canonical lifecycle metadata", async () => {
		const { provider, post } = createProvider()
		let projectionEntered!: () => void
		const entered = new Promise<"projection">((resolve) => {
			projectionEntered = () => resolve("projection")
		})
		const projectTree = vi.fn(() => {
			projectionEntered()
			return new Promise<never>(() => undefined)
		})
		Object.assign(provider, {
			currentView: { type: "task", taskId: "task" },
			buildManagedAgentTreeProjection: projectTree,
		})

		const first = await Promise.race([
			provider.publishAgentLifecycleSnapshot(snapshot(1)).then(() => "publication"),
			entered,
		])
		expect(first).toBe("publication")
		expect(projectTree).not.toHaveBeenCalled()
		expect(post).toHaveBeenCalledWith(
			expect.objectContaining({ type: "state", state: expect.objectContaining({ currentTaskId: "task" }) }),
		)
	})

	it("keeps lifecycle delivery bounded as a long turn accumulates text and replay receipts", async () => {
		const sizes: number[] = []
		for (const itemCount of [1, 100]) {
			const { provider, post } = createProvider()
			const result = await provider.publishAgentLifecycleSnapshot(snapshot(itemCount))
			expect(result.accepted).toBe(true)
			expect(result.snapshot?.items).toHaveLength(itemCount)
			const messages = post.mock.calls.map(([message]) => message)
			expect(messages).toHaveLength(1)
			expect(messages[0]).toMatchObject({
				type: "state",
				state: {
					liveTasksById: {
						task: { turnId: "turn", hasPendingToolCalls: true, activityPhase: "compacting" },
					},
				},
			})
			expect(JSON.stringify(messages)).not.toContain("processedEvents")
			sizes.push(JSON.stringify(messages).length)
		}
		expect(sizes[1]).toBe(sizes[0])
		expect(sizes[1]).toBeLessThan(2_000)
	})

	it("does not manufacture a live task from an unregistered bridge snapshot", async () => {
		const { provider, post } = createProvider()
		const value = { ...snapshot(1), taskId: "unregistered" }
		const result = provider.ingestAgentLifecycleSnapshot(value)
		await provider.postTaskSessionStateToWebview()

		expect(result).toMatchObject({ accepted: true, taskId: "unregistered" })
		expect(provider.getAgentLifecycleSnapshot("unregistered")).toEqual(value)
		for (const [message] of post.mock.calls) {
			expect(message.type).toBe("state")
			if (message.type === "state") {
				expect(message.state?.liveTasksById?.unregistered).toBeUndefined()
				expect(message.state?.agentLifecycleSnapshots).toBeUndefined()
			}
		}
	})

	it("projects a restored journal before any subsequent model event", async () => {
		const { provider, post } = createProvider()
		const restored = snapshot(10)
		Object.assign(provider, {
			getAgentLifecycleJournal: async () => ({
				getSnapshot: () => restored,
				replay: async () => restored,
			}),
		})

		expect(await provider.replayAgentLifecycle("task")).toEqual(restored)
		expect(post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "state",
				state: expect.objectContaining({
					liveTasksById: expect.objectContaining({
						task: expect.objectContaining({ turnId: "turn", hasPendingToolCalls: true }),
					}),
				}),
			}),
		)
		expect(JSON.stringify(post.mock.calls)).not.toContain("processedEvents")
	})

	it("publishes each host view's compact selection metadata", async () => {
		const storage = "compact-lifecycle-transport-views"
		const sidebarSessions = TaskSessionRegistry.forGlobalStorage(storage)
		const editorSessions = TaskSessionRegistry.forGlobalStorage(storage)
		try {
			const { provider, post } = createProvider(sidebarSessions)
			editorSessions.clearFocus()
			const editorPost = vi.fn(async (_message: ExtensionMessage) => undefined)
			const editor = Object.assign(Object.create(AlphaProvider.prototype), {
				taskSessions: editorSessions,
				currentView: { type: "newTaskDraft" },
				taskNavigationGeneration: 0,
				taskStateSeq: 0,
				getAgentLifecycleDegraded: () => ({}),
				postMessageToWebview: editorPost,
			})
			Object.assign(provider, { getHostProviders: () => [provider, editor] })

			await provider.publishAgentLifecycleSnapshot(snapshot(10))

			for (const [send, isActive] of [
				[post, true],
				[editorPost, false],
			] as const) {
				expect(send).toHaveBeenCalledOnce()
				expect(send.mock.calls[0][0]).toMatchObject({
					type: "state",
					state: { liveTasksById: { task: { isActive, turnId: "turn", hasPendingToolCalls: true } } },
				})
				expect(JSON.stringify(send.mock.calls)).not.toContain("processedEvents")
			}
		} finally {
			sidebarSessions.disposeView()
			editorSessions.disposeView()
		}
	})

	it("retains terminal task and completion-review metadata over a completed turn", async () => {
		const { provider, taskSessions, post } = createProvider()
		taskSessions.markLifecycle("task", TaskLifecycleState.Waiting, "completion")
		const terminal: AgentLifecycleSnapshot = {
			...snapshot(1),
			status: "completed",
			terminalEventId: "event-0",
			terminalAt: 100,
			terminalToolCallIds: ["pending-call"],
		}
		await provider.publishAgentLifecycleSnapshot(terminal)
		const message = post.mock.calls.at(-1)?.[0]
		expect(message?.type).toBe("state")
		if (message?.type !== "state") throw new Error("Expected compact task state")
		const metadata: LiveTaskMetadata | undefined = message.state?.liveTasksById?.task
		expect(metadata).toMatchObject({
			lifecycle: TaskLifecycleState.Waiting,
			waitingReason: "completion",
			hasPendingToolCalls: false,
			turnId: "turn",
		})
	})
})
