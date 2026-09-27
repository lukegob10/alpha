import { afterEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import type { CrossTaskOrchestrationProvider } from "../../webview/CrossTaskOrchestration"

import {
	CreateTaskTool,
	ListTasksTool,
	WaitTaskTool,
	SendTaskMessageTool,
	SteerTaskTool,
	StopTaskTool,
} from "../CrossTaskOrchestrationTools"
import type { ToolCallbacks } from "../BaseTool"

function createProvider(): CrossTaskOrchestrationProvider & { calls: string[] } {
	const calls: string[] = []
	return {
		calls,
		createIndependentTask: vi.fn(async (_parent, objective, workspace_mode) => {
			calls.push(`create:${objective}:${workspace_mode}`)
			return {
				task_id: "child-1",
				objective,
				lifecycle: "running" as const,
				workspace_mode,
				updated_at: 1,
			}
		}),
		listIndependentTasks: vi.fn(async () => []),
		waitForIndependentTask: vi.fn(async () => ({
			task_id: "child-1",
			lifecycle: "completed" as const,
			result: "done",
		})),
		sendIndependentTaskMessage: vi.fn(async (_sender, taskId) => ({ task_id: taskId, status: "queued" })),
		steerIndependentTask: vi.fn(async (_parent, taskId) => ({ task_id: taskId, status: "steered" })),
		stopIndependentTask: vi.fn(async (_parent, taskId) => ({ task_id: taskId, status: "stopped" })),
	}
}

function createTask(provider: CrossTaskOrchestrationProvider): Task {
	return {
		taskId: "parent-1",
		taskKind: "primary",
		providerRef: new WeakRef(provider),
		recordToolError: vi.fn(),
		didToolFailInCurrentTurn: false,
	} as unknown as Task
}

function createCallbacks(overrides: Partial<ToolCallbacks> = {}): ToolCallbacks & {
	results: string[]
	metadata: Array<{ status: string }>
} {
	const results: string[] = []
	const metadata: Array<{ status: string }> = []
	return {
		results,
		metadata,
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => undefined),
		pushToolResult: vi.fn((content) => results.push(String(content))),
		setResultMetadata: vi.fn((result) => metadata.push(result as { status: string })),
		...overrides,
	}
}

describe("cross-task orchestration tools", () => {
	afterEach(() => vi.restoreAllMocks())

	it("creates a worktree child only after approval and returns its stable task handle", async () => {
		const provider = createProvider()
		const task = createTask(provider)
		const callbacks = createCallbacks()

		await new CreateTaskTool().execute(
			{ objective: "Inspect the parser", workspace_mode: "worktree" },
			task,
			callbacks,
		)

		expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining('"tool":"create_task"'))
		expect(provider.createIndependentTask).toHaveBeenCalledWith(task, "Inspect the parser", "worktree", undefined)
		expect(JSON.parse(callbacks.results[0])).toMatchObject({ task_id: "child-1", workspace_mode: "worktree" })
		expect(callbacks.metadata).toEqual([{ status: "success" }])
	})

	it("does not create a child when approval is denied", async () => {
		const provider = createProvider()
		const task = createTask(provider)
		const callbacks = createCallbacks({ askApproval: vi.fn(async () => false) })

		await new CreateTaskTool().execute({ objective: "Inspect", workspace_mode: "shared" }, task, callbacks)

		expect(provider.createIndependentTask).not.toHaveBeenCalled()
		expect(JSON.parse(callbacks.results[0])).toMatchObject({ status: "denied", tool: "create_task" })
		expect(callbacks.metadata).toEqual([{ status: "denied" }])
	})

	it("returns a cancelled result when child creation is aborted after approval", async () => {
		const provider = createProvider()
		const task = createTask(provider)
		const controller = new AbortController()
		const cancellation = new Error("Cancelled by the parent")
		provider.createIndependentTask = vi.fn(async () => {
			controller.abort(cancellation)
			throw cancellation
		})
		const callbacks = createCallbacks({ signal: controller.signal })

		await new CreateTaskTool().execute({ objective: "Inspect parser", workspace_mode: "shared" }, task, callbacks)

		expect(provider.createIndependentTask).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.results[0])).toEqual({ status: "cancelled", tool: "create_task" })
		expect(callbacks.metadata).toEqual([{ status: "cancelled" }])
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("lists and waits without approval and preserves the child's terminal result", async () => {
		const provider = createProvider()
		const task = createTask(provider)
		const listCallbacks = createCallbacks()
		await new ListTasksTool().execute({}, task, listCallbacks)
		expect(provider.listIndependentTasks).toHaveBeenCalledWith(task)
		expect(listCallbacks.askApproval).not.toHaveBeenCalled()

		const waitCallbacks = createCallbacks()
		await new WaitTaskTool().execute({ task_id: "child-1", timeout_ms: 1000 }, task, waitCallbacks)
		expect(provider.waitForIndependentTask).toHaveBeenCalledWith(task, "child-1", 1000, undefined)
		expect(waitCallbacks.askApproval).not.toHaveBeenCalled()
		expect(JSON.parse(waitCallbacks.results[0])).toMatchObject({
			task_id: "child-1",
			lifecycle: "completed",
			result: "done",
		})
	})

	it("approval-gates message, steer, and stop effects", async () => {
		const provider = createProvider()
		const task = createTask(provider)
		const tools = [new SendTaskMessageTool(), new SteerTaskTool(), new StopTaskTool()]
		const args = [
			{ task_id: "child-1", message: "Keep the report brief" },
			{ task_id: "child-1", message: "Focus on parser recovery" },
			{ task_id: "child-1", reason: "No longer needed" },
		]
		const names = ["send_task_message", "steer_task", "stop_task"]
		const callbacks = createCallbacks()
		for (let index = 0; index < tools.length; index++) {
			await tools[index].execute(args[index] as never, task, callbacks)
			expect(callbacks.askApproval).toHaveBeenNthCalledWith(
				index + 1,
				"tool",
				expect.stringContaining(`"tool":"${names[index]}"`),
			)
		}
		expect(provider.sendIndependentTaskMessage).toHaveBeenCalledWith(task, "child-1", "Keep the report brief")
		expect(provider.steerIndependentTask).toHaveBeenCalledWith(task, "child-1", "Focus on parser recovery")
		expect(provider.stopIndependentTask).toHaveBeenCalledWith(task, "child-1", "No longer needed")
		expect(callbacks.results.map((result) => JSON.parse(result))).toEqual([
			{ task_id: "child-1", status: "queued" },
			{ task_id: "child-1", status: "steered" },
			{ task_id: "child-1", status: "stopped" },
		])
		expect(callbacks.metadata).toEqual([{ status: "success" }, { status: "success" }, { status: "success" }])
	})

	it("does not perform message, steer, or stop effects when approval is denied", async () => {
		const provider = createProvider()
		const task = createTask(provider)
		const tools = [new SendTaskMessageTool(), new SteerTaskTool(), new StopTaskTool()]
		const callbacks = createCallbacks({ askApproval: vi.fn(async () => false) })
		const args = [
			{ task_id: "child-1", message: "Keep the report brief" },
			{ task_id: "child-1", message: "Focus on parser recovery" },
			{ task_id: "child-1", reason: "No longer needed" },
		]

		for (let index = 0; index < tools.length; index++) {
			await tools[index].execute(args[index] as never, task, callbacks)
		}

		expect(provider.sendIndependentTaskMessage).not.toHaveBeenCalled()
		expect(provider.steerIndependentTask).not.toHaveBeenCalled()
		expect(provider.stopIndependentTask).not.toHaveBeenCalled()
		expect(callbacks.results.map((result) => JSON.parse(result).status)).toEqual(["denied", "denied", "denied"])
		expect(callbacks.metadata).toEqual([{ status: "denied" }, { status: "denied" }, { status: "denied" }])
	})
})
