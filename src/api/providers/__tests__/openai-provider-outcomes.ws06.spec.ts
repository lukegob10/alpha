import { OpenAiHandler } from "../openai"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiStreamChunk } from "../../transform/stream"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import { AgentRetryPolicy } from "../../../core/agent/AgentRetryPolicy"

const { chatCreate, responsesCreate } = vi.hoisted(() => ({ chatCreate: vi.fn(), responsesCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return {
			chat: { completions: { create: chatCreate } },
			responses: { create: responsesCreate },
		}
	})
	return { default: constructor, AzureOpenAI: constructor }
})

const responseOptions: ApiHandlerOptions = {
	openAiApiKey: "fixture-key",
	openAiModelId: "gpt-6.1-sol",
	openAiBaseUrl: "https://api.openai.com/v1",
}

const responseUsage = {
	input_tokens: 120,
	output_tokens: 30,
	total_tokens: 150,
	input_tokens_details: { cached_tokens: 40 },
	output_tokens_details: { reasoning_tokens: 12 },
}

const chatUsage = {
	prompt_tokens: 120,
	completion_tokens: 30,
	total_tokens: 150,
	prompt_tokens_details: { cached_tokens: 40 },
	completion_tokens_details: { reasoning_tokens: 12 },
}

function events(...values: unknown[]): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const value of values) yield value
		},
	}
}

function mockResponse(streaming: boolean, response: Record<string, unknown>, preceding: unknown[] = []) {
	responsesCreate.mockResolvedValueOnce(
		streaming ? events(...preceding, { type: `response.${response.status}`, response }) : response,
	)
}

async function consume(provider: OpenAiHandler, signal?: AbortSignal) {
	const chunks: ApiStreamChunk[] = []
	const accumulator = new AgentResponseAccumulator()
	let failure: unknown
	try {
		for await (const chunk of provider.createMessage("system", [], { taskId: "ws06-provider", signal })) {
			chunks.push(chunk)
			await accumulator.add(chunk)
		}
	} catch (error) {
		failure = error
	}
	const providerOutcome = chunks.some((chunk) => chunk.type === "outcome")
	const canonical = await accumulator.finish(
		undefined,
		failure && !providerOutcome ? { status: "failed", retryable: false } : undefined,
	)
	return { chunks, failure, canonical }
}

describe("WS06 provider terminal errors and usage", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		chatCreate.mockReset()
		responsesCreate.mockReset()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => vi.restoreAllMocks())

	describe.each([false, true])("Responses streaming=%s", (streaming) => {
		function provider() {
			return new OpenAiHandler({ ...responseOptions, openAiStreamingEnabled: streaming })
		}

		it.each(["rate_limit_exceeded", "slow_down"])(
			"classifies opaque %s by code and retains safe server advice",
			async (code) => {
				mockResponse(streaming, {
					id: "response-failed",
					status: "failed",
					error: {
						code,
						message: "Opaque provider failure.",
						headers: { "Retry-After": "60", authorization: "secret-header-fixture" },
					},
				})
				const { chunks, failure } = await consume(provider())
				expect(failure).toMatchObject({
					code,
					retryable: true,
					retryCategory: "rate-limit",
					retryAfterMs: 60_000,
				})
				expect(chunks.some((chunk) => chunk.type === "outcome")).toBe(false)
				expect(failure).not.toHaveProperty("headers")
				expect(failure).not.toHaveProperty("error")
				expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret-header-fixture")
				expect(responsesCreate).toHaveBeenCalledOnce()
			},
		)

		it("retains rate-limit advice for the existing bounded retry decision", async () => {
			mockResponse(streaming, {
				id: "response-retry-policy",
				status: "failed",
				error: { code: "rate_limit_exceeded", message: "Opaque failure.", headers: { "Retry-After": "60" } },
			})
			const { failure } = await consume(provider())
			if (
				!(failure instanceof Error) ||
				!("retryCategory" in failure) ||
				failure.retryCategory !== "rate-limit" ||
				!("retryAfterMs" in failure) ||
				typeof failure.retryAfterMs !== "number"
			) {
				throw new Error("Provider discarded its retry classification or scheduling advice")
			}
			expect(
				new AgentRetryPolicy({ jitter: "none", now: () => 1_000 }).decide({
					category: failure.retryCategory,
					attempt: 1,
					retryAfterMs: failure.retryAfterMs,
				}),
			).toMatchObject({ shouldRetry: true, category: "rate-limit", delayMs: 60_000, retryAt: 61_000 })
		})

		it.each([
			{ headers: { "Retry-After": "2" }, expected: 2_000 },
			{ headers: { "Retry-After": "0" }, expected: 0 },
			{ headers: { "Retry-After": "invalid" }, expected: 35_000 },
			{ headers: { "retry-after": "\n5\n" }, expected: 35_000 },
			{ headers: { "retry-after": "\t5\t" }, expected: 5_000 },
			{ headers: { "Retry-After": "5", "retry-after": "30" }, expected: 30_000 },
			{ headers: { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }, expected: 0 },
		])("gives valid header advice priority over rate-limit text (%j)", async ({ headers, expected }) => {
			mockResponse(streaming, {
				id: "response-header-advice",
				status: "failed",
				error: { code: "rate_limit_exceeded", message: "Try again in 35 seconds.", headers },
			})
			expect((await consume(provider())).failure).toMatchObject({ retryAfterMs: expected })
		})

		it.each([
			{ code: "rate_limit_exceeded", message: "Try again in 1.898s.", expected: 1_898 },
			{ code: "slow_down", message: "Try again in 28ms.", expected: 28 },
		])("uses rate-limit message advice when headers are absent (%j)", async ({ code, message, expected }) => {
			mockResponse(streaming, { id: "response-text-advice", status: "failed", error: { code, message } })
			expect((await consume(provider())).failure).toMatchObject({ code, retryAfterMs: expected })
		})

		it("does not interpret a generic failure message as retry scheduling advice", async () => {
			mockResponse(streaming, {
				id: "response-generic",
				status: "failed",
				error: { code: "unknown_failure", message: "Try again in 35 seconds." },
			})
			const { failure } = await consume(provider())
			expect(failure).toMatchObject({ code: "unknown_failure", retryable: true, retryCategory: "transport" })
			expect(failure).not.toHaveProperty("retryAfterMs")
		})

		it.each([
			{ headers: { "Retry-After": "7" }, retryable: true, retryAfterMs: 7_000 },
			{ headers: { "Retry-After": "invalid" }, retryable: false, retryAfterMs: undefined },
			{ headers: {}, retryable: false, retryAfterMs: undefined },
		])("only retries overload when structured server advice permits it (%j)", async (advice) => {
			mockResponse(streaming, {
				id: "response-overloaded",
				status: "failed",
				error: { code: "server_is_overloaded", message: "Try again in 35 seconds.", headers: advice.headers },
			})
			const { failure } = await consume(provider())
			expect(failure).toMatchObject({ code: "server_is_overloaded", retryable: advice.retryable })
			if (advice.retryAfterMs === undefined) expect(failure).not.toHaveProperty("retryAfterMs")
			else expect(failure).toMatchObject({ retryAfterMs: advice.retryAfterMs })
		})

		if (streaming) {
			it.each(["rate_limit_exceeded", "flex_unavailable"])(
				"preserves native classification from a nested top-level error event (%s)",
				async (code) => {
					responsesCreate.mockResolvedValueOnce(
						events({
							type: "error",
							error: { code, message: "Opaque failure.", plan_type: 42, headers: { "Retry-After": "2" } },
						}),
					)
					const { chunks, failure } = await consume(provider())
					expect(failure).toMatchObject({ code, retryable: code === "rate_limit_exceeded" })
					expect(chunks.some((chunk) => chunk.type === "outcome")).toBe(false)
				},
			)
		}

		it("uses future HTTP-date advice against a controlled clock", async () => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(new Date("2026-10-15T04:00:00.000Z"))
				mockResponse(streaming, {
					id: "response-http-date",
					status: "failed",
					error: {
						code: "rate_limit_exceeded",
						message: "Try again in 35 seconds.",
						headers: { "Retry-After": "Thu, 15 Oct 2026 04:00:06 GMT" },
					},
				})
				expect((await consume(provider())).failure).toMatchObject({ retryAfterMs: 6_000 })
			} finally {
				vi.useRealTimers()
			}
		})

		it("emits known usage once before a failed response error", async () => {
			mockResponse(streaming, {
				id: "response-failed-usage",
				status: "failed",
				error: { code: "unknown_failure", message: "Opaque provider failure." },
				output: [],
				usage: responseUsage,
			})
			const { chunks, failure } = await consume(provider())
			expect(failure).toMatchObject({ code: "unknown_failure" })
			expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
				{ type: "usage", inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, reasoningTokens: 12 },
			])
		})

		it.each([
			"insufficient_quota",
			"credit_balance_exhausted",
			"organization_spend_limit_exceeded",
			"project_spend_limit_exceeded",
			"usage_not_included",
			"flex_unavailable",
			"invalid_prompt",
			"invalid_request_error",
			"cyber_policy",
			"bio_policy",
			"misalignment_policy_violation",
		])("keeps permanent %s nonretryable despite advice and an opaque message", async (code) => {
			mockResponse(streaming, {
				id: "response-permanent",
				status: "failed",
				error: { code, message: "Opaque provider failure.", headers: { "Retry-After": "1" } },
			})
			const { failure } = await consume(provider())
			expect(failure).toMatchObject({ code, retryable: false })
		})

		it("preserves opaque context-window classification for the existing bounded recovery policy", async () => {
			mockResponse(streaming, {
				id: "response-context",
				status: "failed",
				error: { code: "context_length_exceeded", message: "Opaque provider failure." },
			})
			const { chunks, failure } = await consume(provider())
			expect(failure).toMatchObject({ code: "context_length_exceeded", retryCategory: "context" })
			expect(failure).not.toHaveProperty("retryable", false)
			expect(chunks.some((chunk) => chunk.type === "outcome")).toBe(false)
		})

		it.each(["max_output_tokens", "content_filter", "unknown"])(
			"preserves usage once before a terminal incomplete %s failure",
			async (reason) => {
				mockResponse(streaming, {
					id: "response-incomplete",
					status: "incomplete",
					incomplete_details: { reason },
					output: [],
					usage: responseUsage,
				})
				const handler = provider()
				const { chunks, failure, canonical } = await consume(handler)
				expect(failure).toMatchObject({ retryable: false })
				expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
					{ type: "usage", inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, reasoningTokens: 12 },
				])
				expect(handler.getResponseId()).toBe("response-incomplete")
				expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
					expect.objectContaining({ status: "incomplete", terminal: true, retryable: false }),
				])
				expect(canonical.outcome).toMatchObject({ status: "incomplete", retryable: false })
			},
		)

		it.each([
			null,
			undefined,
			{ malformed: true },
			{ input_tokens: -1, output_tokens: 30 },
			{ input_tokens: 120, output_tokens: Number.NaN },
			{ input_tokens: Number.POSITIVE_INFINITY, output_tokens: 30 },
			{ input_tokens: "120", output_tokens: 30 },
		])("does not manufacture usage for an incomplete response with invalid usage (%j)", async (usage) => {
			mockResponse(streaming, {
				id: "response-invalid-usage",
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [],
				usage,
			})
			const { chunks, failure } = await consume(provider())
			expect(failure).toMatchObject({ retryable: false })
			expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([])
			expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
				expect.objectContaining({ status: "incomplete", terminal: true, retryable: false }),
			])
		})

		it("normalizes interrupted completion into a same-turn continuation with usage", async () => {
			mockResponse(streaming, {
				id: "response-interrupted",
				status: "incomplete",
				incomplete_details: { reason: "interrupted" },
				output: [],
				usage: responseUsage,
			})
			const handler = provider()
			const { chunks, failure, canonical } = await consume(handler)
			expect(failure).toBeUndefined()
			expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
			expect(canonical.outcome).toMatchObject({ status: "completed", requiresContinuation: true })
			expect(handler.getResponseId()).toBe("response-interrupted")
			expect(responsesCreate).toHaveBeenCalledOnce()
		})

		it.each(
			["function_call", "custom_tool_call"].flatMap((type) =>
				["incomplete", "in_progress", undefined].map((status) => ({ type, status })),
			),
		)(
			"continues after interrupted output while suppressing unfinished $type status=$status",
			async ({ type, status }) => {
				const call = {
					id: "item-unfinished",
					type,
					call_id: "call-unfinished",
					name: "read_file",
					...(status !== undefined ? { status } : {}),
					...(type === "function_call"
						? { arguments: '{"path":"example.txt"}' }
						: { input: '{"path":"example.txt"}' }),
				}
				const preceding = [
					{ type: "response.output_item.added", output_index: 0, item: call },
					{
						type:
							type === "function_call"
								? "response.function_call_arguments.delta"
								: "response.custom_tool_call_input.delta",
						output_index: 0,
						delta: '{"path":"example.txt"}',
					},
				]
				mockResponse(
					streaming,
					{
						id: "response-interrupted-tool",
						status: "incomplete",
						incomplete_details: { reason: "interrupted" },
						output: [call],
						usage: responseUsage,
					},
					preceding,
				)
				const { chunks, canonical } = await consume(provider())
				expect(chunks).not.toContainEqual({ type: "tool_call_end", id: "call-unfinished" })
				expect(canonical.toolCalls).toEqual([])
				expect(canonical.outcome).toMatchObject({ status: "completed", requiresContinuation: true })
				expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
			},
		)

		it("retains completed tool receipts once while requesting an interrupted continuation", async () => {
			const call = {
				id: "item-completed",
				type: "function_call",
				call_id: "call-completed",
				name: "read_file",
				status: "completed",
				arguments: '{"path":"example.txt"}',
			}
			mockResponse(
				streaming,
				{
					id: "response-completed-tool-interrupt",
					status: "incomplete",
					incomplete_details: { reason: "interrupted" },
					output: [call],
					usage: responseUsage,
				},
				[{ type: "response.output_item.done", output_index: 0, item: call }],
			)
			const { chunks, failure, canonical } = await consume(provider())
			expect(failure).toBeUndefined()
			expect(chunks.filter((chunk) => chunk.type === "tool_call_end")).toHaveLength(1)
			expect(canonical.toolCalls).toEqual([
				{ type: "tool_call", id: "call-completed", name: "read_file", arguments: { path: "example.txt" } },
			])
			expect(canonical.outcome).toMatchObject({ status: "completed", requiresContinuation: true })
		})

		it("retains terminal usage after an incomplete output-item receipt", async () => {
			const call = {
				id: "item-incomplete",
				type: "function_call",
				call_id: "call-incomplete",
				name: "read_file",
				arguments: '{"path":"example.txt"}',
				status: "incomplete",
			}
			mockResponse(
				streaming,
				{
					id: "response-item-incomplete",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					output: [call],
					usage: responseUsage,
				},
				[{ type: "response.output_item.done", output_index: 0, item: call }],
			)
			const { chunks, failure, canonical } = await consume(provider())
			expect(failure).toMatchObject({ retryable: false })
			expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
			expect(canonical.toolCalls).toEqual([])
			expect(canonical.outcome?.status).not.toBe("completed")
		})

		it("preserves cancellation identity without creating a retry or usage record", async () => {
			const abort = Object.assign(new Error("Operation stopped"), { name: "AbortError", code: "ABORT_ERR" })
			responsesCreate.mockRejectedValueOnce(abort)
			const { chunks, failure } = await consume(provider(), new AbortController().signal)
			expect(failure).toBe(abort)
			expect(chunks).toEqual([])
			expect(responsesCreate).toHaveBeenCalledOnce()
		})
	})

	describe.each([
		{ model: "gpt-4", streaming: false },
		{ model: "gpt-4", streaming: true },
		{ model: "o3", streaming: false },
		{ model: "o3", streaming: true },
	])("Chat Completions $model streaming=$streaming", ({ model, streaming }) => {
		function provider() {
			return new OpenAiHandler({
				...responseOptions,
				openAiModelId: model,
				openAiBaseUrl: "https://compatible.example/v1",
				openAiStreamingEnabled: streaming,
			})
		}

		async function usageFor(usage: Record<string, unknown>) {
			chatCreate.mockResolvedValueOnce(
				streaming
					? events(
							{
								choices: [{ delta: { content: "Partial" } }],
								usage: { prompt_tokens: 120, completion_tokens: 2 },
							},
							{ choices: [{ delta: {}, finish_reason: "stop" }], usage },
						)
					: { choices: [{ message: { content: "Done." }, finish_reason: "stop" }], usage },
			)
			const { chunks, failure } = await consume(provider())
			expect(failure).toBeUndefined()
			const usages = chunks.filter((chunk) => chunk.type === "usage")
			expect(usages).toHaveLength(1)
			return usages[0]
		}

		if (streaming) {
			it("preserves its last known cumulative usage exactly once before a stream error", async () => {
				const error = Object.assign(new Error("Transport disconnected"), { status: 503 })
				chatCreate.mockResolvedValueOnce({
					async *[Symbol.asyncIterator]() {
						yield {
							choices: [{ delta: { content: "Partial" } }],
							usage: { prompt_tokens: 120, completion_tokens: 2 },
						}
						yield { choices: [{ delta: { content: " output" } }], usage: chatUsage }
						throw error
					},
				})
				const { chunks, failure } = await consume(provider())
				expect(failure).toMatchObject({ status: 503 })
				expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
					expect.objectContaining({
						inputTokens: 120,
						outputTokens: 30,
						cacheReadTokens: 40,
						reasoningTokens: 12,
					}),
				])
				expect(chatCreate).toHaveBeenCalledOnce()
			})
		}

		it("normalizes nested cache and reasoning counters once without adding reasoning to output", async () => {
			expect(await usageFor(chatUsage)).toMatchObject({
				inputTokens: 120,
				outputTokens: 30,
				cacheReadTokens: 40,
				reasoningTokens: 12,
			})
		})

		it.each([0, 9])("gives valid legacy cache reads (%s) priority over nested cache", async (cacheReadTokens) => {
			const usage = await usageFor({ ...chatUsage, cache_read_input_tokens: cacheReadTokens })
			expect(usage.cacheReadTokens ?? 0).toBe(cacheReadTokens)
		})

		it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "9"])(
			"falls back from invalid legacy cache counters (%s)",
			async (cache_read_input_tokens) => {
				expect(await usageFor({ ...chatUsage, cache_read_input_tokens })).toMatchObject({ cacheReadTokens: 40 })
			},
		)

		it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "9"])(
			"does not emit invalid numeric counters (%s)",
			async (invalid) => {
				const usage = await usageFor({
					prompt_tokens: invalid,
					completion_tokens: invalid,
					cache_creation_input_tokens: invalid,
					prompt_tokens_details: { cached_tokens: invalid },
					completion_tokens_details: { reasoning_tokens: invalid },
				})
				for (const counter of [
					usage.inputTokens,
					usage.outputTokens,
					usage.cacheReadTokens,
					usage.cacheWriteTokens,
					usage.reasoningTokens,
				]) {
					if (counter === undefined) continue
					expect(Number.isFinite(counter)).toBe(true)
					expect(counter).toBeGreaterThanOrEqual(0)
				}
			},
		)
	})
})
