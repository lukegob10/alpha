import EventEmitter from "events"

import { describe, expect, it, vi } from "vitest"

import { AgentCoordinator } from "../AgentCoordinator"

function createHarness(options: { enabled?: boolean; maxConcurrent?: number } = {}) {
	const history = new Map<string, any>()
	const parentTask = {
		taskId: "parent-task-123456",
		cwd: "/repo",
		rootTask: undefined,
		parallelAgentId: undefined,
	} as any

	history.set(parentTask.taskId, {
		id: parentTask.taskId,
		number: 1,
		ts: Date.now(),
		task: "parent",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		workspace: "/repo",
		status: "active",
	})

	const provider = {
		cwd: "/repo",
		log: vi.fn(),
		getState: vi.fn(async () => ({
			parallelSubagents: options.enabled ?? true,
			parallelAgentMaxConcurrent: options.maxConcurrent ?? 3,
		})),
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: history.get(id) })),
		updateTaskHistory: vi.fn(async (item: any) => {
			history.set(item.id, { ...(history.get(item.id) ?? {}), ...item })
			return Array.from(history.values())
		}),
		postMessageToWebview: vi.fn(async () => undefined),
		createBackgroundTask: vi.fn(async (_message: string, _parentTask: any, taskOptions: any) => {
			const task = new EventEmitter() as any
			task.taskId = taskOptions.taskId
			task.abortTask = vi.fn()
			task.start = vi.fn()
			task.submitUserMessage = vi.fn()
			return task
		}),
	} as any

	return {
		coordinator: new AgentCoordinator(provider),
		provider,
		parentTask,
		history,
	}
}

describe("AgentCoordinator", () => {
	it("rejects spawning when parallel subagents are disabled", async () => {
		const { coordinator, parentTask } = createHarness({ enabled: false })

		await expect(
			coordinator.spawn(parentTask, {
				taskName: "read-only",
				message: "inspect code",
				agentRole: "explorer",
				workspaceStrategy: "sameWorktree",
			}),
		).rejects.toThrow("Parallel subagents are disabled")
	})

	it("enforces the configured concurrency cap", async () => {
		const { coordinator, parentTask } = createHarness({ maxConcurrent: 1 })

		await coordinator.spawn(parentTask, {
			taskName: "first",
			message: "inspect code",
			agentRole: "explorer",
			workspaceStrategy: "sameWorktree",
		})

		await expect(
			coordinator.spawn(parentTask, {
				taskName: "second",
				message: "inspect more code",
				agentRole: "explorer",
				workspaceStrategy: "sameWorktree",
			}),
		).rejects.toThrow("Parallel agent limit reached")
	})

	it("rejects overlapping same-worktree write scopes", async () => {
		const { coordinator, parentTask } = createHarness()

		await coordinator.spawn(parentTask, {
			taskName: "worker-a",
			message: "edit module a",
			agentRole: "worker",
			workspaceStrategy: "sameWorktree",
			writeScopes: ["src/module"],
		})

		await expect(
			coordinator.spawn(parentTask, {
				taskName: "worker-b",
				message: "edit nested module",
				agentRole: "worker",
				workspaceStrategy: "sameWorktree",
				writeScopes: ["src/module/nested"],
			}),
		).rejects.toThrow("conflicts with active agent")
	})

	it("persists completion metadata and moves parent child state", async () => {
		const { coordinator, parentTask, history } = createHarness()

		const agent = await coordinator.spawn(parentTask, {
			taskName: "verify",
			message: "run verification",
			agentRole: "verifier",
			workspaceStrategy: "sameWorktree",
		})

		await coordinator.complete(agent.id, "Summary: ok\n\nChanged files: none\n\nValidation: npm test")

		expect(coordinator.get(agent.id)?.status).toBe("completed")
		expect(history.get(agent.id).agentStatus).toBe("completed")
		expect(history.get(parentTask.taskId).runningChildIds).toEqual([])
		expect(history.get(parentTask.taskId).completedChildIds).toEqual([agent.id])
	})

	it("prepares every batch agent before starting any of them", async () => {
		const { coordinator, parentTask, provider } = createHarness()
		const createdTaskIds: string[] = []
		const startEvents: Array<{ taskId: string; createdCount: number }> = []

		provider.createBackgroundTask.mockImplementation(async (_message: string, _parentTask: any, taskOptions: any) => {
			const task = new EventEmitter() as any
			task.taskId = taskOptions.taskId
			task.abortTask = vi.fn()
			task.submitUserMessage = vi.fn()
			task.start = vi.fn(() => {
				startEvents.push({ taskId: task.taskId, createdCount: createdTaskIds.length })
			})
			createdTaskIds.push(task.taskId)
			return task
		})

		const result = await coordinator.spawnMany(parentTask, [
			{
				taskName: "inspect-a",
				message: "inspect area a",
				agentRole: "explorer",
				workspaceStrategy: "sameWorktree",
			},
			{
				taskName: "inspect-b",
				message: "inspect area b",
				agentRole: "explorer",
				workspaceStrategy: "sameWorktree",
			},
		])

		expect(result.failures).toEqual([])
		expect(result.records).toHaveLength(2)
		expect(startEvents).toHaveLength(2)
		expect(startEvents.map((event) => event.createdCount)).toEqual([2, 2])
		expect(startEvents.map((event) => event.taskId)).toEqual(result.records.map((record) => record.id))
	})
})
