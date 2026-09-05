import type Anthropic from "@anthropic-ai/sdk"
import { TelemetryService } from "@alpha-code/telemetry"

import type { ApiHandler, ApiHandlerCountTokensMetadata, ApiHandlerCreateMessageMetadata } from "../../../api"
import { manageContext } from "../../context-management"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import {
	countContextTokens,
	countHistoryTokens,
	createTokenCountContext,
	DEFAULT_TOKEN_COUNT_CACHE_ENTRIES,
	hasToolCallResultIntegrity,
	selectRecentTail,
	summarizeConversation,
} from "../index"

const TEST_START = new Date("2026-09-04T12:00:00.000Z")

function createHandler(
	countTokens: (
		content: Anthropic.Messages.ContentBlockParam[],
		metadata?: ApiHandlerCountTokensMetadata,
	) => Promise<number>,
	getModelId: () => string = () => "test-model",
): ApiHandler {
	return {
		createMessage: () =>
			(async function* () {
				yield { type: "text" as const, text: "summary" }
			})(),
		getModel: () => ({
			id: getModelId(),
			info: { contextWindow: 100_000, maxTokens: 4_096, supportsPromptCache: false },
		}),
		countTokens,
	}
}

describe("operation-scoped context token counting", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it.each([120, 480])("bounds a stalled %i-message workload with one remote allowance", async (messageCount) => {
		vi.useFakeTimers()
		vi.setSystemTime(TEST_START)
		const countTokens = vi.fn(
			(_content: Anthropic.Messages.ContentBlockParam[], _metadata?: ApiHandlerCountTokensMetadata) =>
				new Promise<number>(() => undefined),
		)
		const handler = createHandler(countTokens)
		const messages: Anthropic.MessageParam[] = Array.from({ length: messageCount }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `message-${index}`,
		}))

		const pending = countContextTokens(messages, handler, "system prompt")
		await Promise.resolve()

		expect(countTokens).toHaveBeenCalledTimes(1)
		const metadata = countTokens.mock.calls[0][1]
		expect(metadata?.remoteDeadline).toBe(TEST_START.getTime() + 5_000)

		await vi.advanceTimersByTimeAsync(5_000)
		await expect(pending).resolves.toBeGreaterThan(0)
		expect(countTokens).toHaveBeenCalledTimes(1)
		expect(Date.now() - TEST_START.getTime()).toBe(5_000)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("passes one absolute deadline to every healthy count and preserves exact results", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(TEST_START)
		const countTokens = vi.fn(
			async (content: Anthropic.Messages.ContentBlockParam[], _metadata?: ApiHandlerCountTokensMetadata) =>
				content.length + 2,
		)
		const handler = createHandler(countTokens)
		const messages: Anthropic.MessageParam[] = Array.from({ length: 120 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `message-${index}`,
		}))

		const result = await countContextTokens(messages, handler, "system prompt")

		expect(result).toBe(3 + 120 * 4)
		expect(countTokens).toHaveBeenCalledTimes(121)
		const deadlines = new Set(countTokens.mock.calls.map((call) => call[1]?.remoteDeadline))
		expect(deadlines).toEqual(new Set([TEST_START.getTime() + 5_000]))
	})

	it("cancels a pending count promptly, removes its timer, and makes no further calls", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(TEST_START)
		const countTokens = vi.fn(
			(_content: Anthropic.Messages.ContentBlockParam[], _metadata?: ApiHandlerCountTokensMetadata) =>
				new Promise<number>(() => undefined),
		)
		const handler = createHandler(countTokens)
		const controller = new AbortController()
		const context = createTokenCountContext(handler, { signal: controller.signal })
		const messages: Anthropic.MessageParam[] = Array.from({ length: 120 }, (_, index) => ({
			role: "user",
			content: `message-${index}`,
		}))
		const pending = countContextTokens(messages, handler, "system", undefined, context)
		await Promise.resolve()

		controller.abort(new DOMException("cancelled by caller", "AbortError"))

		await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled by caller" })
		expect(countTokens).toHaveBeenCalledTimes(1)
		expect(countTokens.mock.calls[0][1]?.signal).toBe(controller.signal)
		expect(vi.getTimerCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(countTokens).toHaveBeenCalledTimes(1)
	})

	it("checks cancellation before returning a cached value", async () => {
		const countTokens = vi.fn(async () => 7)
		const handler = createHandler(countTokens)
		const controller = new AbortController()
		const context = createTokenCountContext(handler, { signal: controller.signal })
		const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "cached" }]
		expect(await context.countTokens(content, handler)).toBe(7)
		controller.abort(new DOMException("stop", "AbortError"))

		await expect(context.countTokens(content, handler)).rejects.toMatchObject({ name: "AbortError" })
		expect(countTokens).toHaveBeenCalledTimes(1)
	})

	it("accepts semantic emptiness but fails closed on exact zero for countable content", async () => {
		const countTokens = vi.fn(async () => 0)
		const handler = createHandler(countTokens)
		const context = createTokenCountContext(handler)

		expect(await context.countTokens([], handler)).toBe(0)
		expect(await context.countTokens([{ type: "text", text: "" }], handler)).toBe(0)
		expect(await context.countTokens([{ type: "text", text: "count me" }], handler)).toBeNaN()
		expect(
			await context.countTokens(
				[{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "file.ts" } }],
				handler,
			),
		).toBeNaN()
		expect(await context.countTokens([{ type: "text", text: "count me" }], handler)).toBeNaN()
		expect(countTokens).toHaveBeenCalledTimes(3)
	})

	it("stops context management instead of proceeding on a zero undercount", async () => {
		const countTokens = vi.fn(async () => 0)
		const handler = createHandler(countTokens)
		const messages: ApiMessage[] = [
			{ role: "user", content: "Initial instruction", ts: 1 },
			{ role: "assistant", content: "Completed work", ts: 2 },
			{ role: "user", content: "Continue", ts: 3 },
		]

		const result = await manageContext({
			messages,
			totalTokens: 500,
			contextWindow: 2_000,
			maxTokens: 200,
			apiHandler: handler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 80,
			systemPrompt: "system",
			taskId: "task",
			profileThresholds: {},
			currentProfileId: "default",
		})

		expect(result.status).toBe("no_progress")
		expect(result.messages).toBe(messages)
		expect(result.prevContextTokens).toBeNaN()
		expect(countTokens).toHaveBeenCalledTimes(1)
	})

	it("does not recount after an invalid truncation count", async () => {
		const countTokens = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0)
		const handler = createHandler(countTokens)
		const messages: ApiMessage[] = [
			{ role: "user", content: "Initial instruction", ts: 1 },
			{ role: "assistant", content: "Completed work", ts: 2 },
			{ role: "user", content: "Continue", ts: 3 },
		]

		const result = await manageContext({
			messages,
			totalTokens: 1_800,
			contextWindow: 2_000,
			maxTokens: 200,
			apiHandler: handler,
			autoCondenseContext: false,
			autoCondenseContextPercent: 80,
			systemPrompt: "system",
			taskId: "task",
			profileThresholds: {},
			currentProfileId: "default",
		})

		expect(result.status).toBe("no_progress")
		expect(result.messages).toBe(messages)
		expect(result.newContextTokensAfterTruncation).toBeNaN()
		expect(countTokens).toHaveBeenCalledTimes(2)
	})

	it("snapshots an async workload before caller mutation and caches only that snapshot", async () => {
		let resolveCount!: () => void
		const countTokens = vi.fn(
			(content: Anthropic.Messages.ContentBlockParam[]) =>
				new Promise<number>((resolve) => {
					resolveCount = () =>
						resolve(content[0].type === "text" && content[0].text === "before mutation" ? 11 : 99)
				}),
		)
		const handler = createHandler(countTokens)
		const context = createTokenCountContext(handler)
		const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "before mutation" }]
		const pending = context.countTokens(content, handler)
		content[0] = { type: "text", text: "after mutation" }
		await vi.waitFor(() => expect(countTokens).toHaveBeenCalledTimes(1))
		resolveCount()

		expect(await pending).toBe(11)
		expect(await context.countTokens([{ type: "text", text: "before mutation" }], handler)).toBe(11)
		expect(countTokens).toHaveBeenCalledTimes(1)
	})

	it("serializes concurrent remote counts and coalesces identical queued workloads", async () => {
		const releases: Array<() => void> = []
		let activeCalls = 0
		let maximumActiveCalls = 0
		const countTokens = vi.fn(
			(content: Anthropic.Messages.ContentBlockParam[]) =>
				new Promise<number>((resolve) => {
					activeCalls++
					maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls)
					releases.push(() => {
						activeCalls--
						resolve(content[0].type === "text" ? content[0].text.length : 1)
					})
				}),
		)
		const handler = createHandler(countTokens)
		const context = createTokenCountContext(handler)
		const first = context.countTokens([{ type: "text", text: "first" }], handler)
		const duplicateFirst = context.countTokens([{ type: "text", text: "first" }], handler)
		const second = context.countTokens([{ type: "text", text: "second" }], handler)
		await vi.waitFor(() => expect(countTokens).toHaveBeenCalledTimes(1))

		expect(maximumActiveCalls).toBe(1)
		releases.shift()?.()
		await expect(first).resolves.toBe(5)
		await expect(duplicateFirst).resolves.toBe(5)
		await vi.waitFor(() => expect(countTokens).toHaveBeenCalledTimes(2))
		expect(maximumActiveCalls).toBe(1)
		releases.shift()?.()

		await expect(second).resolves.toBe(6)
		expect(maximumActiveCalls).toBe(1)
		expect(countTokens).toHaveBeenCalledTimes(2)
	})

	it("discards an async exact count when the handler changes models before it settles", async () => {
		let modelId = "model-a"
		let resolveCount!: (value: number) => void
		const countTokens = vi
			.fn<(content: Anthropic.Messages.ContentBlockParam[]) => Promise<number>>()
			.mockImplementationOnce(
				() =>
					new Promise<number>((resolve) => {
						resolveCount = resolve
					}),
			)
			.mockResolvedValueOnce(7)
		const handler = createHandler(countTokens, () => modelId)
		const context = createTokenCountContext(handler)
		const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "model-bound" }]
		const pending = context.countTokens(content, handler)
		await vi.waitFor(() => expect(countTokens).toHaveBeenCalledTimes(1))
		modelId = "model-b"
		resolveCount(1)

		const conservativeFloor = new TextEncoder().encode(JSON.stringify(content)).byteLength
		await expect(pending).resolves.toBe(conservativeFloor)
		await expect(context.countTokens(content, handler)).resolves.toBe(7)
		expect(countTokens).toHaveBeenCalledTimes(2)
	})

	it("does not dispatch queued work captured for a stale model", async () => {
		let modelId = "model-a"
		let resolveFirst!: (value: number) => void
		const countTokens = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					resolveFirst = resolve
				}),
		)
		const handler = createHandler(countTokens, () => modelId)
		const context = createTokenCountContext(handler)
		const firstContent: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "first-model-a" }]
		const queuedContent: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "queued-model-a" }]
		const first = context.countTokens(firstContent, handler)
		const queued = context.countTokens(queuedContent, handler)
		await vi.waitFor(() => expect(countTokens).toHaveBeenCalledTimes(1))
		modelId = "model-b"
		resolveFirst(1)

		await expect(first).resolves.toBe(new TextEncoder().encode(JSON.stringify(firstContent)).byteLength)
		await expect(queued).resolves.toBe(new TextEncoder().encode(JSON.stringify(queuedContent)).byteLength)
		expect(countTokens).toHaveBeenCalledTimes(1)
	})

	it("keys its bounded cache by exact content, model, media, schema, and opaque state", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(TEST_START)
		let modelId = "model-a"
		let nextCount = 0
		const countTokens = vi.fn(async () => ++nextCount)
		const handler = createHandler(countTokens, () => modelId)
		const context = createTokenCountContext(handler, { maxCacheEntries: 32 })
		const text: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "alpha" }]

		expect(await context.countTokens(text, handler)).toBe(1)
		expect(await context.countTokens(structuredClone(text), handler)).toBe(1)
		text[0] = { type: "text", text: "beta" }
		expect(await context.countTokens(text, handler)).toBe(2)
		modelId = "model-b"
		expect(await context.countTokens(text, handler)).toBe(3)

		const firstImage: Anthropic.Messages.ContentBlockParam[] = [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]
		const secondImage = structuredClone(firstImage)
		;(secondImage[0] as Anthropic.Messages.ImageBlockParam).source.data = "BBBB"
		expect(await context.countTokens(firstImage, handler)).toBe(4)
		expect(await context.countTokens(secondImage, handler)).toBe(5)

		const firstTools: NonNullable<ApiHandlerCreateMessageMetadata["tools"]> = [
			{ type: "function", function: { name: "read", parameters: { type: "object" } } },
		]
		const secondTools: NonNullable<ApiHandlerCreateMessageMetadata["tools"]> = [
			{ type: "function", function: { name: "read", parameters: { type: "object", required: ["path"] } } },
		]
		await countContextTokens([], handler, "system", { taskId: "task", tools: firstTools }, context)
		await countContextTokens([], handler, "system", { taskId: "task", tools: secondTools }, context)

		const opaque = { type: "reasoning" as const, encrypted_content: "state-a", summary: [] }
		await countHistoryTokens([opaque], handler, context)
		await countHistoryTokens([{ ...opaque, encrypted_content: "state-b" }], handler, context)

		expect(countTokens).toHaveBeenCalledTimes(9)
	})

	it("evicts old exact workloads instead of growing the operation cache without bound", async () => {
		const countTokens = vi.fn(async () => 1)
		const handler = createHandler(countTokens)
		const context = createTokenCountContext(handler, { maxCacheEntries: 2 })
		const block = (text: string): Anthropic.Messages.ContentBlockParam[] => [{ type: "text", text }]

		await context.countTokens(block("a"), handler)
		await context.countTokens(block("b"), handler)
		await context.countTokens(block("c"), handler)
		await context.countTokens(block("a"), handler)

		expect(countTokens).toHaveBeenCalledTimes(4)
	})

	it("keeps the production cache ceiling when an internal caller requests a larger override", async () => {
		const countTokens = vi.fn(async () => 1)
		const handler = createHandler(countTokens)
		const context = createTokenCountContext(handler, { maxCacheEntries: Number.MAX_SAFE_INTEGER })
		const block = (text: string): Anthropic.Messages.ContentBlockParam[] => [{ type: "text", text }]

		for (let index = 0; index <= DEFAULT_TOKEN_COUNT_CACHE_ENTRIES; index += 1) {
			await context.countTokens(block(`entry-${index}`), handler)
		}
		await context.countTokens(block("entry-0"), handler)

		expect(countTokens).toHaveBeenCalledTimes(DEFAULT_TOKEN_COUNT_CACHE_ENTRIES + 2)
	})

	it("falls back conservatively for schemas, opaque state, media, and non-serializable blocks", async () => {
		const countTokens = vi.fn(async () => 1)
		const handler = createHandler(countTokens)
		const context = createTokenCountContext(handler, { remoteAllowanceMs: 0 })
		const tools: NonNullable<ApiHandlerCreateMessageMetadata["tools"]> = [
			{
				type: "function",
				function: {
					name: "inspect",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			},
		]
		const schemaCount = await countContextTokens([], handler, "system", { taskId: "task", tools }, context)
		const opaqueCount = await countHistoryTokens(
			[{ type: "reasoning", encrypted_content: "opaque-provider-state", summary: [{ text: "reasoning" }] }],
			handler,
			context,
		)
		const imageCount = await context.countTokens(
			[{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
			handler,
		)
		const cyclicInput: Record<string, unknown> = {}
		cyclicInput.self = cyclicInput
		const cyclicCount = await context.countTokens(
			[{ type: "tool_use", id: "cycle", name: "invalid-cycle", input: cyclicInput }],
			handler,
		)

		expect(schemaCount).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(tools)).byteLength)
		expect(opaqueCount).toBeGreaterThan("opaque-provider-state".length)
		expect(imageCount).toBe(100_000)
		expect(cyclicCount).toBe(100_000)
		expect(countTokens).not.toHaveBeenCalled()
	})

	it("uses a full-context media floor and never splits an exact tool transaction after timeout", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(TEST_START)
		const countTokens = vi.fn(() => new Promise<number>(() => undefined))
		const handler = createHandler(countTokens)
		const context = createTokenCountContext(handler, { remoteAllowanceMs: 100 })
		const messages: ApiMessage[] = [
			{ role: "user", content: "Inspect the screenshot", ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "image-1", name: "read_file", input: { path: "evidence.png" } }],
				ts: 2,
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "image-1",
						content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
					},
				],
				ts: 3,
			},
		]

		const pending = selectRecentTail(messages, handler, 99_999, 0, undefined, context)
		await vi.advanceTimersByTimeAsync(100)
		const result = await pending

		expect(result).toEqual({ startIndex: messages.length, tokens: 0, newestStepTooLarge: true })
		expect(countTokens).toHaveBeenCalledTimes(1)
		expect(hasToolCallResultIntegrity(messages)).toBe(true)
	})

	it("reuses a caller-owned allowance throughout forced context management", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(TEST_START)
		const countTokens = vi.fn(
			(_content: Anthropic.Messages.ContentBlockParam[], _metadata?: ApiHandlerCountTokensMetadata) =>
				new Promise<number>(() => undefined),
		)
		const handler = createHandler(countTokens)
		const context = createTokenCountContext(handler, { remoteAllowanceMs: 100 })
		const messages: ApiMessage[] = [
			{ role: "user", content: "Initial instruction ".repeat(30), ts: 1 },
			{ role: "assistant", content: "Older work ".repeat(30), ts: 2 },
			{ role: "user", content: "Follow-up instruction ".repeat(30), ts: 3 },
			{ role: "assistant", content: "Recent work ".repeat(30), ts: 4 },
			{ role: "user", content: "Continue", ts: 5 },
		]
		const pending = manageContext({
			messages,
			totalTokens: 0,
			contextWindow: 2_000,
			maxTokens: 200,
			apiHandler: handler,
			autoCondenseContext: false,
			autoCondenseContextPercent: 80,
			systemPrompt: "system",
			taskId: "task",
			profileThresholds: {},
			currentProfileId: "default",
			forceCompaction: true,
			countContext: context,
		})

		await vi.advanceTimersByTimeAsync(100)
		const result = await pending

		expect(result.prevContextTokens).toBeGreaterThan(0)
		expect(countTokens).toHaveBeenCalledTimes(1)
		expect(countTokens.mock.calls[0][1]?.remoteDeadline).toBe(context.remoteDeadline)
		expect(Date.now() - TEST_START.getTime()).toBe(100)
	})

	it("honors a direct 100ms deadline while summarizing with an implicit count context", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(TEST_START)
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		const countTokens = vi.fn(
			(_content: Anthropic.Messages.ContentBlockParam[], _metadata?: ApiHandlerCountTokensMetadata) =>
				new Promise<number>(() => undefined),
		)
		const handler = createHandler(countTokens)
		const messages: ApiMessage[] = [
			{ role: "user", content: "Initial instruction", ts: 1 },
			{ role: "assistant", content: "Completed work", ts: 2 },
			{ role: "user", content: "Continue", ts: 3 },
		]
		const deadline = TEST_START.getTime() + 100
		const pending = summarizeConversation({
			messages,
			apiHandler: handler,
			systemPrompt: "system",
			taskId: "task",
			metadata: { taskId: "task", deadline },
			maxContextTokens: 100_000,
			recentTailTokenBudget: 0,
		})
		await Promise.resolve()

		expect(countTokens).toHaveBeenCalledTimes(1)
		expect(countTokens.mock.calls[0][1]?.remoteDeadline).toBe(deadline)

		await vi.advanceTimersByTimeAsync(100)
		const result = await pending

		expect(result.status).toBe("reduced")
		expect(countTokens).toHaveBeenCalledTimes(1)
		expect(Date.now() - TEST_START.getTime()).toBe(100)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("honors a direct 100ms deadline while managing context with an implicit count context", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(TEST_START)
		const countTokens = vi.fn(
			(_content: Anthropic.Messages.ContentBlockParam[], _metadata?: ApiHandlerCountTokensMetadata) =>
				new Promise<number>(() => undefined),
		)
		const handler = createHandler(countTokens)
		const messages: ApiMessage[] = [
			{ role: "user", content: "Initial instruction ".repeat(30), ts: 1 },
			{ role: "assistant", content: "Older work ".repeat(30), ts: 2 },
			{ role: "user", content: "Follow-up instruction ".repeat(30), ts: 3 },
			{ role: "assistant", content: "Recent work ".repeat(30), ts: 4 },
			{ role: "user", content: "Continue", ts: 5 },
		]
		const deadline = TEST_START.getTime() + 100
		const pending = manageContext({
			messages,
			totalTokens: 0,
			contextWindow: 2_000,
			maxTokens: 200,
			apiHandler: handler,
			autoCondenseContext: false,
			autoCondenseContextPercent: 80,
			systemPrompt: "system",
			taskId: "task",
			profileThresholds: {},
			currentProfileId: "default",
			forceCompaction: true,
			metadata: { taskId: "task", deadline },
		})
		await Promise.resolve()

		expect(countTokens).toHaveBeenCalledTimes(1)
		expect(countTokens.mock.calls[0][1]?.remoteDeadline).toBe(deadline)

		await vi.advanceTimersByTimeAsync(100)
		const result = await pending

		expect(result.prevContextTokens).toBeGreaterThan(0)
		expect(countTokens).toHaveBeenCalledTimes(1)
		expect(Date.now() - TEST_START.getTime()).toBe(100)
		expect(vi.getTimerCount()).toBe(0)
	})
})
