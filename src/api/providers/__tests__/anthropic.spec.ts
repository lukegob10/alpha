import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiHandlerCreateMessageMetadata } from "../../index"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiStreamChunk } from "../../transform/stream"
import { AnthropicHandler } from "../anthropic"

const mocks = vi.hoisted(() => ({ create: vi.fn(), construct: vi.fn() }))

vi.mock("@anthropic-ai/sdk", () => ({
	Anthropic: vi.fn(function (options) {
		mocks.construct(options)
		return { messages: { create: mocks.create } }
	}),
}))

const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Find the cause." }]
const tools: ApiHandlerCreateMessageMetadata["tools"] = [
	{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
]

function stream(events: unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			yield* events
		},
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const completeEvents = [
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Done" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
	{ type: "message_stop" },
]

async function collect(handler: AnthropicHandler, metadata?: ApiHandlerCreateMessageMetadata) {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of handler.createMessage("system", messages, metadata)) chunks.push(chunk)
	return chunks
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.create.mockResolvedValue(stream(completeEvents))
})

afterEach(() => {
	vi.useRealTimers()
})

describe("native Anthropic adapter", () => {
	it("uses only the native key and endpoint and reuses shared required effort resolution", async () => {
		const options: ApiHandlerOptions = {
			apiKey: "native-test-key",
			openAiApiKey: "unrelated-key",
			openAiBaseUrl: "https://unrelated.example",
			gatewayBaseUrl: "https://unrelated.example",
			modelTemperature: 0.4,
			reasoningEffort: "max",
		}
		const handler = new AnthropicHandler(options)
		expect(mocks.construct).not.toHaveBeenCalled()
		await collect(handler, { taskId: "task", tools, tool_choice: "auto", parallelToolCalls: false })
		expect(mocks.construct).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "native-test-key",
				authToken: null,
				baseURL: "https://api.anthropic.com",
				maxRetries: 0,
			}),
		)
		const [body, requestOptions] = mocks.create.mock.calls[0]
		expect(body).toMatchObject({
			model: "claude-opus-5-5",
			thinking: {
				type: "adaptive",
				display: "summarized",
				block_binding: { prefix_mismatch_behavior: "drop_block" },
			},
			output_config: { effort: "max" },
			tool_choice: { type: "auto", disable_parallel_tool_use: true },
		})
		expect(body).not.toHaveProperty("temperature")
		expect(requestOptions.headers).toEqual({ "anthropic-beta": "thinking-binding-controls-2026-08-01" })
		expect(options.reasoningEffort).toBe("max")
	})

	it.each(["disable", "none", "minimal", "ultra"] as const)(
		"resolves unsupported %s to the model default",
		async (reasoningEffort) => {
			await collect(new AnthropicHandler({ apiKey: "key", reasoningEffort, enableReasoningEffort: false }))
			expect(mocks.create.mock.calls[0][0].output_config).toEqual({ effort: "medium" })
		},
	)

	it.each([
		{ apiModelId: "claude-opus-5-5", effort: "medium" },
		{ apiModelId: "claude-sonnet-5-5", effort: "high" },
		{ apiModelId: "claude-fable-5-1", effort: "high" },
	] as const)(
		"uses the verified $apiModelId default and adaptive replay controls",
		async ({ apiModelId, effort }) => {
			await collect(new AnthropicHandler({ apiKey: "key", apiModelId }))
			const [body, requestOptions] = mocks.create.mock.calls[0]
			expect(body).toMatchObject({
				model: apiModelId,
				thinking: {
					type: "adaptive",
					display: "summarized",
					block_binding: { prefix_mismatch_behavior: "drop_block" },
				},
				output_config: { effort },
			})
			expect(body).not.toHaveProperty("temperature")
			expect(requestOptions.headers).toEqual({ "anthropic-beta": "thinking-binding-controls-2026-08-01" })
		},
	)

	it.each([
		{ enableReasoningEffort: false, reasoningEffort: "low" },
		{ enableReasoningEffort: false, reasoningEffort: "high" },
		{ enableReasoningEffort: false, reasoningEffort: "xhigh" },
		{ enableReasoningEffort: false, reasoningEffort: "max" },
		{ enableReasoningEffort: true, reasoningEffort: "disable" },
	] as const)("keeps Fable reasoning active when a saved profile requests Off (%j)", async (settings) => {
		await collect(new AnthropicHandler({ apiKey: "key", apiModelId: "claude-fable-5-1", ...settings }))
		const [body, requestOptions] = mocks.create.mock.calls[0]
		expect(body.thinking).toMatchObject({ type: "adaptive" })
		expect(body.output_config).toEqual({
			effort: settings.reasoningEffort === "disable" ? "high" : settings.reasoningEffort,
		})
		expect(body).not.toHaveProperty("temperature")
		expect(requestOptions.headers).toEqual({ "anthropic-beta": "thinking-binding-controls-2026-08-01" })
	})

	it.each(["xhigh", "max"] as const)("keeps Fable %s in adaptive mode", async (reasoningEffort) => {
		await collect(new AnthropicHandler({ apiKey: "key", apiModelId: "claude-fable-5-1", reasoningEffort }))
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: reasoningEffort },
		})
	})

	it("keeps Sonnet adaptive when a saved profile requests unsupported full Off", async () => {
		await collect(
			new AnthropicHandler({ apiKey: "key", apiModelId: "claude-sonnet-5-5", enableReasoningEffort: false }),
		)
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		})
	})

	it.each(["required", { type: "function", function: { name: "read_file" } }] as const)(
		"rejects Fable forced tool choice %j before dispatch",
		async (tool_choice) => {
			await expect(
				collect(new AnthropicHandler({ apiKey: "key", apiModelId: "claude-fable-5-1" }), {
					taskId: "task",
					tools,
					tool_choice,
				}),
			).rejects.toThrow("forced tool use")
			expect(mocks.create).not.toHaveBeenCalled()
		},
	)

	it("rejects Sonnet forced tool use before dispatch", async () => {
		await expect(
			collect(new AnthropicHandler({ apiKey: "key", apiModelId: "claude-sonnet-5-5" }), {
				taskId: "task",
				tools,
				tool_choice: "required",
			}),
		).rejects.toThrow("forced tool use")
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it("rejects unknown and prototype model IDs before SDK dispatch", async () => {
		for (const apiModelId of ["unsupported-model", "toString", "__proto__", "", " ", "claude-haiku-5-5"]) {
			await expect(collect(new AnthropicHandler({ apiKey: "key", apiModelId }))).rejects.toThrow(
				"Unsupported Anthropic model",
			)
		}
		expect(mocks.construct).not.toHaveBeenCalled()
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it("requires its own API key and rejects unsupported legacy routing", async () => {
		await expect(collect(new AnthropicHandler({ openAiApiKey: "other-provider" }))).rejects.toThrow(
			"Anthropic API key is required",
		)
		expect(() => new AnthropicHandler({ apiKey: "key", anthropicBaseUrl: "https://proxy.example" })).toThrow(
			"legacy",
		)
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it("maps none explicitly and rejects forced tool use before dispatch", async () => {
		const handler = new AnthropicHandler({ apiKey: "key" })
		await collect(handler, { taskId: "task", tools, tool_choice: "none" })
		expect(mocks.create.mock.calls[0][0].tool_choice).toEqual({ type: "none" })
		mocks.create.mockClear()
		await expect(collect(handler, { taskId: "task", tools, tool_choice: "required" })).rejects.toThrow(
			"forced tool use",
		)
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"])(
		"preserves %s signed thinking and redacted blocks through a tool continuation",
		async (apiModelId) => {
			const thinking = { type: "thinking" as const, thinking: "A summary", signature: "opaque-signature" }
			const redacted = { type: "redacted_thinking" as const, data: "opaque-redacted" }
			const history: Anthropic.Messages.MessageParam[] = [
				...messages,
				{
					role: "assistant",
					content: [thinking, redacted, { type: "tool_use", id: "call", name: "read_file", input: {} }],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "file result" }] },
			]
			const handler = new AnthropicHandler({ apiKey: "key", apiModelId })
			for await (const _chunk of handler.createMessage("system", history, { taskId: "task", tools })) {
				/* consume */
			}
			expect(mocks.create.mock.calls[0][0].messages[1]).toEqual(history[1])
			expect(history[1].content).toEqual([
				thinking,
				redacted,
				{ type: "tool_use", id: "call", name: "read_file", input: {} },
			])
		},
	)

	it("keeps reasoning, text, and tool block order and seals each signature", async () => {
		mocks.create.mockResolvedValue(
			stream([
				{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "Summary", signature: "" },
				},
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use", id: "call", name: "read_file", input: {} },
				},
				{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
				{ type: "content_block_stop", index: 1 },
				{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
				{ type: "message_stop" },
			]),
		)
		const handler = new AnthropicHandler({ apiKey: "key" })
		const chunks = await collect(handler, { taskId: "task", tools })
		expect(chunks.map((chunk) => chunk.type)).toEqual([
			"usage",
			"reasoning",
			"thinking_complete",
			"tool_call_partial",
			"tool_call_partial",
			"tool_call_end",
			"usage",
			"outcome",
		])
		expect(chunks[2]).toMatchObject({ type: "thinking_complete", outputIndex: 0, signature: "signature" })
		expect(chunks.at(-1)).toMatchObject({ type: "outcome", status: "completed" })
		expect(handler.getThoughtSignature()).toBe("signature")
	})

	it.each(["max_tokens", undefined])("keeps truncation/EOF (%s) incomplete", async (stopReason) => {
		mocks.create.mockResolvedValue(
			stream([
				...completeEvents.slice(0, 2),
				...(stopReason
					? [
							{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
							{ type: "message_stop" },
						]
					: []),
			]),
		)
		expect((await collect(new AnthropicHandler({ apiKey: "key" }))).at(-1)).toMatchObject({
			type: "outcome",
			status: "incomplete",
		})
	})

	it("rejects cancellation while an SDK iterator is stalled and aborts the transport", async () => {
		const entered = deferred<void>()
		const pending = deferred<IteratorResult<unknown>>()
		mocks.create.mockResolvedValue({
			[Symbol.asyncIterator]() {
				return {
					next: () => {
						entered.resolve()
						return pending.promise
					},
				}
			},
		})
		const controller = new AbortController()
		const collection = collect(new AnthropicHandler({ apiKey: "key" }), {
			taskId: "task",
			signal: controller.signal,
		})
		await entered.promise
		const reason = new Error("cancel fixture")
		controller.abort(reason)
		await expect(collection).rejects.toBe(reason)
		expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(true)
		pending.resolve({ done: true, value: undefined })
	})

	it("propagates deadlines without reporting success", async () => {
		vi.useFakeTimers()
		const entered = deferred<void>()
		const pending = deferred<IteratorResult<unknown>>()
		mocks.create.mockResolvedValue({
			[Symbol.asyncIterator]: () => ({
				next: () => {
					entered.resolve()
					return pending.promise
				},
			}),
		})
		const collection = collect(new AnthropicHandler({ apiKey: "key" }), {
			taskId: "task",
			deadline: Date.now() + 20,
		})
		const rejected = expect(collection).rejects.toMatchObject({ code: "ProviderTimeout" })
		await entered.promise
		await vi.advanceTimersByTimeAsync(20)
		await rejected
		pending.resolve({ done: true, value: undefined })
	})

	it("collects text after thinking for auxiliary completions with the same reasoning payload", async () => {
		mocks.create.mockResolvedValue({
			stop_reason: "end_turn",
			content: [
				{ type: "thinking", thinking: "", signature: "signature" },
				{ type: "text", text: "First" },
				{ type: "text", text: " second" },
			],
		})
		const handler = new AnthropicHandler({ apiKey: "key", reasoningEffort: "low" })
		await expect(handler.completePrompt("prompt")).resolves.toBe("First second")
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			stream: false,
			thinking: { type: "adaptive" },
			output_config: { effort: "low" },
		})
	})

	it("does not accept truncated auxiliary completions or late success after cancellation", async () => {
		const handler = new AnthropicHandler({ apiKey: "key" })
		mocks.create.mockResolvedValue({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] })
		await expect(handler.completePrompt("prompt")).rejects.toThrow("did not finish")
		const controller = new AbortController()
		const reason = new Error("late cancel")
		mocks.create.mockImplementation(() => {
			controller.abort(reason)
			return Promise.resolve({ stop_reason: "end_turn", content: [{ type: "text", text: "late" }] })
		})
		await expect(handler.completePrompt("prompt", { signal: controller.signal })).rejects.toBe(reason)
	})
})
