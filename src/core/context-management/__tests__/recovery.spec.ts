import Anthropic from "@anthropic-ai/sdk"
import type { ApiHandler } from "../../../api"
import { TelemetryService } from "@alpha-code/telemetry"
import * as condenseModule from "../../condense"

import {
	DEFAULT_MIN_REDUCTION_PERCENT,
	evaluateCompactionProgress,
	getCompactionTargetTokens,
	isAutoCondenseLimitReached,
	isPostTurnCondenseDue,
	manageContext,
	truncateConversation,
	willManageContext,
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

		const requestMetadata = (handler.createMessage as import("vitest").Mock).mock.calls[0][2]
		expect(requestMetadata).toMatchObject({ tools: [], tool_choice: "none", parallelToolCalls: false })
	})

	it("requires a measured decrease, reaching the target or reducing at least ten percent", () => {
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
		expect(getCompactionTargetTokens({ contextWindow: 1000, reservedTokens: 200 })).toBe(200)
	})

	it("counts growth after the saved prefix while retaining the full input limit", () => {
		const options = {
			totalTokens: 600,
			lastMessageTokens: 0,
			contextWindow: 1000,
			maxTokens: 100,
			autoCondenseContext: true,
			autoCondenseContextPercent: 50,
			profileThresholds: {},
			currentProfileId: "default",
		} as const
		expect(willManageContext(options)).toBe(true)
		expect(
			willManageContext({ ...options, autoCondenseContextScope: "after-prefix", prefillContextTokens: 500 }),
		).toBe(false)
		expect(willManageContext({ ...options, autoCondenseContextScope: "after-prefix" })).toBe(false)
		expect(isAutoCondenseLimitReached(800, 500, 800, "after-prefix", 500)).toBe(true)
	})

	it("disables turn-end compaction at zero and measures its percentage against the full limit", () => {
		expect(isPostTurnCondenseDue(700, 800, 500, 0)).toBe(false)
		expect(isPostTurnCondenseDue(639, 800, 500, 80, "after-prefix", 600)).toBe(false)
		expect(isPostTurnCondenseDue(640, 800, 500, 80, "after-prefix", 600)).toBe(true)
		expect(isPostTurnCondenseDue(800, 800, 500, 100, "after-prefix", 600)).toBe(true)
	})

	it("does not summarize a prefix whose new body remains below the configured limit", async () => {
		const handler = createCountingHandler()
		const messages: ApiMessage[] = [
			{ role: "user", content: "Start" },
			{ role: "assistant", content: "Done" },
			{ role: "user", content: "Continue" },
		]
		const result = await manageContext({
			messages,
			totalTokens: 600,
			contextWindow: 1000,
			maxTokens: 100,
			apiHandler: handler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 50,
			autoCondenseContextScope: "after-prefix",
			prefillContextTokens: 500,
			systemPrompt: "System",
			taskId: "task-1",
			profileThresholds: {},
			currentProfileId: "default",
		})
		expect(result.messages).toBe(messages)
		expect(handler.createMessage).not.toHaveBeenCalled()
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
		;(handler.createMessage as import("vitest").Mock).mockImplementation(() => {
			throw new Error("summary unavailable")
		})
		const messages: ApiMessage[] = [
			{ role: "user", content: "One" },
			{ role: "assistant", content: "Two" },
			{ role: "user", content: "Three".repeat(200) },
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

	it("preserves history when proactive summarization fails below the input limit", async () => {
		const handler = createCountingHandler()
		const messages: ApiMessage[] = [
			{ role: "user", content: "Keep the original instructions." },
			{ role: "assistant", content: "B".repeat(20) },
			{ role: "user", content: "C".repeat(200) },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "D".repeat(200) }] },
			{ role: "assistant", content: "E".repeat(200), reasoning_content: "opaque provider state" },
			{ role: "user", content: "Continue under the same constraints." },
		]
		const summarizer = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
			messages,
			summary: "",
			cost: 0.01,
			error: "Summary request rate limited",
			status: "no_progress",
		})
		try {
			expect(await condenseModule.countContextTokens(messages, handler, "System")).toBeLessThan(800)
			const result = await manageContext({
				messages,
				totalTokens: 600,
				contextWindow: 1000,
				maxTokens: 100,
				apiHandler: handler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50,
				systemPrompt: "System",
				taskId: "task-1",
			})

			expect(summarizer).toHaveBeenCalledOnce()
			expect(result.messages).toBe(messages)
			expect(result.status).toBe("unchanged")
			expect(result.error).toBe("Summary request rate limited")
			expect(result.cost).toBe(0.01)
			expect(result.truncationId).toBeUndefined()
			expect(hasToolCallResultIntegrity(result.messages)).toBe(true)
			expect(result.messages[5].reasoning_content).toBe("opaque provider state")
		} finally {
			summarizer.mockRestore()
		}
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
	it.each([600, 100_000])(
		"continues fitting input after a failed early summary with usage %s",
		async (totalTokens) => {
			const handler = createCountingHandler()
			vi.mocked(handler.createMessage).mockImplementation(async function* () {
				yield { type: "usage", inputTokens: 1, outputTokens: 1, totalCost: 0.01 }
				throw new Error("Summary provider unavailable")
			})
			const messages: ApiMessage[] = [
				{ role: "user", content: "Preserve every requirement." },
				{ role: "assistant", content: "A".repeat(500), reasoning_content: "opaque provider state" },
				{ role: "user", content: "Continue." },
			]
			const measured = await condenseModule.countContextTokens(messages, handler, "System")
			const result = await manageContext({
				messages,
				totalTokens,
				contextWindow: 1000,
				maxTokens: 100,
				apiHandler: handler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 30,
				systemPrompt: "System",
				taskId: "proactive-failure",
			})
			expect(result.status).toBe("unchanged")
			expect(result.messages).toBe(messages)
			expect(result.newContextTokens).toBe(measured)
			expect(result.prevContextTokens).toBe(measured)
			expect(result.error).toBeDefined()
			expect(result.errorDetails).toContain("Summary provider unavailable")
			expect(result.cost).toBe(0.01)
			expect(result.truncationId).toBeUndefined()
			expect(result.messages[1].reasoning_content).toBe("opaque provider state")
			expect(handler.createMessage).toHaveBeenCalledOnce()
		},
	)

	it("reduces actual over-limit input after summary failure despite a stale low estimate", async () => {
		const handler = createCountingHandler()
		vi.mocked(handler.createMessage).mockImplementation(async function* () {
			yield { type: "usage" as const, inputTokens: 0, outputTokens: 0, totalCost: 0 }
			throw new Error("Summary unavailable")
		})
		const messages: ApiMessage[] = [
			{ role: "user", content: "Keep the original requirement." },
			{ role: "assistant", content: "Older evidence ".repeat(100) },
			{ role: "user", content: "Continue." },
		]
		const result = await manageContext({
			messages,
			totalTokens: 350,
			contextWindow: 1000,
			maxTokens: 100,
			apiHandler: handler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 30,
			systemPrompt: "System",
			taskId: "actual-over-limit",
		})
		expect(result.status).not.toBe("unchanged")
		if (result.status === "reduced") {
			expect(result.newContextTokensAfterTruncation).toBeLessThan(result.prevContextTokens)
			expect(result.newContextTokensAfterTruncation).toBeLessThanOrEqual(800)
		} else {
			expect(["exhausted", "no_progress"]).toContain(result.status)
		}
		expect(handler.createMessage).toHaveBeenCalledOnce()
	})

	it("cancels a pending retained-input recount without admitting another request", async () => {
		const handler = createCountingHandler()
		const messages: ApiMessage[] = [
			{ role: "user", content: "Original requirement" },
			{ role: "assistant", content: "Older evidence" },
			{ role: "user", content: "Continue" },
		]
		let countStarted!: () => void
		let releaseCount!: () => void
		const started = new Promise<void>((resolve) => (countStarted = resolve))
		const release = new Promise<void>((resolve) => (releaseCount = resolve))
		vi.mocked(handler.countTokens).mockImplementation(async (blocks) => {
			if (JSON.stringify(blocks).includes("Older evidence")) {
				countStarted()
				await release
			}
			return blocks.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0)
		})
		const summarizer = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
			messages,
			summary: "",
			cost: 0.01,
			error: "Summary unavailable",
			status: "no_progress",
		})
		const control = new AbortController()
		const pending = manageContext({
			messages,
			totalTokens: 600,
			contextWindow: 1000,
			maxTokens: 100,
			apiHandler: handler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 30,
			systemPrompt: "System",
			taskId: "cancel-retained-recount",
			metadata: { taskId: "cancel-retained-recount", signal: control.signal },
		})
		try {
			expect(await Promise.race([started.then(() => true), pending.then(() => false)])).toBe(true)
			const reason = new DOMException("Task cancelled during recount", "AbortError")
			const rejected = expect(pending).rejects.toBe(reason)
			control.abort(reason)
			releaseCount()
			await rejected
			expect(handler.createMessage).not.toHaveBeenCalled()
			expect(messages[1].content).toBe("Older evidence")
		} finally {
			releaseCount()
			summarizer.mockRestore()
		}
	})
})
