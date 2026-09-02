import Anthropic from "@anthropic-ai/sdk"
import type { ApiHandler } from "../../../api"
import { TelemetryService } from "@alpha-code/telemetry"

import {
	DEFAULT_MIN_REDUCTION_PERCENT,
	evaluateCompactionProgress,
	getCompactionTargetTokens,
	manageContext,
	truncateConversation,
} from "../index"
import {
	getToolCallResultPairs,
	getToolFreeMetadata,
	hasToolCallResultIntegrity,
	summarizeConversation,
} from "../../condense"
import type { ApiMessage } from "../../task-persistence/apiMessages"

function createCountingHandler(): ApiHandler {
	return {
		createMessage: vi.fn().mockReturnValue(
			(async function* () {
				yield { type: "text" as const, text: "A concise summary" }
				yield { type: "usage" as const, inputTokens: 1, outputTokens: 1, totalCost: 0 }
			})(),
		),
		countTokens: vi.fn(async (content: Array<Anthropic.Messages.ContentBlockParam>) =>
			content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0),
		),
		getModel: vi.fn().mockReturnValue({ id: "test-model", info: { contextWindow: 1000, maxTokens: 100 } }),
	} as unknown as ApiHandler
}

describe("bounded context recovery policy", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	})

	it("uses explicit no-tools metadata for summarization without mutating the caller", async () => {
		const handler = createCountingHandler()
		const tools = [
			{
				type: "function" as const,
				function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
			},
		]
		const metadata = { taskId: "task-1", tools, tool_choice: "required" as const, parallelToolCalls: true }

		const sanitized = getToolFreeMetadata(metadata)
		expect(sanitized).toMatchObject({ tools: [], tool_choice: "none", parallelToolCalls: false })
		expect(sanitized?.allowedFunctionNames).toEqual([])
		expect(metadata.tools).toBe(tools)
		expect(metadata.tool_choice).toBe("required")

		await summarizeConversation({
			messages: [
				{ role: "user", content: "Start" },
				{ role: "assistant", content: "Working" },
				{ role: "user", content: "Continue" },
			],
			apiHandler: handler,
			systemPrompt: "System",
			taskId: "task-1",
			metadata,
		})

		const requestMetadata = (handler.createMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
		expect(requestMetadata).toMatchObject({ tools: [], tool_choice: "none", parallelToolCalls: false })
	})

	it("requires a measurable ten percent reduction unless the input is already under target", () => {
		expect(
			evaluateCompactionProgress({
				beforeTokens: 1000,
				afterTokens: 901,
				targetTokens: 700,
				minReductionPercent: DEFAULT_MIN_REDUCTION_PERCENT,
			}).status,
		).toBe("no_progress")
		expect(
			evaluateCompactionProgress({
				beforeTokens: 1000,
				afterTokens: 900,
				targetTokens: 700,
				minReductionPercent: DEFAULT_MIN_REDUCTION_PERCENT,
			}).status,
		).toBe("reduced")
		expect(
			evaluateCompactionProgress({
				beforeTokens: 600,
				afterTokens: 599,
				targetTokens: 700,
			}).status,
		).toBe("reduced")
		expect(getCompactionTargetTokens({ contextWindow: 1000, reservedTokens: 200 })).toBe(600)
	})

	it("keeps tool call/result pairs together when truncating", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "Initial task", ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } }],
				ts: 2,
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "contents" }], ts: 3 },
			{ role: "assistant", content: "Done", ts: 4 },
			{ role: "user", content: "Next", ts: 5 },
		]

		const result = truncateConversation(messages, 0.5, "task-1")
		const pair = getToolCallResultPairs(result.messages).get("call-1")
		expect(pair?.callMessageIndexes).toHaveLength(1)
		expect(pair?.resultMessageIndexes).toHaveLength(1)
		expect(result.messages[1].truncationParent).toBe(result.messages[2].truncationParent)
		expect(hasToolCallResultIntegrity(result.messages)).toBe(true)
	})

	it("falls back to one bounded truncation when summarization fails", async () => {
		const handler = createCountingHandler()
		;(handler.createMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("summary unavailable")
		})
		const messages: ApiMessage[] = [
			{ role: "user", content: "One" },
			{ role: "assistant", content: "Two" },
			{ role: "user", content: "Three" },
			{ role: "assistant", content: "Four" },
			{ role: "user", content: "Five" },
		]

		const result = await manageContext({
			messages,
			totalTokens: 901,
			contextWindow: 1000,
			maxTokens: 100,
			apiHandler: handler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 50,
			systemPrompt: "System",
			taskId: "task-1",
			profileThresholds: {},
			currentProfileId: "default",
		})

		expect(result.messagesRemoved).toBe(2)
		expect(result.status).toBe("reduced")
		expect(result.error).toBeDefined()
	})

	it("returns exhausted when truncation cannot change an unchanged input", async () => {
		const handler = createCountingHandler()
		const result = await manageContext({
			messages: [{ role: "user", content: "Only message" }],
			totalTokens: 901,
			contextWindow: 1000,
			maxTokens: 100,
			apiHandler: handler,
			autoCondenseContext: false,
			autoCondenseContextPercent: 100,
			systemPrompt: "System",
			taskId: "task-1",
			profileThresholds: {},
			currentProfileId: "default",
		})

		expect(result.messagesRemoved).toBe(0)
		expect(result.status).toBe("exhausted")
		expect(result.messages).toHaveLength(1)
	})
})
