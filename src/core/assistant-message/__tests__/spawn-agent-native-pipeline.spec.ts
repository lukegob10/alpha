import { beforeEach, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser, type ToolCallStreamEvent } from "../NativeToolCallParser"
import {
	getToolBatchIsolationError,
	isBatchableAgentToolSequence,
	presentAssistantMessage,
} from "../presentAssistantMessage"
import { Task } from "../../task/Task"
import { spawnAgentTool } from "../../tools/SpawnAgentTool"
import { listAgentsTool } from "../../tools/ListAgentsTool"
import { waitAgentTool } from "../../tools/WaitAgentTool"
import { sendMessageTool } from "../../tools/SendMessageTool"
import { cancelAgentTool } from "../../tools/CancelAgentTool"

const { spawnAgentHandle, listAgentsHandle, waitAgentHandle, sendMessageHandle, cancelAgentHandle } = vi.hoisted(
	() => ({
		spawnAgentHandle: vi.fn(),
		listAgentsHandle: vi.fn(),
		waitAgentHandle: vi.fn(),
		sendMessageHandle: vi.fn(),
		cancelAgentHandle: vi.fn(),
	}),
)

vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) =>
		["spawn_agent", "list_agents", "wait_agent", "send_message", "cancel_agent"].includes(toolName),
	),
}))
vi.mock("../../tools/SpawnAgentTool", () => ({
	spawnAgentTool: {
		handle: spawnAgentHandle,
	},
}))
vi.mock("../../tools/ListAgentsTool", () => ({
	listAgentsTool: {
		handle: listAgentsHandle,
	},
}))
vi.mock("../../tools/WaitAgentTool", () => ({
	waitAgentTool: {
		handle: waitAgentHandle,
	},
}))
vi.mock("../../tools/SendMessageTool", () => ({
	sendMessageTool: {
		handle: sendMessageHandle,
	},
}))
vi.mock("../../tools/CancelAgentTool", () => ({
	cancelAgentTool: {
		handle: cancelAgentHandle,
	},
}))
vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

describe("spawn_agent native streaming pipeline", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
		spawnAgentHandle.mockImplementation(async (_task, _block, callbacks) => {
			callbacks.pushToolResult('{"runId":"run-1","status":"running"}')
		})
		listAgentsHandle.mockImplementation(async (_task, _block, callbacks) => {
			callbacks.pushToolResult('{"agents":[]}')
		})
		waitAgentHandle.mockImplementation(async (_task, _block, callbacks) => {
			callbacks.pushToolResult('{"timedOut":false}')
		})
		sendMessageHandle.mockImplementation(async (_task, _block, callbacks) => {
			callbacks.pushToolResult('{"delivered":true}')
		})
		cancelAgentHandle.mockImplementation(async (_task, _block, callbacks) => {
			callbacks.pushToolResult('{"status":"cancelled"}')
		})
	})

	it("preserves typed arguments from raw chunks through presentation dispatch", async () => {
		const taskId = "parent-task"
		const toolCallId = "call_spawn_agent"
		const nativeArgs = {
			task_name: "lifecycle_inspector",
			fork_turns: "all" as const,
			objective: "Inspect the sub-agent lifecycle without modifying files.",
			agent_kind: "explore" as const,
			write_scope: null,
			expected_output: ["lifecycle sequence", "cancellation behavior", "file and symbol references"],
		}
		const serializedArgs = JSON.stringify(nativeArgs)
		const splitAt = serializedArgs.indexOf('"write_scope"')
		const rawEvents: ToolCallStreamEvent[] = [
			...NativeToolCallParser.processRawChunk({ index: 0, id: toolCallId, name: "spawn_agent" }, taskId),
			...NativeToolCallParser.processRawChunk({ index: 0, arguments: serializedArgs.slice(0, splitAt) }, taskId),
			...NativeToolCallParser.processRawChunk({ index: 0, arguments: serializedArgs.slice(splitAt) }, taskId),
			...NativeToolCallParser.finalizeRawChunks(taskId),
		]

		const task = {
			taskId,
			instanceId: "parent-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [] as Array<Record<string, unknown>>,
			userMessageContent: [] as Array<Record<string, unknown>>,
			streamingToolCallIndices: new Map<string, number>(),
			didCompleteReadingStream: true,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			api: {
				getModel: () => ({ id: "test-model", info: {} }),
			},
			getTaskMode: vi.fn().mockResolvedValue("code"),
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: { customTools: false },
						disabledTools: [],
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			pushToolResultToUserContent: vi.fn(function (this: { userMessageContent: unknown[] }, result) {
				this.userMessageContent.push(result)
				return true
			}),
		}
		const processNativeToolCallStreamEvents = (
			Task.prototype as unknown as {
				processNativeToolCallStreamEvents(events: ToolCallStreamEvent[]): void
			}
		).processNativeToolCallStreamEvents

		processNativeToolCallStreamEvents.call(task, rawEvents)

		expect(task.assistantMessageContent).toHaveLength(1)
		expect(task.assistantMessageContent[0]).toMatchObject({
			id: toolCallId,
			type: "tool_use",
			name: "spawn_agent",
			partial: false,
			nativeArgs,
		})

		await presentAssistantMessage(task as never)

		expect(spawnAgentTool.handle).toHaveBeenCalledOnce()
		expect(spawnAgentTool.handle).toHaveBeenCalledWith(
			task,
			expect.objectContaining({
				id: toolCallId,
				name: "spawn_agent",
				nativeArgs,
			}),
			expect.objectContaining({ toolCallId }),
		)
		expect(task.recordToolError).not.toHaveBeenCalledWith(
			"spawn_agent",
			expect.stringContaining("missing nativeArgs"),
		)
		expect(task.userMessageContent).not.toContainEqual(
			expect.objectContaining({
				is_error: true,
				content: expect.stringContaining("missing nativeArgs"),
			}),
		)
	})

	it("executes two spawn_agent calls from one provider response and resolves after both ordered results", async () => {
		const taskId = "parallel-parent"
		const calls = [
			{
				id: "call_spawn_explorer",
				args: {
					task_name: "backend_explorer",
					fork_turns: "none" as const,
					objective: "Inspect the backend.",
					agent_kind: "explore" as const,
					write_scope: null,
					expected_output: ["backend findings"],
				},
			},
			{
				id: "call_spawn_reviewer",
				args: {
					task_name: "frontend_reviewer",
					fork_turns: "2" as const,
					objective: "Review the frontend.",
					agent_kind: "review" as const,
					write_scope: null,
					expected_output: ["frontend findings"],
				},
			},
		]
		const rawEvents = calls.flatMap(({ id, args }, index) => [
			...NativeToolCallParser.processRawChunk({ index, id, name: "spawn_agent" }, taskId),
			...NativeToolCallParser.processRawChunk({ index, arguments: JSON.stringify(args) }, taskId),
		])
		rawEvents.push(...NativeToolCallParser.finalizeRawChunks(taskId))

		const task = createPresentationTask(taskId)
		const processNativeToolCallStreamEvents = (
			Task.prototype as unknown as {
				processNativeToolCallStreamEvents(events: ToolCallStreamEvent[]): void
			}
		).processNativeToolCallStreamEvents
		processNativeToolCallStreamEvents.call(task, rawEvents)
		let releaseSecondSpawn: () => void = () => undefined
		const secondSpawnMayFinish = new Promise<void>((resolve) => {
			releaseSecondSpawn = resolve
		})
		let markSecondSpawnStarted: () => void = () => undefined
		const secondSpawnStarted = new Promise<void>((resolve) => {
			markSecondSpawnStarted = resolve
		})
		spawnAgentHandle.mockImplementation(async (_task, block, callbacks) => {
			if (block.id === calls[1].id) {
				markSecondSpawnStarted()
				await secondSpawnMayFinish
			}
			callbacks.pushToolResult(JSON.stringify({ id: block.id, status: "running" }))
		})

		let presentationSettled = false
		const presentation = presentAssistantMessage(task as never).then(() => {
			presentationSettled = true
		})
		await secondSpawnStarted
		await Promise.resolve()
		expect(presentationSettled).toBe(false)
		releaseSecondSpawn()
		await presentation

		expect(spawnAgentHandle).toHaveBeenCalledTimes(2)
		expect(spawnAgentHandle.mock.calls.map(([, block]) => block.id)).toEqual(calls.map(({ id }) => id))
		expect(task.userMessageContent).toEqual([
			expect.objectContaining({
				tool_use_id: calls[0].id,
				content: JSON.stringify({ id: calls[0].id, status: "running" }),
			}),
			expect.objectContaining({
				tool_use_id: calls[1].id,
				content: JSON.stringify({ id: calls[1].id, status: "running" }),
			}),
		])
		expect(task.userMessageContentReady).toBe(true)
	})

	it("executes an ordered lifecycle control batch without returning after its first result", async () => {
		const task = createPresentationTask("lifecycle-parent")
		task.assistantMessageContent = [
			createToolUse("call_list", "list_agents", {}),
			createToolUse("call_send", "send_message", { target: "/root/review", message: "Focus on risk." }),
			createToolUse("call_cancel", "cancel_agent", { target: "/root/review" }),
		]

		await presentAssistantMessage(task as never)

		expect(listAgentsTool.handle).toHaveBeenCalledOnce()
		expect(sendMessageTool.handle).toHaveBeenCalledOnce()
		expect(cancelAgentTool.handle).toHaveBeenCalledOnce()
		expect(task.userMessageContent.map((result) => result.tool_use_id)).toEqual([
			"call_list",
			"call_send",
			"call_cancel",
		])
		expect(task.userMessageContentReady).toBe(true)
	})

	it("executes spawn then immediate named steering in provider order", async () => {
		const task = createPresentationTask("named-steering-parent")
		task.assistantMessageContent = [
			createToolUse("call_spawn", "spawn_agent", {
				task_name: "backend_review",
				fork_turns: "none",
				objective: "Review the backend lifecycle.",
				agent_kind: "review",
				write_scope: null,
				expected_output: ["findings"],
			}),
			createToolUse("call_send", "send_message", {
				target: "backend_review",
				message: "Prioritize cancellation ordering.",
			}),
		]
		let spawned = false
		spawnAgentHandle.mockImplementation(async (_task, _block, callbacks) => {
			spawned = true
			callbacks.pushToolResult('{"task_name":"backend_review","status":"pending"}')
		})
		sendMessageHandle.mockImplementation(async (_task, _block, callbacks) => {
			expect(spawned).toBe(true)
			callbacks.pushToolResult('{"delivery":"queued"}')
		})

		await presentAssistantMessage(task as never)

		expect(spawnAgentHandle).toHaveBeenCalledOnce()
		expect(sendMessageHandle).toHaveBeenCalledOnce()
		expect(task.userMessageContent.map((result) => result.tool_use_id)).toEqual(["call_spawn", "call_send"])
	})

	it("rejects a wait_agent batch before any lifecycle control executes", async () => {
		const task = createPresentationTask("wait-parent")
		task.assistantMessageContent = [
			createToolUse("call_wait", "wait_agent", { timeout_ms: 10_000 }),
			createToolUse("call_list", "list_agents", {}),
		]

		await presentAssistantMessage(task as never)

		expect(waitAgentTool.handle).not.toHaveBeenCalled()
		expect(listAgentsTool.handle).not.toHaveBeenCalled()
		expect(task.userMessageContent).toEqual([
			expect.objectContaining({ tool_use_id: "call_wait", is_error: true }),
			expect.objectContaining({ tool_use_id: "call_list", is_error: true }),
		])
		expect(task.userMessageContentReady).toBe(true)
	})

	it.each(["new_task", "delegate_task", "attempt_completion", "switch_mode", "ask_followup_question", "wait_agent"])(
		"keeps %s isolated from multi-tool batches",
		(toolName) => {
			expect(getToolBatchIsolationError([toolName, "list_agents"])).toContain("must be called alone")
			expect(isBatchableAgentToolSequence([toolName, "list_agents"])).toBe(false)
		},
	)
})

function createToolUse(id: string, name: string, nativeArgs: Record<string, unknown>) {
	return {
		type: "tool_use" as const,
		id,
		name,
		params: nativeArgs,
		nativeArgs,
		partial: false,
	}
}

function createPresentationTask(taskId: string) {
	return {
		taskId,
		instanceId: `${taskId}-instance`,
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [] as Array<Record<string, unknown>>,
		userMessageContent: [] as Array<Record<string, unknown>>,
		userMessageContentReady: false,
		streamingToolCallIndices: new Map<string, number>(),
		didCompleteReadingStream: true,
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		clineMessages: [],
		api: {
			getModel: () => ({ id: "test-model", info: {} }),
		},
		getTaskMode: vi.fn().mockResolvedValue("code"),
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: {
			check: vi.fn().mockReturnValue({ allowExecution: true }),
		},
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({
					mode: "code",
					customModes: [],
					experiments: { customTools: false },
					disabledTools: [],
				}),
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		pushToolResultToUserContent: vi.fn(function (this: { userMessageContent: unknown[] }, result) {
			this.userMessageContent.push(result)
			return true
		}),
	}
}
