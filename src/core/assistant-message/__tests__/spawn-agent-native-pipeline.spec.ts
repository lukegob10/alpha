import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Anthropic } from "@anthropic-ai/sdk"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import { createAgentResponse, type AgentToolCall } from "../../agent/AgentResponse"
import { collectAgentResponse } from "../../agent/AgentResponseAccumulator"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { Task } from "../../task/Task"
import { AskIgnoredError } from "../../task/AskIgnoredError"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { NativeToolCallParser, type ToolCallStreamEvent } from "../NativeToolCallParser"
import { presentAssistantMessage } from "../presentAssistantMessage"

const handlers = vi.hoisted(() => ({
	spawn: vi.fn(),
	list: vi.fn(),
	wait: vi.fn(),
	send: vi.fn(),
	cancel: vi.fn(),
	read: vi.fn(),
	followup: vi.fn(),
}))

vi.mock("../../tools/SpawnAgentTool", () => ({ spawnAgentTool: { handle: handlers.spawn } }))
vi.mock("../../tools/ListAgentsTool", () => ({ listAgentsTool: { handle: handlers.list } }))
vi.mock("../../tools/WaitAgentTool", () => ({ waitAgentTool: { handle: handlers.wait } }))
vi.mock("../../tools/SendMessageTool", () => ({ sendMessageTool: { handle: handlers.send } }))
vi.mock("../../tools/CancelAgentTool", () => ({ cancelAgentTool: { handle: handlers.cancel } }))
vi.mock("../../tools/ReadFileTool", () => ({ readFileTool: { handle: handlers.read } }))
vi.mock("../../tools/AskFollowupQuestionTool", () => ({ askFollowupQuestionTool: { handle: handlers.followup } }))

function call(id: string, name: string, args: Record<string, unknown> = {}): AgentToolCall {
	return { type: "tool_call", id, name, arguments: args }
}

function createTask() {
	const userMessageContent: Array<
		Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam
	> = []
	return {
		taskId: "native-pipeline",
		instanceId: "native-pipeline-instance",
		abort: false,
		cwd: "C:/workspace",
		taskKind: "primary" as "primary" | "subagent",
		subagentRole: undefined as string | undefined,
		subagentPrivateWorkspaceRoot: undefined as string | undefined,
		persistedToolResultIds: new Set<string>(),
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [] as Task["assistantMessageContent"],
		streamingToolCallIndices: new Map<string, number>(),
		didCompleteReadingStream: true,
		didRejectTool: false,
		didToolFailInCurrentTurn: false,
		userMessageContent,
		userMessageContentReady: false,
		recordToolUsage: vi.fn(),
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		pushToolResultToUserContent(result: Anthropic.ToolResultBlockParam) {
			return Task.prototype.pushToolResultToUserContent.call(this as unknown as Task, result)
		},
	}
}

function scheduler(task: ReturnType<typeof createTask>, mode = "code", signal?: AbortSignal) {
	const surface = createTaskToolSurface({ registry: new ToolRegistry(), mode })
	return new ToolScheduler({
		task: task as unknown as Task,
		registry: surface.registry,
		policy: surface.policy,
		mode,
		signal,
		preserveAbortedResults: true,
		executionMode: "serial",
	})
}

function resultIds(task: ReturnType<typeof createTask>) {
	return task.userMessageContent.flatMap((item) => (item.type === "tool_result" ? [item.tool_use_id] : []))
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("native streaming through the captured scheduler/registry surface", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
		for (const [name, handler] of Object.entries(handlers)) {
			handler.mockImplementation(async (_task, _block, callbacks) => {
				callbacks.pushToolResult(`${name} result`)
			})
		}
	})

	it("preserves typed raw arguments and call IDs while previews defer effects to the canonical scheduler", async () => {
		const task = createTask()
		const id = "call_spawn_agent"
		const args = {
			task_name: "lifecycle_inspector",
			fork_turns: "all",
			objective: "Inspect the lifecycle without modifying files.",
			agent_kind: "explore",
			write_scope: null,
			expected_output: ["lifecycle sequence", "cancellation behavior"],
		}
		const serialized = JSON.stringify(args)
		const splitAt = serialized.indexOf('"write_scope"')
		const chunks = [
			{ index: 0, id, name: "spawn_agent" },
			{ index: 0, arguments: serialized.slice(0, splitAt) },
			{ index: 0, arguments: serialized.slice(splitAt) },
		]
		const rawEvents = chunks.flatMap((chunk) => NativeToolCallParser.processRawChunk(chunk, task.taskId))
		rawEvents.push(...NativeToolCallParser.finalizeRawChunks(task.taskId))
		const processEvents = (
			Task.prototype as unknown as {
				processNativeToolCallStreamEvents(events: ToolCallStreamEvent[]): void
			}
		).processNativeToolCallStreamEvents
		processEvents.call(task, rawEvents)
		expect(task.assistantMessageContent[0]).toMatchObject({
			id,
			type: "tool_use",
			name: "spawn_agent",
			partial: false,
			nativeArgs: args,
			params: expect.objectContaining({
				write_scope: "null",
				expected_output: JSON.stringify(args.expected_output),
			}),
		})
		task.assistantMessageContent.push({ type: "text", content: "Review queued.", partial: false })
		await presentAssistantMessage(task as unknown as Task)
		expect(handlers.spawn).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.userMessageContent).toEqual([])
		expect(task.say).toHaveBeenCalledWith("text", "Review queued.", undefined, false)

		const response = await collectAgentResponse(
			(async function* (): AsyncGenerator<ApiStreamChunk> {
				for (const chunk of chunks) yield { type: "tool_call_partial", ...chunk }
			})(),
		)
		handlers.spawn.mockImplementationOnce(async (_task, _block, callbacks) => {
			expect(await callbacks.askApproval("tool", "{}")).toBe(true)
			callbacks.pushToolResult('{"runId":"run-1","status":"running"}')
			callbacks.pushToolResult("duplicate must be ignored")
		})
		const outcome = await scheduler(task).run(response)
		expect(outcome.results).toEqual([expect.objectContaining({ callId: id, status: "success" })])
		expect(handlers.spawn).toHaveBeenCalledExactlyOnceWith(
			task,
			expect.objectContaining({ id, name: "spawn_agent", nativeArgs: args }),
			expect.objectContaining({ toolCallId: id }),
		)
		expect(resultIds(task)).toEqual([id])
	})

	it("returns one error receipt for a superseded approval", async () => {
		const task = createTask()
		task.ask.mockRejectedValueOnce(new AskIgnoredError("superseded"))
		handlers.spawn.mockImplementationOnce(async (_task, _block, callbacks) => {
			expect(await callbacks.askApproval("tool", "{}")).toBe(false)
		})
		const outcome = await scheduler(task).run([call("spawn-superseded", "spawn_agent")])
		expect(outcome.supersededAskCount).toBe(1)
		expect(outcome.results).toEqual([
			expect.objectContaining({
				status: "error",
				content: expect.stringContaining("Approval request was superseded"),
			}),
		])
		expect(resultIds(task)).toEqual(["spawn-superseded"])
		expect(task.userMessageContent[0]).toMatchObject({ is_error: true })
	})

	it("returns an error receipt when a tool-internal ask is superseded", async () => {
		const task = createTask()
		task.ask.mockRejectedValueOnce(new AskIgnoredError("superseded"))
		handlers.followup.mockImplementationOnce(async (host, _block, callbacks) => {
			try {
				await host.ask("followup", "{}", false)
			} catch (error) {
				await callbacks.handleError("asking a follow-up question", error)
			}
		})
		const outcome = await scheduler(task).run([call("ask-superseded", "ask_followup_question")])
		expect(outcome.results).toEqual([
			expect.objectContaining({
				status: "error",
				content: expect.stringContaining("approval was superseded"),
			}),
		])
		expect(resultIds(task)).toEqual(["ask-superseded"])
		expect(task.userMessageContentReady).toBe(true)
	})

	it("marks a provisional result as failed when the handler rejects and continues in order", async () => {
		const task = createTask()
		task.taskKind = "subagent"
		task.subagentRole = "worker"
		task.cwd = "C:/private/agent-worktree"
		task.subagentPrivateWorkspaceRoot = task.cwd
		handlers.spawn.mockImplementationOnce(async (_task, _block, callbacks) => {
			callbacks.pushToolResult(`provisional spawn result in ${task.cwd}/src/index.ts`)
			throw new Error(`spawn failed in ${task.cwd}/src/index.ts`)
		})
		const outcome = await scheduler(task).run([call("failed", "spawn_agent"), call("after", "list_agents")])
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "success"])
		expect(task.userMessageContent).toEqual([
			expect.objectContaining({
				tool_use_id: "failed",
				content: "provisional spawn result in ./src/index.ts",
				is_error: true,
			}),
			expect.objectContaining({ tool_use_id: "after", content: "list result", is_error: false }),
		])
		expect(handlers.list).toHaveBeenCalledOnce()
	})

	it("reports a thrown leaf failure through one redacted Task receipt", async () => {
		const task = createTask()
		task.taskKind = "subagent"
		task.subagentRole = "worker"
		task.cwd = "C:/private/agent-worktree"
		handlers.spawn.mockRejectedValueOnce(new Error(`spawn failed in ${task.cwd}/src/index.ts`))
		const outcome = await scheduler(task).run([call("failed", "spawn_agent")])
		expect(outcome.results[0].status).toBe("error")
		expect(task.userMessageContent[0]).toMatchObject({
			tool_use_id: "failed",
			is_error: true,
			content: expect.stringContaining("spawn failed in ./src/index.ts"),
		})
		expect(JSON.stringify(task.userMessageContent)).not.toContain("agent-worktree")
		expect(resultIds(task)).toEqual(["failed"])
	})

	it.each([
		["read_file", "read"],
		["spawn_agent", "spawn"],
	] as const)("waits for every serial %s handler before committing ordered results", async (name, handlerName) => {
		const task = createTask()
		const secondStarted = deferred()
		const secondMayFinish = deferred()
		handlers[handlerName].mockImplementation(async (_task, block, callbacks) => {
			if (block.id === "second") {
				secondStarted.resolve()
				await secondMayFinish.promise
			}
			callbacks.pushToolResult(`${block.id} result`)
		})
		const response = await collectAgentResponse(
			(async function* (): AsyncGenerator<ApiStreamChunk> {
				for (const [index, id] of ["first", "second"].entries()) {
					yield { type: "tool_call_partial", index, id, name }
					yield { type: "tool_call_partial", index, arguments: "{}" }
				}
			})(),
		)
		let settled = false
		const run = scheduler(task)
			.run(response)
			.then((outcome) => {
				settled = true
				return outcome
			})
		await secondStarted.promise
		expect(settled).toBe(false)
		expect(task.userMessageContent).toEqual([])
		secondMayFinish.resolve()
		const outcome = await run
		expect(outcome.parallelBatchCount).toBe(0)
		expect(resultIds(task)).toEqual(["first", "second"])
		expect(handlers[handlerName].mock.calls.map(([, block]) => block.id)).toEqual(["first", "second"])
	})

	it("executes lifecycle controls and named steering in model order", async () => {
		const task = createTask()
		const order: string[] = []
		for (const name of ["spawn", "list", "send", "cancel"] as const) {
			handlers[name].mockImplementation(async (_task, block, callbacks) => {
				order.push(block.name)
				if (name === "send") expect(order).toContain("spawn_agent")
				callbacks.pushToolResult(`${name} result`)
			})
		}
		const calls = [
			call("spawn", "spawn_agent", { task_name: "backend_review" }),
			call("list", "list_agents"),
			call("send", "send_message", { target: "backend_review", message: "Prioritize cancellation." }),
			call("cancel", "cancel_agent", { target: "backend_review" }),
		]
		await scheduler(task).run(createAgentResponse(calls))
		expect(order).toEqual(calls.map((item) => item.name))
		expect(resultIds(task)).toEqual(calls.map((item) => item.id))
	})

	it("rejects a wait batch before a preceding lifecycle control can execute", async () => {
		const task = createTask()
		const outcome = await scheduler(task).run([call("list", "list_agents"), call("wait", "wait_agent")])
		expect(handlers.list).not.toHaveBeenCalled()
		expect(handlers.wait).not.toHaveBeenCalled()
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "error"])
		expect(resultIds(task)).toEqual(["list", "wait"])
	})

	it("passes the native wait call ID to claim retention", async () => {
		const task = createTask()
		await scheduler(task).run([call("wait-receipt", "wait_agent", { timeout_ms: 10_000 })])
		expect(handlers.wait).toHaveBeenCalledExactlyOnceWith(
			task,
			expect.objectContaining({ id: "wait-receipt" }),
			expect.objectContaining({ toolCallId: "wait-receipt" }),
		)
		expect(resultIds(task)).toEqual(["wait-receipt"])
	})

	it("retains one denied receipt when approval declines execution", async () => {
		const task = createTask()
		const effect = vi.fn()
		task.ask.mockResolvedValueOnce({ response: "noButtonClicked" })
		handlers.spawn.mockImplementationOnce(async (_task, _block, callbacks) => {
			if (await callbacks.askApproval("tool", "{}")) effect()
		})
		const outcome = await scheduler(task).run([call("denied", "spawn_agent")])
		expect(effect).not.toHaveBeenCalled()
		expect(outcome.results[0].status).toBe("denied")
		expect(resultIds(task)).toEqual(["denied"])
	})

	it("cancels an active approval and preserves receipts for every unexecuted call", async () => {
		const task = createTask()
		const controller = new AbortController()
		const approvalStarted = deferred()
		const lateApproval = deferred()
		task.ask.mockImplementationOnce(async () => {
			approvalStarted.resolve()
			await lateApproval.promise
			return { response: "yesButtonClicked" }
		})
		const effect = vi.fn()
		handlers.spawn.mockImplementationOnce(async (_task, _block, callbacks) => {
			if (await callbacks.askApproval("tool", "{}")) effect()
		})
		const run = scheduler(task, "code", controller.signal).run([
			call("cancelled-spawn", "spawn_agent"),
			call("cancelled-list", "list_agents"),
		])
		await approvalStarted.promise
		controller.abort()
		const outcome = await run
		lateApproval.resolve()
		await Promise.resolve()
		expect(effect).not.toHaveBeenCalled()
		expect(handlers.list).not.toHaveBeenCalled()
		expect(outcome.status).toBe("aborted")
		expect(outcome.results.map((result) => result.status)).toEqual(["cancelled", "cancelled"])
		expect(resultIds(task)).toEqual(["cancelled-spawn", "cancelled-list"])
	})
})
