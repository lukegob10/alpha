import type { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { XAIHandler } from "../xai"
import { OpenAiHandler } from "../openai"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../../index"
import type { ApiStreamChunk } from "../../transform/stream"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"

const { responsesCreate, chatCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn(), chatCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})

const usage = {
	input_tokens: 80,
	output_tokens: 25,
	input_tokens_details: { cached_tokens: 10 },
	output_tokens_details: { reasoning_tokens: 15 },
}

function textItem(text = "Done.") {
	return {
		type: "message",
		id: "message_xai",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	}
}

function response(output: unknown[] = [textItem()]) {
	return { id: "response_xai", status: "completed", output, usage }
}

function mockStream(...events: unknown[]) {
	responsesCreate.mockResolvedValueOnce({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event
		},
	})
}

function mockResponse(output: unknown[] = [textItem()], reportedUsage: unknown = usage, streaming = true) {
	const result = { ...response(output), usage: reportedUsage }
	if (streaming) mockStream({ type: "response.completed", response: result })
	else responsesCreate.mockResolvedValueOnce(result)
}

const createHandler = (options: ApiHandlerOptions = {}) => new XAIHandler({ xaiApiKey: "xai-fixture-key", ...options })
const modelIds = ["grok-4.7"] as const
const usageRoutes = modelIds.flatMap((modelId) => [true, false].map((streaming) => ({ modelId, streaming })))

/** Exercise the shared buffered Responses path without adding a native-provider setting. */
class BufferedXAIHandler extends XAIHandler {
	constructor(options: ApiHandlerOptions) {
		super(options)
		this.options.openAiStreamingEnabled = false
	}
}

const createUsageHandler = ({ modelId, streaming }: (typeof usageRoutes)[number]) =>
	streaming
		? createHandler({ apiModelId: modelId })
		: new BufferedXAIHandler({ apiModelId: modelId, xaiApiKey: "xai-fixture-key" })

async function consume(
	handler: OpenAiHandler,
	messages: Anthropic.Messages.MessageParam[] = [],
	metadata?: ApiHandlerCreateMessageMetadata,
) {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of handler.createMessage("System instructions.", messages, metadata)) chunks.push(chunk)
	return chunks
}

describe("native xAI Responses provider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		responsesCreate.mockReset()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => vi.restoreAllMocks())

	it("uses Grok 4.7's verified limits and required reasoning capabilities", () => {
		expect(createHandler().getModel()).toMatchObject({
			id: "grok-4.7",
			info: {
				contextWindow: 500_000,
				maxTokens: 128_000,
				supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
				requiredReasoningEffort: true,
				reasoningEffort: "high",
			},
		})
	})

	it("isolates the native endpoint and credential from saved compatible-provider settings", async () => {
		mockResponse()
		const handler = createHandler({
			xaiApiKey: " xai-fixture-key ",
			openAiBaseUrl: "https://unrelated.example/v1",
			openAiApiKey: "unrelated-key",
			openAiModelId: "unrelated-model",
			openAiHeaders: { Authorization: "unrelated-token" },
			openAiUseAzure: true,
			openAiR1FormatEnabled: true,
			taskReasoningCustomEffort: "unrelated-effort",
			verbosity: "high",
		})
		const chunks = await consume(handler)
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.x.ai/v1", apiKey: "xai-fixture-key" }),
		)
		expect(vi.mocked(OpenAI).mock.calls[0]?.[0]?.defaultHeaders).not.toHaveProperty("Authorization")
		expect(responsesCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "grok-4.7",
				reasoning: { effort: "high" },
				store: false,
				stream: true,
				temperature: 0.7,
				include: ["reasoning.encrypted_content"],
			}),
			expect.anything(),
		)
		const request = responsesCreate.mock.calls[0]![0]
		expect(request).not.toHaveProperty("text")
		expect(request).not.toHaveProperty("prompt_cache_retention")
		expect(request.reasoning).not.toHaveProperty("summary")
		expect(chatCreate).not.toHaveBeenCalled()
		expect(handler.getModel()).toMatchObject({
			id: "grok-4.7",
			toolIdentity: { provider: "xai", id: "grok-4.7" },
		})
		expect(handler.streamCapabilities).toMatchObject({ lifecycle: true, cancellation: true })
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "completed", terminal: true }),
		])
	})

	it.each(
		modelIds.flatMap((modelId) =>
			(["low", "medium", "high", "xhigh"] as const).map((effort) => ({ modelId, effort })),
		),
	)("sends $modelId with its supported $effort effort", async ({ modelId, effort }) => {
		mockResponse()
		const handler = createHandler({
			apiModelId: modelId,
			enableReasoningEffort: true,
			reasoningEffort: effort,
			modelTemperature: 0.4,
		})
		await consume(handler)
		expect(handler.getModel()).toMatchObject({ id: modelId, toolIdentity: { provider: "xai", id: modelId } })
		expect(responsesCreate.mock.calls[0]![0]).toMatchObject({
			model: modelId,
			reasoning: { effort },
			temperature: 0.4,
		})
	})

	it.each(
		modelIds.flatMap((modelId) =>
			(["disable", "none", "max", "ultra"] as const).map((reasoningEffort) => ({ modelId, reasoningEffort })),
		),
	)(
		"keeps $modelId mandatory reasoning valid when stale settings request $reasoningEffort",
		async ({ modelId, reasoningEffort }) => {
			mockResponse()
			await consume(createHandler({ apiModelId: modelId, enableReasoningEffort: false, reasoningEffort }))
			expect(responsesCreate.mock.calls[0]![0]).toMatchObject({ model: modelId, reasoning: { effort: "high" } })
		},
	)

	it("sends an explicit visible-output cap and portable function tools", async () => {
		mockResponse()
		await consume(createHandler({ includeMaxTokens: true, modelMaxTokens: 2048 }), [], {
			taskId: "xai-limits",
			tools: [
				{
					type: "function",
					function: {
						name: "read_file",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				},
			],
		})
		expect(responsesCreate.mock.calls[0]![0]).toMatchObject({
			max_output_tokens: 2048,
			tools: [expect.objectContaining({ type: "function", name: "read_file" })],
		})
	})

	it.each(modelIds)(
		"preserves %s encrypted reasoning through canonical history and a fresh adapter's tool continuation",
		async (modelId) => {
			const reasoning = {
				type: "reasoning",
				id: "reasoning_xai",
				encrypted_content: "opaque+/=\r\n",
				summary: [],
			}
			const tool = {
				type: "function_call",
				id: "function_xai",
				call_id: "read_xai",
				name: "read_file",
				arguments: '{"path":"a.ts"}',
				status: "completed",
			}
			mockResponse([reasoning, tool])
			const accumulator = new AgentResponseAccumulator()
			for (const chunk of await consume(createHandler({ apiModelId: modelId }))) await accumulator.add(chunk)
			expect(responsesCreate.mock.calls[0]![0]).toMatchObject({
				model: modelId,
				include: ["reasoning.encrypted_content"],
			})
			const canonical = await accumulator.finish()
			expect(canonical.items.map((item) => item.type)).toEqual(["reasoning", "tool_call", "usage"])
			const persistedContent = buildCanonicalAssistantHistoryContent(canonical)
			const reloadedContent: typeof persistedContent = JSON.parse(JSON.stringify(persistedContent))

			mockResponse()
			await consume(
				createHandler({ apiModelId: modelId }),
				[
					{ role: "assistant", content: reloadedContent },
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "read_xai", content: "File contents." }],
					},
				],
				{ taskId: "xai-reload", store: false },
			)
			expect(responsesCreate.mock.calls[1]![0]).toMatchObject({ model: modelId, store: false })
			expect(responsesCreate.mock.calls[1]![0].input).toEqual([
				{ role: "system", content: "System instructions." },
				reasoning,
				{ type: "function_call", call_id: "read_xai", name: "read_file", arguments: '{"path":"a.ts"}' },
				{ type: "function_call_output", call_id: "read_xai", output: "File contents." },
			])
		},
	)

	it("retains reasoning and cache token accounting", async () => {
		mockResponse()
		expect(await consume(createHandler())).toContainEqual({
			type: "usage",
			inputTokens: 80,
			outputTokens: 25,
			cacheReadTokens: 10,
			cacheWriteTokens: undefined,
			reasoningTokens: 15,
		})
	})

	it.each(usageRoutes.flatMap((route) => [37_756_000, 0].map((ticks) => ({ ...route, ticks }))))(
		"retains $modelId exact billed cost of $ticks ticks (streaming=$streaming)",
		async ({ modelId, streaming, ticks }) => {
			mockResponse([textItem()], { ...usage, cost_in_usd_ticks: ticks }, streaming)
			const chunks = await consume(createUsageHandler({ modelId, streaming }))
			expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
				{
					type: "usage",
					inputTokens: 80,
					outputTokens: 25,
					cacheReadTokens: 10,
					cacheWriteTokens: undefined,
					reasoningTokens: 15,
					totalCost: ticks / 10_000_000_000,
				},
			])
			expect(responsesCreate.mock.calls[0]![0]).toMatchObject({ model: modelId, stream: streaming })
		},
	)

	it.each([undefined, null, -1, NaN, Infinity, "158500", {}, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		"omits malformed billed ticks %j without changing token counts",
		async (ticks) => {
			mockResponse([textItem()], { ...usage, cost_in_usd_ticks: ticks })
			const chunks = await consume(createHandler({ apiModelId: "grok-4.7" }))
			const reported = chunks.find((chunk) => chunk.type === "usage")
			expect(reported).toMatchObject({
				inputTokens: 80,
				outputTokens: 25,
				cacheReadTokens: 10,
				reasoningTokens: 15,
			})
			expect(reported).not.toHaveProperty("totalCost")
		},
	)

	it.each(usageRoutes)("retains $modelId billed usage on failure (streaming=$streaming)", async (route) => {
		const result = {
			...response([]),
			status: "failed",
			usage: { ...usage, cost_in_usd_ticks: 37_756_000 },
			error: { code: "invalid_request_error", message: "Rejected." },
		}
		if (route.streaming) mockStream({ type: "response.failed", response: result })
		else responsesCreate.mockResolvedValueOnce(result)
		const chunks: ApiStreamChunk[] = []
		const operation = async () => {
			for await (const chunk of createUsageHandler(route).createMessage("", [])) chunks.push(chunk)
		}
		await expect(operation()).rejects.toMatchObject({ code: "invalid_request_error" })
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			expect.objectContaining({ totalCost: 0.0037756, inputTokens: 80, outputTokens: 25, reasoningTokens: 15 }),
		])
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "failed" }),
		])
	})

	it.each(modelIds)("retains %s billed usage when cancelled after its usage receipt", async (modelId) => {
		mockResponse([textItem()], { ...usage, cost_in_usd_ticks: 37_756_000 })
		const controller = new AbortController()
		const reason = new DOMException("Stopped after billing receipt.", "AbortError")
		const chunks: ApiStreamChunk[] = []
		const operation = async () => {
			for await (const chunk of createHandler({ apiModelId: modelId }).createMessage("", [], {
				taskId: "xai-usage-cancel",
				signal: controller.signal,
			})) {
				chunks.push(chunk)
				if (chunk.type === "usage") controller.abort(reason)
			}
		}
		await expect(operation()).rejects.toBe(reason)
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			expect.objectContaining({ totalCost: 0.0037756 }),
		])
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "cancelled" }),
		])
	})

	it("keeps compatible Responses usage unchanged when it contains an xAI-specific field", async () => {
		mockResponse([textItem()], { ...usage, cost_in_usd_ticks: 37_756_000 })
		const chunks = await consume(new OpenAiHandler({ openAiModelId: "gpt-6.1-sol" }))
		expect(chunks.find((chunk) => chunk.type === "usage")).not.toHaveProperty("totalCost")
	})

	it.each(modelIds)("uses %s Responses for auxiliary completions and rejects truncated answers", async (modelId) => {
		responsesCreate.mockResolvedValueOnce(response())
		await expect(createHandler({ apiModelId: modelId }).completePrompt("Summarize this.")).resolves.toBe("Done.")
		expect(responsesCreate.mock.calls[0]![0]).toMatchObject({
			model: modelId,
			stream: false,
			reasoning: { effort: "high" },
		})
		expect(chatCreate).not.toHaveBeenCalled()
		responsesCreate.mockResolvedValueOnce({
			...response(),
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
		})
		await expect(createHandler({ apiModelId: modelId }).completePrompt("Summarize this.")).rejects.toMatchObject({
			code: "response_incomplete",
		})
	})

	it("emits one failed outcome for provider errors without converting them into successful text", async () => {
		mockStream({
			type: "response.failed",
			response: {
				...response([]),
				status: "failed",
				error: { code: "invalid_request_error", message: "Rejected." },
			},
		})
		const chunks: ApiStreamChunk[] = []
		const operation = async () => {
			for await (const chunk of createHandler().createMessage("", [])) chunks.push(chunk)
		}
		await expect(operation()).rejects.toMatchObject({ code: "invalid_request_error", retryable: false })
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "failed" }),
		])
		expect(chunks.some((chunk) => chunk.type === "text")).toBe(false)
	})

	it("cancels an admitted request and never publishes a successful terminal outcome", async () => {
		const controller = new AbortController()
		const reason = new DOMException("Stopped.", "AbortError")
		let admit!: () => void
		const admitted = new Promise<void>((resolve) => (admit = resolve))
		responsesCreate.mockImplementationOnce(
			async (_request: unknown, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
					admit()
				}),
		)
		const chunks: ApiStreamChunk[] = []
		const operation = (async () => {
			for await (const chunk of createHandler().createMessage("", [], {
				taskId: "xai-cancel",
				signal: controller.signal,
			})) {
				chunks.push(chunk)
			}
		})()
		await admitted
		controller.abort(reason)
		await expect(operation).rejects.toBe(reason)
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "cancelled" }),
		])
		expect(responsesCreate).toHaveBeenCalledOnce()
	})

	it.each(["unverified-model", "", " \t ", "__proto__"])(
		"rejects unsupported model %j before SDK admission",
		(apiModelId) => {
			expect(() => createHandler({ apiModelId })).toThrow("Unsupported xAI model")
			expect(OpenAI).not.toHaveBeenCalled()
			expect(responsesCreate).not.toHaveBeenCalled()
		},
	)

	it("rejects the retired Grok 4.6 model before SDK admission", () => {
		expect(() => createHandler({ apiModelId: "grok-4.6" })).toThrow("Unsupported xAI model: grok-4.6")
		expect(OpenAI).not.toHaveBeenCalled()
		expect(responsesCreate).not.toHaveBeenCalled()
		expect(chatCreate).not.toHaveBeenCalled()
	})

	it("rejects missing native credentials before SDK admission", () => {
		expect(() => new XAIHandler({ openAiApiKey: "another-service-key" })).toThrow("An xAI API key is required")
		expect(OpenAI).not.toHaveBeenCalled()
		expect(responsesCreate).not.toHaveBeenCalled()
	})
})
