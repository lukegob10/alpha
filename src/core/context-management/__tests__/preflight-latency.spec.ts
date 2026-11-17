import type { ApiHandler } from "../../../api"
import { createTokenCountContext } from "../../condense"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { getContextManagementLastMessageTokens, manageContext, type WillManageContextOptions } from "../index"

const limits: Omit<WillManageContextOptions, "lastMessageTokens"> = {
	totalTokens: 1_000,
	contextWindow: 100_000,
	maxTokens: 1_000,
	autoCondenseContext: true,
	autoCondenseContextPercent: 100,
}

function provider(count = 7) {
	const countTokens = vi.fn(async () => count)
	const handler: ApiHandler = {
		countTokens,
		createMessage: vi.fn(),
		getModel: () => ({
			id: "latency-fixture",
			info: { contextWindow: 100_000, maxTokens: 1_000, supportsPromptCache: false },
		}),
	}
	return { handler, countTokens }
}

describe("context preflight latency", () => {
	afterEach(() => vi.useRealTimers())

	it("does not wait for a stalled tokenizer when text is provably below the compaction threshold", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const countTokens = vi.fn(() => new Promise<number>(() => undefined))
		const handler: ApiHandler = {
			countTokens,
			createMessage: vi.fn(),
			getModel: () => ({
				id: "latency-fixture",
				info: { contextWindow: 100_000, maxTokens: 1_000, supportsPromptCache: false },
			}),
		}
		for (let index = 0; index < 3; index++) {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Inspect the source" },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: `read-${index}`, content: "Found the requested symbol." },
					],
				},
			]
			const pending = manageContext({
				messages,
				totalTokens: 1_000,
				contextWindow: 100_000,
				maxTokens: 1_000,
				apiHandler: handler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System",
				taskId: "preflight-latency",
			})
			await vi.runAllTimersAsync()
			expect((await pending).messages).toBe(messages)
		}
		console.info("CONTEXT_PREFLIGHT_BENCHMARK", {
			steps: 3,
			elapsedMs: Date.now(),
			tokenCalls: countTokens.mock.calls.length,
		})
		expect(Date.now()).toBe(0)
		expect(countTokens).not.toHaveBeenCalled()
	})

	it("shares the exact count between the preview and management when the byte ceiling reaches the threshold", async () => {
		const { handler, countTokens } = provider()
		const countContext = createTokenCountContext(handler)
		const nearLimit = { ...limits, totalTokens: 88_990 }
		const messages: ApiMessage[] = [{ role: "user", content: "A small result" }]
		expect(await getContextManagementLastMessageTokens(messages[0].content, nearLimit, handler, countContext)).toBe(
			7,
		)
		const result = await manageContext({
			...nearLimit,
			messages,
			apiHandler: handler,
			countContext,
			systemPrompt: "System",
			taskId: "near-threshold",
		})
		expect(result.messages).toBe(messages)
		expect(result.prevContextTokens).toBe(88_997)
		expect(countTokens).toHaveBeenCalledOnce()
		expect(handler.createMessage).not.toHaveBeenCalled()
	})

	it("does not put the conservative preview into the authoritative count cache", async () => {
		const { handler, countTokens } = provider()
		const countContext = createTokenCountContext(handler)
		const content = [{ type: "text" as const, text: "A small result" }]
		expect(await getContextManagementLastMessageTokens(content, limits, handler, countContext)).toBeGreaterThan(7)
		expect(countTokens).not.toHaveBeenCalled()
		expect(await countContext.countTokens(content, handler)).toBe(7)
		expect(countTokens).toHaveBeenCalledOnce()
	})

	it.each([
		{ name: "configured threshold", options: { totalTokens: 49_990, autoCondenseContextPercent: 50 } },
		{ name: "reserved output", options: { totalTokens: 79_990, maxTokens: 10_000 } },
		{
			name: "after-prefix hard input limit",
			options: {
				totalTokens: 88_990,
				autoCondenseContextScope: "after-prefix" as const,
				prefillContextTokens: 88_000,
			},
		},
		{ name: "disabled condensation at input limit", options: { totalTokens: 89_000, autoCondenseContext: false } },
		{
			name: "disabled condensation over input limit",
			options: { totalTokens: 89_001, autoCondenseContext: false },
		},
	])("retains exact counts at $name", async ({ options }) => {
		const { handler, countTokens } = provider()
		const context = createTokenCountContext(handler)
		expect(
			await getContextManagementLastMessageTokens("A small result", { ...limits, ...options }, handler, context),
		).toBe(7)
		expect(countTokens).toHaveBeenCalledOnce()
	})

	it("uses the after-prefix scope when the complete input also remains below its hard limit", async () => {
		const { handler, countTokens } = provider()
		const context = createTokenCountContext(handler)
		expect(
			await getContextManagementLastMessageTokens(
				"A small result",
				{
					...limits,
					totalTokens: 70_000,
					autoCondenseContextPercent: 50,
					autoCondenseContextScope: "after-prefix",
					prefillContextTokens: 40_000,
				},
				handler,
				context,
			),
		).toBeGreaterThan(7)
		expect(countTokens).not.toHaveBeenCalled()
	})

	it.each<{ content: ApiMessage["content"] }>([
		{ content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
		{
			content: [
				{
					type: "tool_result",
					tool_use_id: "image",
					content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
				},
			],
		},
		{ content: [{ type: "thinking", thinking: "Opaque provider reasoning", signature: "signature" }] },
	])("keeps nontext content on the provider counter", async ({ content }) => {
		const { handler, countTokens } = provider()
		const context = createTokenCountContext(handler)
		expect(await getContextManagementLastMessageTokens(content, limits, handler, context)).toBe(7)
		expect(countTokens).toHaveBeenCalledOnce()
	})

	it.each([{ content: undefined }, { content: "" }, { content: [] }])(
		"preserves zero for empty content %j",
		async ({ content }) => {
			const { handler, countTokens } = provider()
			expect(
				await getContextManagementLastMessageTokens(content, limits, handler, createTokenCountContext(handler)),
			).toBe(0)
			expect(countTokens).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ totalTokens: Number.NaN },
		{ totalTokens: Number.POSITIVE_INFINITY },
		{ totalTokens: -1 },
		{ contextWindow: Number.NaN },
		{ contextWindow: 0 },
		{ maxTokens: Number.NaN },
		{ maxTokens: -1 },
		{ autoCondenseContextPercent: Number.NaN },
		{ prefillContextTokens: Number.NaN, autoCondenseContextScope: "after-prefix" as const },
		{ prefillContextTokens: -1, autoCondenseContextScope: "after-prefix" as const },
	])("does not infer a safe admission from invalid limit arithmetic %j", async (invalid) => {
		const { handler, countTokens } = provider()
		expect(
			await getContextManagementLastMessageTokens(
				"small",
				{ ...limits, ...invalid },
				handler,
				createTokenCountContext(handler),
			),
		).toBe(7)
		expect(countTokens).toHaveBeenCalledOnce()
	})

	it("bounds Unicode and nested text including tool identifiers and envelopes", async () => {
		const { handler, countTokens } = provider()
		const content: ApiMessage["content"] = [
			{
				type: "tool_result",
				tool_use_id: "読み取り-🧪",
				content: [
					{ type: "text", text: "文件已更新 🧪" },
					{ type: "text", text: "Second result" },
				],
			},
		]
		const tokens = await getContextManagementLastMessageTokens(
			content,
			limits,
			handler,
			createTokenCountContext(handler),
		)
		expect(tokens).toBe(Buffer.byteLength(JSON.stringify(content), "utf8"))
		expect(tokens).toBeGreaterThan(JSON.stringify(content).length)
		expect(countTokens).not.toHaveBeenCalled()
	})

	it("preserves the inclusive input limit when automatic condensation is disabled", async () => {
		const { handler, countTokens } = provider()
		const content = [{ type: "text" as const, text: "small" }]
		const ceiling = Buffer.byteLength(JSON.stringify(content), "utf8")
		const options = { ...limits, autoCondenseContext: false, totalTokens: 89_000 - ceiling }
		const context = createTokenCountContext(handler)
		expect(await getContextManagementLastMessageTokens(content, options, handler, context)).toBe(ceiling)
		expect(countTokens).not.toHaveBeenCalled()
		expect(
			await getContextManagementLastMessageTokens(
				content,
				{ ...options, totalTokens: options.totalTokens + 1 },
				handler,
				context,
			),
		).toBe(7)
		expect(countTokens).toHaveBeenCalledOnce()
	})

	it("honors cancellation before admitting a local text preview", async () => {
		const { handler, countTokens } = provider()
		const controller = new AbortController()
		const reason = new Error("Stopped during preflight")
		controller.abort(reason)
		await expect(
			getContextManagementLastMessageTokens(
				"small",
				limits,
				handler,
				createTokenCountContext(handler, { signal: controller.signal }),
			),
		).rejects.toBe(reason)
		expect(countTokens).not.toHaveBeenCalled()
	})
})
