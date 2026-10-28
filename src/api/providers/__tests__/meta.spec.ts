import type { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { MetaHandler } from "../meta"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../../index"
import type { ApiStreamChunk } from "../../transform/stream"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"

const { responsesCreate, chatCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn(), chatCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		const client = {
			responses: { create: responsesCreate },
			chat: { completions: { create: chatCreate } },
			withOptions: vi.fn(() => client),
		}
		return client
	})
	return { default: constructor, AzureOpenAI: constructor }
})

const usage = {
	input_tokens: 100,
	output_tokens: 40,
	input_tokens_details: { cached_tokens: 25 },
	output_tokens_details: { reasoning_tokens: 30 },
}

function message(text = "Done.", phase?: "commentary") {
	return {
		type: "message",
		id: "msg_meta",
		role: "assistant",
		status: "completed",
		...(phase ? { phase } : {}),
		content: [{ type: "output_text", text, annotations: [] }],
	}
}

function response(output: unknown[] = [message()]) {
	return { id: "resp_meta", status: "completed", output, usage }
}

function mockStream(...events: unknown[]) {
	responsesCreate.mockResolvedValueOnce({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event
		},
	})
}

function mockResponse(output: unknown[] = [message()]) {
	mockStream({ type: "response.completed", response: response(output) })
}

const createHandler = (options: ApiHandlerOptions = {}) =>
	new MetaHandler({ metaApiKey: "meta-fixture-key", ...options })

async function consume(
	handler = createHandler(),
	messages: Anthropic.Messages.MessageParam[] = [],
	metadata?: ApiHandlerCreateMessageMetadata,
) {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of handler.createMessage("System instructions.", messages, metadata)) chunks.push(chunk)
	return chunks
}

describe("native Meta Responses provider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		responsesCreate.mockReset()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it("does not send ambient OpenAI account headers through the real SDK", async () => {
		vi.stubEnv("OPENAI_ORG_ID", "unrelated-openai-organization")
		vi.stubEnv("OPENAI_PROJECT_ID", "unrelated-openai-project")
		const { default: ActualOpenAI } = await vi.importActual<typeof import("openai")>("openai")
		vi.mocked(OpenAI).mockImplementationOnce(function (options) {
			return new ActualOpenAI(options)
		})
		let sentHeaders: Headers | undefined
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
			sentHeaders = new Headers(init?.headers)
			return new Response(JSON.stringify(response()), { headers: { "content-type": "application/json" } })
		})
		vi.stubGlobal("fetch", fetch)
		await expect(createHandler().completePrompt("Summarize.")).resolves.toBe("Done.")
		expect(fetch).toHaveBeenCalledOnce()
		expect(fetch.mock.calls[0][0]).toBe("https://api.meta.ai/v1/responses")
		expect(sentHeaders?.get("authorization")).toBe("Bearer meta-fixture-key")
		expect(sentHeaders?.has("openai-organization")).toBe(false)
		expect(sentHeaders?.has("openai-project")).toBe(false)
	})

	it("isolates native authentication, model, and protocol from saved compatible-provider settings", async () => {
		mockResponse()
		const options = {
			metaApiKey: " meta-fixture-key ",
			openAiBaseUrl: "https://unrelated.example/v1",
			openAiApiKey: "unrelated-key",
			openAiModelId: "unrelated-model",
			openAiHeaders: { Authorization: "unrelated-token" },
			openAiUseAzure: true,
			openAiR1FormatEnabled: true,
			openAiStreamingEnabled: false,
			taskReasoningCustomEffort: "unverified-effort",
			verbosity: "high" as const,
		}
		const before = structuredClone(options)
		const handler = createHandler(options)
		const chunks = await consume(handler)

		expect(options).toEqual(before)
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.meta.ai/v1", apiKey: "meta-fixture-key", maxRetries: 0 }),
		)
		expect(vi.mocked(OpenAI).mock.calls[0]?.[0]?.defaultHeaders).not.toHaveProperty("Authorization")
		expect(responsesCreate.mock.calls[0]![0]).toMatchObject({
			model: "muse-wonder-1.0",
			reasoning: { effort: "high", summary: "auto" },
			store: false,
			stream: true,
			include: ["reasoning.encrypted_content"],
		})
		expect(responsesCreate.mock.calls[0]![0]).not.toHaveProperty("text")
		expect(chatCreate).not.toHaveBeenCalled()
		expect(handler.getModel()).toMatchObject({
			id: "muse-wonder-1.0",
			toolIdentity: { provider: "meta", id: "muse-wonder-1.0" },
		})
		expect(handler.streamCapabilities).toEqual({ lifecycle: true, cancellation: true })
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "completed", terminal: true }),
		])
	})

	it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
		"sends supported %s reasoning on task and auxiliary requests",
		async (reasoningEffort) => {
			mockResponse()
			responsesCreate.mockResolvedValueOnce(response())
			const handler = createHandler({ enableReasoningEffort: true, reasoningEffort })
			await consume(handler)
			await expect(handler.completePrompt("Summarize.")).resolves.toBe("Done.")
			for (const [request] of responsesCreate.mock.calls) {
				expect(request).toMatchObject({ model: "muse-wonder-1.0", reasoning: { effort: reasoningEffort } })
			}
			expect(chatCreate).not.toHaveBeenCalled()
		},
	)

	it.each(["disable", "none", "ultra"] as const)(
		"keeps mandatory reasoning valid when a stale profile requests %s",
		async (reasoningEffort) => {
			mockResponse()
			await consume(createHandler({ enableReasoningEffort: false, reasoningEffort }))
			expect(responsesCreate.mock.calls[0]![0]).toMatchObject({ reasoning: { effort: "high" } })
		},
	)

	it("sends ordered instruction fragments and portable function tools without changing authority", async () => {
		mockResponse()
		await consume(createHandler({ includeMaxTokens: true, modelMaxTokens: 2048 }), [], {
			taskId: "meta-instructions",
			instructionFragments: [
				{ role: "system", content: "System policy." },
				{ role: "developer", content: "Developer instructions." },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "read_file",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				},
			],
			tool_choice: { type: "function", function: { name: "read_file" } },
			parallelToolCalls: false,
		})
		expect(responsesCreate.mock.calls[0]![0]).toMatchObject({
			input: [
				{ role: "system", content: "System policy." },
				{ role: "developer", content: "Developer instructions." },
			],
			max_output_tokens: 2048,
			tools: [expect.objectContaining({ type: "function", name: "read_file" })],
			tool_choice: { type: "function", name: "read_file" },
			parallel_tool_calls: false,
		})
	})

	it.each([false, true])(
		"keeps the server-selected output limit when no cap is configured (enabled=%s)",
		async (flag) => {
			mockResponse()
			await consume(createHandler({ includeMaxTokens: flag }))
			expect(responsesCreate.mock.calls[0]![0]).not.toHaveProperty("max_output_tokens")
		},
	)

	it("rejects output limits below the native Responses minimum before request admission", async () => {
		const handler = createHandler({ includeMaxTokens: true, modelMaxTokens: 15 })
		await expect(consume(handler)).rejects.toThrow("16")
		await expect(handler.completePrompt("Summarize.")).rejects.toThrow("16")
		expect(responsesCreate).not.toHaveBeenCalled()
	})

	it("preserves private reasoning and commentary across persisted history and a fresh tool continuation", async () => {
		const reasoning = { type: "reasoning", id: "rs_meta", encrypted_content: "opaque+/=\r\n", summary: [] }
		const commentary = message("I will inspect the file.", "commentary")
		const tool = {
			type: "function_call",
			id: "fc_meta",
			call_id: "call_meta",
			name: "read_file",
			arguments: '{"path":"a.ts"}',
			status: "completed",
		}
		mockResponse([reasoning, commentary, tool])
		const accumulator = new AgentResponseAccumulator()
		for (const chunk of await consume()) await accumulator.add(chunk)
		const canonical = await accumulator.finish()
		expect(canonical.items.map((item) => item.type)).toEqual(["reasoning", "text", "tool_call", "usage"])
		const persisted = buildCanonicalAssistantHistoryContent(canonical)
		const reloaded: typeof persisted = JSON.parse(JSON.stringify(persisted))

		mockResponse()
		await consume(createHandler(), [
			{ role: "assistant", content: reloaded },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_meta", content: "File contents." }] },
		])
		expect(responsesCreate.mock.calls[1]![0].input).toEqual([
			{ role: "system", content: "System instructions." },
			reasoning,
			{
				type: "message",
				id: "msg_meta",
				role: "assistant",
				phase: "commentary",
				content: [{ type: "output_text", text: "I will inspect the file.", annotations: [] }],
			},
			{ type: "function_call", call_id: "call_meta", name: "read_file", arguments: '{"path":"a.ts"}' },
			{ type: "function_call_output", call_id: "call_meta", output: "File contents." },
		])
	})

	it("streams text and tools in order and accounts for hidden reasoning without requiring visible thinking", async () => {
		const answer = message("Inspecting.", "commentary")
		const tool = {
			type: "function_call",
			id: "fc_meta",
			call_id: "call_meta",
			name: "read_file",
			arguments: '{"path":"a.ts"}',
			status: "completed",
		}
		mockStream(
			{ type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Inspecting." },
			{ type: "response.output_item.done", output_index: 0, item: answer },
			{ type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "" } },
			{ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
			{ type: "response.function_call_arguments.delta", output_index: 1, delta: '"a.ts"}' },
			{ type: "response.output_item.done", output_index: 1, item: tool },
			{ type: "response.completed", response: response([answer, tool]) },
		)
		const chunks = await consume()
		expect(chunks.filter((chunk) => chunk.type === "text" || chunk.type === "tool_call_partial")).toMatchObject([
			{ type: "text", text: "Inspecting." },
			{ type: "tool_call_partial", index: 1, id: "call_meta", name: "read_file" },
			{ type: "tool_call_partial", index: 1, arguments: '{"path":' },
			{ type: "tool_call_partial", index: 1, arguments: '"a.ts"}' },
		])
		expect(chunks.some((chunk) => chunk.type === "reasoning")).toBe(false)
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			{
				type: "usage",
				inputTokens: 100,
				outputTokens: 40,
				cacheReadTokens: 25,
				cacheWriteTokens: undefined,
				reasoningTokens: 30,
			},
		])
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "completed", terminal: true }),
		])
	})

	it("requests readable summaries independently from opaque reasoning replay", async () => {
		mockResponse([
			{
				type: "reasoning",
				id: "rs_meta",
				encrypted_content: "opaque-state",
				summary: [{ type: "summary_text", text: "I checked the alternatives." }],
			},
			message(),
		])
		expect(await consume()).toContainEqual(
			expect.objectContaining({ type: "reasoning", text: "I checked the alternatives." }),
		)
		mockResponse()
		await consume(createHandler({ enableResponsesReasoningSummary: false }))
		expect(responsesCreate.mock.calls[1]![0]).toMatchObject({ include: ["reasoning.encrypted_content"] })
		expect(responsesCreate.mock.calls[1]![0].reasoning).not.toHaveProperty("summary")
	})

	it("preserves provider failures and usage with one failed outcome", async () => {
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
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			expect.objectContaining({ inputTokens: 100, outputTokens: 40, reasoningTokens: 30 }),
		])
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "failed" }),
		])
		expect(chunks.some((chunk) => chunk.type === "text")).toBe(false)
	})

	it("rejects truncated auxiliary answers", async () => {
		responsesCreate.mockResolvedValueOnce({
			...response(),
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
		})
		await expect(createHandler().completePrompt("Summarize.")).rejects.toMatchObject({
			code: "response_incomplete",
		})
	})

	it("rejects an already-cancelled auxiliary completion before request admission", async () => {
		const controller = new AbortController()
		const reason = new DOMException("Stopped.", "AbortError")
		controller.abort(reason)
		await expect(createHandler().completePrompt("Summarize.", { signal: controller.signal })).rejects.toBe(reason)
		expect(responsesCreate).not.toHaveBeenCalled()
	})

	it("propagates cancellation into an admitted request and finalizes it once", async () => {
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
				taskId: "meta-cancellation",
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

	it.each(["muse-wonder-full", "muse-spark-1.3", "", " \t ", "__proto__"])(
		"rejects unsupported model %j before SDK admission",
		(apiModelId) => {
			expect(() => createHandler({ apiModelId })).toThrow("Unsupported Meta model")
			expect(OpenAI).not.toHaveBeenCalled()
		},
	)

	it("rejects missing native credentials without borrowing another provider's key", () => {
		expect(() => new MetaHandler({ openAiApiKey: "another-service-key" })).toThrow("A Meta API key is required")
		expect(OpenAI).not.toHaveBeenCalled()
	})
})
