import { beforeEach, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser, type ToolCallStreamEvent } from "../NativeToolCallParser"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { Task } from "../../task/Task"
import { spawnAgentTool } from "../../tools/SpawnAgentTool"

const { spawnAgentHandle } = vi.hoisted(() => ({
	spawnAgentHandle: vi.fn(),
}))

vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) => toolName === "spawn_agent"),
}))
vi.mock("../../tools/SpawnAgentTool", () => ({
	spawnAgentTool: {
		handle: spawnAgentHandle,
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
	})

	it("preserves typed arguments from raw chunks through presentation dispatch", async () => {
		const taskId = "parent-task"
		const toolCallId = "call_spawn_agent"
		const nativeArgs = {
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
})
