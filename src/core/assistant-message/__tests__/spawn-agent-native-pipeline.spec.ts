import { beforeEach, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser, type ToolCallStreamEvent } from "../NativeToolCallParser"
import {
	getToolBatchIsolationError,
	isBatchableAgentToolSequence,
	presentAssistantMessage,
} from "../presentAssistantMessage"
import { Task } from "../../task/Task"
import { AskIgnoredError } from "../../task/AskIgnoredError"
import { spawnAgentTool } from "../../tools/SpawnAgentTool"
import { listAgentsTool } from "../../tools/ListAgentsTool"
import { waitAgentTool } from "../../tools/WaitAgentTool"
import { sendMessageTool } from "../../tools/SendMessageTool"
import { cancelAgentTool } from "../../tools/CancelAgentTool"
import { validateToolUse } from "../../tools/validateToolUse"
import { readFileTool } from "../../tools/ReadFileTool"
import { askFollowupQuestionTool } from "../../tools/AskFollowupQuestionTool"

const {
	spawnAgentHandle,
	listAgentsHandle,
	waitAgentHandle,
	sendMessageHandle,
	cancelAgentHandle,
	readFileHandle,
	askFollowupQuestionHandle,
} = vi.hoisted(() => ({
	spawnAgentHandle: vi.fn(),
	listAgentsHandle: vi.fn(),
	waitAgentHandle: vi.fn(),
	sendMessageHandle: vi.fn(),
	cancelAgentHandle: vi.fn(),
	readFileHandle: vi.fn(),
	askFollowupQuestionHandle: vi.fn(),
}))

vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) =>
		[
			"spawn_agent",
			"list_agents",
			"wait_agent",
			"send_message",
			"cancel_agent",
			"read_file",
			"ask_followup_question",
		].includes(toolName),
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
vi.mock("../../tools/ReadFileTool", () => ({
	readFileTool: {
		handle: readFileHandle,
		getReadFileToolDescription: vi.fn(() => "[read_file]"),
	},
}))
vi.mock("../../tools/AskFollowupQuestionTool", () => ({
	askFollowupQuestionTool: {
		handle: askFollowupQuestionHandle,
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
		readFileHandle.mockImplementation(async (_task, _block, callbacks) => {
			callbacks.pushToolResult("file contents")
		})
		askFollowupQuestionHandle.mockImplementation(async (_task, _block, callbacks) => {
			callbacks.pushToolResult("question answered")
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
			getTaskMode: vi.fn().mockResolvedValue("architect"),
			getTaskToolDenialReason: vi.fn((_name: string, params: Record<string, unknown>) =>
				params.write_scope === null ? undefined : "Plan-mode spawn_agent requires a read-only scope.",
			),
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "architect",
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
		spawnAgentHandle.mockImplementationOnce(async (_task, _block, callbacks) => {
			expect(await callbacks.askApproval("tool", "{}")).toBe(true)
			callbacks.pushToolResult('{"runId":"run-1","status":"running"}')
		})

		processNativeToolCallStreamEvents.call(task, rawEvents)

		expect(task.assistantMessageContent).toHaveLength(1)
		expect(task.assistantMessageContent[0]).toMatchObject({
			id: toolCallId,
			type: "tool_use",
			name: "spawn_agent",
			partial: false,
			nativeArgs,
			params: expect.objectContaining({
				write_scope: "null",
				expected_output: JSON.stringify(nativeArgs.expected_output),
			}),
		})

		await presentAssistantMessage(task as never)

		expect(spawnAgentTool.handle).toHaveBeenCalledOnce()
		expect(task.getTaskToolDenialReason).toHaveBeenCalledWith("spawn_agent", nativeArgs)
		expect(vi.mocked(validateToolUse).mock.calls.map((call) => call[4])).toEqual([nativeArgs, nativeArgs])
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

	it("treats a superseded spawn approval as a rejection and releases the presentation lock", async () => {
		const task = createPresentationTask("superseded-approval-parent")
		task.assistantMessageContent = [
			createToolUse("call_spawn_superseded", "spawn_agent", {
				task_name: "reviewer",
				fork_turns: "none",
				objective: "Review the lifecycle.",
				agent_kind: "review",
				write_scope: null,
				expected_output: ["findings"],
			}),
		]
		task.ask.mockRejectedValueOnce(new AskIgnoredError("superseded"))
		spawnAgentHandle.mockImplementationOnce(async (_task, _block, callbacks) => {
			expect(await callbacks.askApproval("tool", "{}")).toBe(false)
		})

		await expect(presentAssistantMessage(task as never)).resolves.toBeUndefined()

		expect(task.didRejectTool).toBe(true)
		expect(task.presentAssistantMessageLocked).toBe(false)
		expect(task.userMessageContent).toEqual([
			expect.objectContaining({
				tool_use_id: "call_spawn_superseded",
				content: expect.stringContaining("Approval request was superseded"),
				is_error: true,
			}),
		])
	})

	it("emits an error result when a complete tool-internal ask is superseded", async () => {
		const task = createPresentationTask("superseded-followup-parent")
		task.assistantMessageContent = [
			createToolUse("call_followup_superseded", "ask_followup_question", {
				question: "Continue?",
				follow_up: [{ text: "Yes", mode: null }],
			}),
		]
		task.ask.mockRejectedValueOnce(new AskIgnoredError("superseded"))
		askFollowupQuestionHandle.mockImplementationOnce(async (cline, _block, callbacks) => {
			try {
				await cline.ask("followup", "{}", false)
			} catch (error) {
				await callbacks.handleError("asking a follow-up question", error)
			}
		})

		await expect(presentAssistantMessage(task as never)).resolves.toBeUndefined()

		expect(askFollowupQuestionTool.handle).toHaveBeenCalledOnce()
		expect(task.didRejectTool).toBe(true)
		expect(task.userMessageContent).toEqual([
			expect.objectContaining({
				tool_use_id: "call_followup_superseded",
				content: expect.stringContaining("Approval request was superseded"),
				is_error: true,
			}),
		])
		expect(task.currentStreamingContentIndex).toBe(1)
		expect(task.userMessageContentReady).toBe(true)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("upgrades a provisional result when its handler rejects and continues in order", async () => {
		const task = createPresentationTask("failed-handler-parent")
		const privateWorkspaceRoot = "C:\\private\\agent-worktree"
		task.taskKind = "subagent"
		task.subagentRole = "worker"
		task.cwd = privateWorkspaceRoot
		task.subagentPrivateWorkspaceRoot = privateWorkspaceRoot
		task.assistantMessageContent = [
			createToolUse("call_spawn_failed", "spawn_agent", {}),
			createToolUse("call_list_after_failure", "list_agents", {}),
		]
		spawnAgentHandle.mockImplementationOnce(async (_task, _block, callbacks) => {
			callbacks.pushToolResult("provisional spawn result")
			throw new Error(`spawn failed in ${privateWorkspaceRoot}\\src\\index.ts`)
		})

		await expect(presentAssistantMessage(task as never)).resolves.toBeUndefined()

		expect(task.presentAssistantMessageLocked).toBe(false)
		expect(task.userMessageContent).toEqual([
			expect.objectContaining({
				tool_use_id: "call_spawn_failed",
				content: expect.stringContaining("spawn failed"),
				is_error: true,
			}),
			expect.objectContaining({
				tool_use_id: "call_list_after_failure",
				content: '{"agents":[]}',
			}),
		])
		expect(listAgentsTool.handle).toHaveBeenCalledOnce()
		expect(task.userMessageContent[0].content).toContain("provisional spawn result")
		expect(task.userMessageContent[0].content).not.toContain("agent-worktree")
		expect(task.userMessageContentReady).toBe(true)
	})

	it("drains a final update queued at the lock-owner release boundary", async () => {
		const task = createPresentationTask("release-boundary-parent")
		task.didCompleteReadingStream = false
		task.assistantMessageContent = [{ type: "text", content: "streaming", partial: true }]
		let pendingUpdate = false
		let armBoundaryUpdate = false
		let scheduledBoundaryUpdate = false
		Object.defineProperty(task, "presentAssistantMessageHasPendingUpdates", {
			get() {
				if (armBoundaryUpdate && !scheduledBoundaryUpdate) {
					scheduledBoundaryUpdate = true
					queueMicrotask(() => {
						task.assistantMessageContent[0].partial = false
						task.assistantMessageContent[0].content = "complete"
						task.didCompleteReadingStream = true
						void presentAssistantMessage(task as never)
					})
				}
				return pendingUpdate
			},
			set(value: boolean) {
				pendingUpdate = value
			},
		})
		task.say.mockImplementation(async () => {
			armBoundaryUpdate = true
		})

		await presentAssistantMessage(task as never)

		expect(task.say).toHaveBeenCalledTimes(2)
		expect(task.say).toHaveBeenLastCalledWith("text", "complete", undefined, false)
		expect(task.currentStreamingContentIndex).toBe(1)
		expect(task.userMessageContentReady).toBe(true)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("keeps ordinary multi-block presentation pending until every handler settles", async () => {
		const task = createPresentationTask("ordinary-sequence-parent")
		task.assistantMessageContent = [
			createToolUse("call_read_first", "read_file", { path: "first.ts" }),
			createToolUse("call_read_second", "read_file", { path: "second.ts" }),
		]
		let releaseSecondRead: () => void = () => undefined
		const secondReadMayFinish = new Promise<void>((resolve) => {
			releaseSecondRead = resolve
		})
		let markSecondReadStarted: () => void = () => undefined
		const secondReadStarted = new Promise<void>((resolve) => {
			markSecondReadStarted = resolve
		})
		readFileHandle.mockImplementation(async (_task, block, callbacks) => {
			if (block.id === "call_read_second") {
				markSecondReadStarted()
				await secondReadMayFinish
			}
			callbacks.pushToolResult(`${block.nativeArgs.path} contents`)
		})

		let presentationSettled = false
		const presentation = presentAssistantMessage(task as never).then(() => {
			presentationSettled = true
		})
		await secondReadStarted
		await Promise.resolve()

		expect(presentationSettled).toBe(false)
		releaseSecondRead()
		await presentation

		expect(readFileTool.handle).toHaveBeenCalledTimes(2)
		expect(task.userMessageContent.map((result) => result.tool_use_id)).toEqual([
			"call_read_first",
			"call_read_second",
		])
		expect(task.presentAssistantMessageLocked).toBe(false)
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

	it("passes the native wait tool call ID into claim retention", async () => {
		const task = createPresentationTask("wait-receipt-parent")
		task.assistantMessageContent = [createToolUse("call_wait_receipt", "wait_agent", { timeout_ms: 10_000 })]

		await presentAssistantMessage(task as never)

		expect(waitAgentHandle).toHaveBeenCalledOnce()
		expect(waitAgentHandle.mock.calls[0][2]).toMatchObject({ toolCallId: "call_wait_receipt" })
		expect(task.userMessageContent).toEqual([
			expect.objectContaining({ tool_use_id: "call_wait_receipt", content: '{"timedOut":false}' }),
		])
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
		taskKind: "primary" as "primary" | "subagent",
		subagentRole: undefined as string | undefined,
		cwd: "C:\\workspace",
		subagentPrivateWorkspaceRoot: undefined as string | undefined,
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
