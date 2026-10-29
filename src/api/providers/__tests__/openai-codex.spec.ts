import { OpenAiCodexHandler } from "../openai-codex"
import type { ApiStream, ApiStreamChunk } from "../../transform/stream"

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	chat: vi.fn(),
	construct: vi.fn(),
	authorize: vi.fn(),
	recover: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn(function (options) {
		mocks.construct(options)
		const client = {
			apiKey: options.apiKey,
			responses: { create: mocks.create },
			chat: { completions: { create: mocks.chat } },
			withOptions: vi.fn(() => client),
		}
		return client
	}),
}))

vi.mock("../../../services/chatgpt/ChatGptAuthService", () => ({
	ChatGptAuthService: {
		getInstance: () => ({ authorizeRequest: mocks.authorize, recoverUnauthorizedRequest: mocks.recover }),
	},
}))

function message(text = "answer") {
	return {
		type: "message",
		id: "msg_answer",
		role: "assistant",
		status: "completed",
		phase: "final_answer",
		content: [{ type: "output_text", text, annotations: [] }],
	}
}

function answer(output: unknown[] = [message()]) {
	return {
		id: "resp_chatgpt",
		status: "completed",
		output,
		usage: {
			input_tokens: 20,
			output_tokens: 9,
			input_tokens_details: { cached_tokens: 5 },
			output_tokens_details: { reasoning_tokens: 4 },
		},
	}
}

async function* response(output?: unknown[]) {
	yield { type: "response.completed", response: answer(output) }
}

async function collect(stream: ApiStream): Promise<ApiStreamChunk[]> {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => (resolve = settle))
	return { resolve, promise }
}

beforeEach(() => {
	vi.clearAllMocks()
	const signal = new AbortController().signal
	mocks.authorize.mockResolvedValue({ accessToken: "app-owned-token", signal })
	mocks.recover.mockResolvedValue({ accessToken: "refreshed-app-owned-token", signal })
	mocks.create.mockImplementation(async () => response())
})

describe("Sign in with ChatGPT provider", () => {
	it("recovers an admission 401 once without publishing the provisional failed outcome", async () => {
		mocks.create.mockRejectedValueOnce(Object.assign(new Error("expired credential"), { status: 401 }))
		const chunks = await collect(new OpenAiCodexHandler({}).createMessage("", []))
		expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(
			await mocks.authorize.mock.results[0].value,
			expect.any(AbortSignal),
		)
		expect(mocks.create).toHaveBeenCalledTimes(2)
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "completed", semanticOutputObserved: true }),
		])
	})

	it("does not repeat a request rejected with the refreshed credential", async () => {
		mocks.create.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }))
		const chunks: ApiStreamChunk[] = []
		await expect(
			(async () => {
				for await (const chunk of new OpenAiCodexHandler({}).createMessage("", [])) chunks.push(chunk)
			})(),
		).rejects.toMatchObject({ status: 401, retryable: false })
		expect(mocks.recover).toHaveBeenCalledOnce()
		expect(mocks.create).toHaveBeenCalledTimes(2)
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "failed" }),
		])
	})

	it("does not replay semantic output after an unauthorized stream failure", async () => {
		mocks.create.mockImplementation(async () =>
			(async function* () {
				yield { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" }
				throw Object.assign(new Error("unauthorized"), { status: 401 })
			})(),
		)
		const chunks: ApiStreamChunk[] = []
		await expect(
			(async () => {
				for await (const chunk of new OpenAiCodexHandler({}).createMessage("", [])) chunks.push(chunk)
			})(),
		).rejects.toMatchObject({ status: 401, retryable: false })
		expect(mocks.recover).not.toHaveBeenCalled()
		expect(mocks.create).toHaveBeenCalledOnce()
		expect(chunks).toContainEqual(expect.objectContaining({ type: "text", text: "partial" }))
	})

	it("does not retry inference after refresh confirms unusable credentials", async () => {
		mocks.create.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }))
		mocks.recover.mockRejectedValue(
			Object.assign(new Error("invalid refresh"), { code: "invalid_grant", retryable: false }),
		)
		const chunks: ApiStreamChunk[] = []
		await expect(
			(async () => {
				for await (const chunk of new OpenAiCodexHandler({}).createMessage("", [])) chunks.push(chunk)
			})(),
		).rejects.toMatchObject({ code: "invalid_grant", retryable: false })
		expect(mocks.create).toHaveBeenCalledOnce()
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "failed", semanticOutputObserved: false }),
		])
	})

	it("does not replay a request cancelled during credential recovery", async () => {
		const controller = new AbortController()
		mocks.create.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }))
		mocks.recover.mockImplementation(async (authorization) => {
			controller.abort()
			return { ...authorization, accessToken: "refreshed-app-owned-token" }
		})
		const chunks: ApiStreamChunk[] = []
		await expect(
			(async () => {
				for await (const chunk of new OpenAiCodexHandler({}).createMessage("", [], {
					taskId: "cancelled-recovery",
					signal: controller.signal,
				}))
					chunks.push(chunk)
			})(),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(mocks.create).toHaveBeenCalledOnce()
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "cancelled", semanticOutputObserved: false }),
		])
	})

	it.each(["subscription_sharing_invalid_user", "chatpass_v2_scope_not_authorized"])(
		"does not refresh a permanent %s failure even when its status is 401",
		async (code) => {
			mocks.create.mockRejectedValue(Object.assign(new Error("admission rejected"), { code, status: 401 }))
			await expect(collect(new OpenAiCodexHandler({}).createMessage("", []))).rejects.toMatchObject({
				code,
				retryable: false,
			})
			expect(mocks.recover).not.toHaveBeenCalled()
		},
	)

	it("keeps the original 401 when recovery cannot supply a different permitted token", async () => {
		mocks.recover.mockImplementation(async (authorization) => authorization)
		mocks.create.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }))
		await expect(collect(new OpenAiCodexHandler({}).createMessage("", []))).rejects.toMatchObject({ status: 401 })
		expect(mocks.create).toHaveBeenCalledOnce()
	})

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
		"exposes %s without authentication and sends all supported reasoning efforts",
		async (apiModelId) => {
			const handler = new OpenAiCodexHandler({ apiModelId })
			expect(handler.getModel().id).toBe(apiModelId)
			expect(mocks.authorize).not.toHaveBeenCalled()
			for (const reasoningEffort of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
				handler.setReasoningOptions({ enableReasoningEffort: true, reasoningEffort })
				await collect(handler.createMessage("", []))
				expect(mocks.create.mock.lastCall?.[0]).toMatchObject({
					model: apiModelId,
					reasoning: { effort: reasoningEffort },
				})
				await expect(handler.completePrompt("Enhance")).resolves.toBe("answer")
				expect(mocks.create.mock.lastCall?.[0]).toMatchObject({
					model: apiModelId,
					reasoning: { effort: reasoningEffort },
				})
			}
			handler.setReasoningOptions({ enableReasoningEffort: false, reasoningEffort: "disable" })
			await collect(handler.createMessage("", []))
			expect(mocks.create.mock.lastCall?.[0]).toMatchObject({ model: apiModelId, reasoning: { effort: "none" } })
			await expect(handler.completePrompt("Enhance")).resolves.toBe("answer")
			expect(mocks.create.mock.lastCall?.[0]).toMatchObject({ model: apiModelId, reasoning: { effort: "none" } })
		},
	)

	it("uses the same static frontier catalog without authentication or account discovery", () => {
		const model = new OpenAiCodexHandler({ apiModelId: "gpt-6-astra" }).getModel()
		expect(model).toMatchObject({
			id: "gpt-6-astra",
			toolIdentity: { provider: "openai-codex", id: "gpt-6-astra" },
			info: { supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"] },
		})
		expect(mocks.authorize).not.toHaveBeenCalled()
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it("isolates the official endpoint and request shape from stale compatible/native credentials", async () => {
		const handler = new OpenAiCodexHandler({
			apiModelId: "gpt-6.1-sol",
			openAiBaseUrl: "https://attacker.test",
			openAiApiKey: "other-key",
			openAiNativeApiKey: "native-key",
			openAiHeaders: { Authorization: "other-auth" },
			openAiUseAzure: true,
			openAiStreamingEnabled: false,
			openAiNativeServiceTier: "default",
		})
		const chunks = await collect(
			handler.createMessage("system", [{ role: "user", content: "Hello" }], { taskId: "test", store: true }),
		)
		expect(mocks.construct).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.openai.com/v1", apiKey: "managed-chatgpt-oauth" }),
		)
		expect(mocks.construct.mock.calls[0][0].defaultHeaders).not.toHaveProperty("Authorization")
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			model: "gpt-6.1-sol",
			store: false,
			stream: true,
			input: [
				{ role: "developer", content: "system" },
				{ role: "user", content: "Hello" },
			],
			reasoning: { effort: "medium", summary: "auto" },
		})
		for (const field of [
			"max_output_tokens",
			"temperature",
			"service_tier",
			"previous_response_id",
			"metadata",
			"top_p",
			"prompt_cache_retention",
		])
			expect(mocks.create.mock.calls[0][0]).not.toHaveProperty(field)
		expect(chunks).toContainEqual(expect.objectContaining({ type: "outcome", status: "completed", terminal: true }))
		expect(chunks).toContainEqual(
			expect.objectContaining({
				type: "usage",
				inputTokens: 20,
				outputTokens: 9,
				cacheReadTokens: 5,
				reasoningTokens: 4,
			}),
		)
		expect(mocks.chat).not.toHaveBeenCalled()
	})

	it("groups function/custom tools in the supported namespace and preserves tool/history identity", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
		await collect(
			handler.createMessage(
				"",
				[
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "call_read", name: "read_file", input: { path: "a.ts" } }],
					},
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "data" }] },
				],
				{
					taskId: "test",
					tools: [
						{
							type: "function",
							function: {
								name: "read_file",
								description: "Read a file",
								parameters: {
									type: "object",
									properties: { path: { type: "string" } },
									required: ["path"],
									additionalProperties: false,
								},
							},
						},
					],
					tool_choice: { type: "function", function: { name: "read_file" } },
				},
			),
		)
		const request = mocks.create.mock.calls[0][0]
		expect(request.tools).toEqual([
			expect.objectContaining({
				type: "namespace",
				name: "alpha",
				tools: [expect.objectContaining({ type: "function", name: "read_file" })],
			}),
		])
		expect(request.tool_choice).toMatchObject({ type: "function", name: "read_file", namespace: "alpha" })
		expect(request.input).toContainEqual(
			expect.objectContaining({
				type: "function_call",
				call_id: "call_read",
				name: "read_file",
				namespace: "alpha",
			}),
		)
		expect(request.input).toContainEqual(
			expect.objectContaining({ type: "function_call_output", call_id: "call_read", output: "data" }),
		)
	})

	it.each([1, Infinity])(
		"ignores an incompatible saved output cap (%s) before native request validation",
		async (modelMaxTokens) => {
			const handler = new OpenAiCodexHandler({
				apiModelId: "gpt-6.1-sol",
				includeMaxTokens: true,
				modelMaxTokens,
				modelTemperature: 1,
				openAiNativeServiceTier: "default",
			})
			await collect(handler.createMessage("", []))
			await expect(handler.completePrompt("Enhance")).resolves.toBe("answer")
			for (const [request] of mocks.create.mock.calls) {
				expect(request).not.toHaveProperty("max_output_tokens")
				expect(request).not.toHaveProperty("temperature")
				expect(request).not.toHaveProperty("service_tier")
			}
		},
	)

	it("uses the canonical streamed tool normalization and encrypted reasoning", async () => {
		mocks.create.mockImplementation(async () =>
			response([
				{
					type: "reasoning",
					id: "reasoning-one",
					encrypted_content: "opaque",
					summary: [{ type: "summary_text", text: "Thinking" }],
				},
				{
					type: "function_call",
					id: "fc_one",
					call_id: "call_one",
					name: "read_file",
					namespace: "alpha",
					arguments: '{"path":"a.ts"}',
					status: "completed",
				},
			]),
		)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6-astra" })
		const chunks = await collect(handler.createMessage("", []))
		expect(chunks).toContainEqual(
			expect.objectContaining({
				type: "tool_call",
				id: "call_one",
				name: "read_file",
				arguments: '{"path":"a.ts"}',
			}),
		)
		expect(chunks.filter(({ type }) => type === "tool_call_end")).toEqual([
			{ type: "tool_call_end", id: "call_one" },
		])
		expect(handler.getReasoningItems()).toEqual([
			{ id: "reasoning-one", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "Thinking" }] },
		])
	})

	it("streams auxiliary completions and leaves task response state untouched", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol", reasoningEffort: "high" })
		await expect(handler.completePrompt("Enhance")).resolves.toBe("answer")
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			stream: true,
			store: false,
			reasoning: { effort: "high" },
		})
		expect(handler.getResponseId()).toBeUndefined()
	})

	it("does not accept an auxiliary stream without response.completed", async () => {
		mocks.create.mockImplementation(async () =>
			(async function* () {
				yield {
					type: "response.output_text.delta",
					output_index: 0,
					content_index: 0,
					item_id: "msg_answer",
					delta: "partial",
				}
			})(),
		)
		await expect(new OpenAiCodexHandler({}).completePrompt("Enhance")).rejects.toThrow(/complete|terminal/i)
	})

	it.each([
		{ output: [], end_turn: true },
		{ output: [message("partial commentary")], end_turn: false },
	])("rejects empty or continuing auxiliary completions", async (fields) => {
		mocks.create.mockImplementation(async () =>
			(async function* () {
				yield { type: "response.completed", response: { ...answer(), ...fields } }
			})(),
		)
		await expect(new OpenAiCodexHandler({}).completePrompt("Enhance")).rejects.toThrow("did not complete")
	})

	it("cancels authentication admission before any model request", async () => {
		const waiting = deferred<{ accessToken: string; signal: AbortSignal }>()
		mocks.authorize.mockImplementation(async (signal: AbortSignal) => {
			await new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			)
			return waiting.promise
		})
		const controller = new AbortController()
		const handler = new OpenAiCodexHandler({})
		const stream = handler.createMessage("", [], { taskId: "test", signal: controller.signal })
		const next = stream.next()
		controller.abort()
		await expect(next).resolves.toMatchObject({ value: { type: "outcome", status: "cancelled" } })
		await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" })
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it("aborts an in-flight response when the active account signs out", async () => {
		const account = new AbortController()
		mocks.authorize.mockResolvedValue({ accessToken: "token", signal: account.signal })
		const entered = deferred<void>()
		mocks.create.mockImplementation(async () =>
			(async function* () {
				entered.resolve()
				yield await new Promise<never>(() => undefined)
			})(),
		)
		const handler = new OpenAiCodexHandler({})
		const stream = handler.createMessage("", [])
		const next = stream.next()
		await entered.promise
		account.abort()
		await expect(next).resolves.toMatchObject({ value: { type: "outcome", status: "cancelled" } })
		await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" })
	})

	it.each([
		"subscription_sharing_usage_limit_exceeded",
		"subscription_sharing_unsupported_capability",
		"subscription_sharing_user_not_eligible",
	])("does not retry unchanged %s requests", async (code) => {
		mocks.create.mockImplementation(async () =>
			(async function* () {
				yield { type: "response.failed", response: { error: { code, message: "Account usage unavailable" } } }
			})(),
		)
		await expect(collect(new OpenAiCodexHandler({}).createMessage("", []))).rejects.toMatchObject({
			code,
			retryable: false,
		})
	})
})
