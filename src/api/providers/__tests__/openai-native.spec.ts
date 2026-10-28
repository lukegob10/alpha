import { OpenAiNativeHandler } from "../openai-native"
import { buildOpenAiResponsesInput } from "../openai-responses"
import type { ApiStream, ApiStreamChunk } from "../../transform/stream"
import { resolveTaskReasoning } from "../../../core/agent/TaskReasoning"

const frontierReasoningModels = ["gpt-6.1-sol", "gpt-6-astra"] as const

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	chat: vi.fn(),
	construct: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn(function (options) {
		mocks.construct(options)
		return { responses: { create: mocks.create }, chat: { completions: { create: mocks.chat } } }
	}),
}))

const answer = (output: unknown[] = [message("answer")]) => ({
	id: "resp_native",
	status: "completed",
	output,
	usage: { input_tokens: 15, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } },
})

function message(text: string) {
	return {
		type: "message",
		id: "msg_answer",
		role: "assistant",
		status: "completed",
		phase: "final_answer",
		content: [{ type: "output_text", text, annotations: [] }],
	}
}

async function* streamResponse(response: ReturnType<typeof answer> & { incomplete_details?: { reason: string } }) {
	yield { type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => (resolve = settle))
	return { promise, resolve }
}

async function collect(stream: ApiStream): Promise<ApiStreamChunk[]> {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

beforeEach(() => {
	vi.resetAllMocks()
	mocks.create.mockImplementation(async (request) => (request.stream ? streamResponse(answer()) : answer()))
})

describe("native OpenAI provider", () => {
	it("isolates native model, endpoint, credentials, and protocol from compatible settings", async () => {
		const options = {
			apiModelId: "gpt-6.1-sol",
			openAiNativeApiKey: " native-key ",
			openAiBaseUrl: "https://other.example.test/v1",
			openAiApiKey: "compatible-key",
			openAiModelId: "unrelated-model",
			openAiUseAzure: true,
			openAiHeaders: { Authorization: "unrelated-authorization" },
			openAiR1FormatEnabled: true,
		}
		const before = structuredClone(options)
		const handler = new OpenAiNativeHandler(options)
		await collect(handler.createMessage("system", [{ role: "user", content: "hello" }]))

		expect(options).toEqual(before)
		expect(mocks.construct).toHaveBeenCalledOnce()
		expect(mocks.construct).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.openai.com/v1", apiKey: "native-key" }),
		)
		expect(mocks.construct.mock.calls[0][0].defaultHeaders).not.toHaveProperty("Authorization")
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			model: "gpt-6.1-sol",
			reasoning: { effort: "medium", summary: "auto" },
			store: false,
		})
		expect(mocks.chat).not.toHaveBeenCalled()
	})

	it("uses the verified catalog and independent input/output limits", () => {
		const model = new OpenAiNativeHandler({ openAiNativeApiKey: "key" }).getModel()
		expect(model).toMatchObject({
			id: "gpt-6.1-sol",
			toolIdentity: { provider: "openai-native", id: "gpt-6.1-sol" },
			info: {
				contextWindow: 922_000,
				contextWindowIncludesOutput: false,
				maxTokens: 128_000,
				requiredReasoningEffort: true,
				supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
			},
		})
	})

	it.each(frontierReasoningModels)(
		"uses Responses and the medium default for %s task and auxiliary requests",
		async (id) => {
			const handler = new OpenAiNativeHandler({ openAiNativeApiKey: "key", apiModelId: id })
			await collect(handler.createMessage("", []))
			await expect(handler.completePrompt("Enhance")).resolves.toBe("answer")
			expect(handler.getModel().id).toBe(id)
			for (const [request] of mocks.create.mock.calls) {
				expect(request).toMatchObject({ model: id, reasoning: { effort: "medium" } })
			}
			expect(mocks.chat).not.toHaveBeenCalled()
		},
	)

	it.each(frontierReasoningModels)("retains required reasoning for %s when saved effort is none", async (id) => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "key",
			apiModelId: id,
			reasoningEffort: "none",
		})
		await collect(handler.createMessage("", []))
		await handler.completePrompt("Enhance")
		for (const [request] of mocks.create.mock.calls) {
			expect(request).toMatchObject({ model: id, reasoning: { effort: "medium" } })
		}
	})

	it.each(frontierReasoningModels)("retains %s required reasoning after task Off is requested", async (id) => {
		const configuration = { apiProvider: "openai-native" as const, openAiNativeApiKey: "key", apiModelId: id }
		const handler = new OpenAiNativeHandler(configuration)
		const resolved = resolveTaskReasoning(configuration, { kind: "off" }, handler.getModel())
		handler.setReasoningOptions(resolved.configuration)
		await collect(handler.createMessage("", []))
		await handler.completePrompt("Enhance")
		expect(configuration).not.toHaveProperty("reasoningEffort")
		for (const [request] of mocks.create.mock.calls) {
			expect(request).toMatchObject({ model: id, reasoning: { effort: "medium" } })
		}
	})

	it.each(frontierReasoningModels)(
		"uses the %s required default for a saved disabled profile on both request kinds",
		async (id) => {
			const handler = new OpenAiNativeHandler({
				openAiNativeApiKey: "key",
				apiModelId: id,
				enableReasoningEffort: false,
				reasoningEffort: "disable",
			})
			await collect(handler.createMessage("", []))
			await handler.completePrompt("Enhance")
			for (const [request] of mocks.create.mock.calls) {
				expect(request).toMatchObject({ model: id, reasoning: { effort: "medium" } })
			}
		},
	)

	it.each([
		"",
		" ",
		"__proto__",
		"gpt-6.1-sol-preview",
		"unknown-model",
		"gpt-6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
	])("rejects unsupported model %s before constructing a transport", (apiModelId) => {
		expect(() => new OpenAiNativeHandler({ apiModelId, openAiNativeApiKey: "key" })).toThrow(
			"Unsupported OpenAI model",
		)
		expect(mocks.construct).not.toHaveBeenCalled()
	})

	it("rejects missing native credentials instead of borrowing the compatible key", () => {
		expect(() => new OpenAiNativeHandler({ openAiApiKey: "compatible-key" })).toThrow("OpenAI API key is required")
		expect(mocks.construct).not.toHaveBeenCalled()
	})

	it.each([
		{ openAiNativeBaseUrl: "https://other.example.test/v1" },
		{ openAiNativeServiceTier: "priority" as const },
	])("rejects unsupported saved routing without exposing its values", (legacyOptions) => {
		expect(() => new OpenAiNativeHandler({ openAiNativeApiKey: "key", ...legacyOptions })).toThrow(
			"Unsupported OpenAI settings",
		)
		expect(mocks.construct).not.toHaveBeenCalled()
	})

	it("emits one terminal success, tracks reasoning usage, and omits unsupported sampling", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "key",
			apiModelId: "gpt-6-astra",
			reasoningEffort: "high",
			modelTemperature: 0.1,
			verbosity: "low",
		})
		const chunks = await collect(handler.createMessage("", []))
		expect(handler.streamCapabilities).toEqual({ cancellation: true, lifecycle: true })
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "completed", terminal: true, semanticOutputObserved: true }),
		])
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "usage", inputTokens: 15, outputTokens: 9, reasoningTokens: 4 }),
		)
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			reasoning: { effort: "high", summary: "auto" },
			text: { verbosity: "low" },
		})
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("temperature")
	})

	it("retains each encrypted reasoning item and replays it around tool transactions", async () => {
		const reasoning = { type: "reasoning", id: "rs_one", encrypted_content: "opaque+/=", summary: [] }
		mocks.create.mockResolvedValueOnce(streamResponse(answer([reasoning, message("answer")])))
		const handler = new OpenAiNativeHandler({ openAiNativeApiKey: "key" })
		const chunks = await collect(handler.createMessage("", []))
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "reasoning", id: "rs_one", encryptedContent: "opaque+/=", summary: [] }),
		)
		expect(handler.getReasoningItems()).toEqual([{ id: "rs_one", encrypted_content: "opaque+/=", summary: [] }])
		const history = [
			{
				role: "assistant",
				content: [reasoning, { type: "tool_use", id: "call_one", name: "read_file", input: {} }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_one", content: "file contents" }] },
		]
		expect(buildOpenAiResponsesInput("", [], history, false)).toEqual([
			{ type: "reasoning", encrypted_content: "opaque+/=", summary: [] },
			{ type: "function_call", call_id: "call_one", name: "read_file", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_one", output: "file contents" },
		])
	})

	it("retains an explicitly saved default service tier for task and auxiliary requests", async () => {
		const handler = new OpenAiNativeHandler({ openAiNativeApiKey: "key", openAiNativeServiceTier: "default" })
		await collect(handler.createMessage("", []))
		await handler.completePrompt("Enhance")
		for (const [request] of mocks.create.mock.calls) expect(request.service_tier).toBe("default")
	})

	it("uses the catalog default for unsupported or disabled required reasoning", () => {
		const handler = new OpenAiNativeHandler({ openAiNativeApiKey: "key", reasoningEffort: "ultra" })
		expect(handler.getModel().reasoning).toEqual({ reasoning_effort: "medium" })
		handler.setReasoningOptions({ enableReasoningEffort: false, reasoningEffort: "disable" })
		expect(handler.getModel().reasoning).toEqual({ reasoning_effort: "medium" })
	})

	it("rejects truncated streams with one failed outcome", async () => {
		mocks.create.mockResolvedValueOnce(
			(async function* () {
				yield {
					type: "response.output_text.delta",
					item_id: "msg",
					output_index: 0,
					content_index: 0,
					delta: "part",
				}
			})(),
		)
		const chunks: ApiStreamChunk[] = []
		await expect(
			(async () => {
				for await (const chunk of new OpenAiNativeHandler({ openAiNativeApiKey: "key" }).createMessage(
					"",
					[],
				)) {
					chunks.push(chunk)
				}
			})(),
		).rejects.toThrow("without a terminal event")
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "failed" }),
		])
	})

	it("reports pre-cancellation without dispatch and preserves the cancellation reason", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled by caller")
		controller.abort(reason)
		const stream = new OpenAiNativeHandler({ openAiNativeApiKey: "key" }).createMessage("", [], {
			taskId: "task",
			signal: controller.signal,
		})
		expect(await stream.next()).toMatchObject({ value: { type: "outcome", status: "cancelled" } })
		await expect(stream.next()).rejects.toBe(reason)
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it("cancels stalled request admission and ignores a late response without completing twice", async () => {
		const admitted = deferred<void>()
		const lateResponse = deferred<AsyncGenerator<unknown>>()
		mocks.create.mockImplementationOnce(() => {
			admitted.resolve(undefined)
			return lateResponse.promise
		})
		const controller = new AbortController()
		const stream = new OpenAiNativeHandler({ openAiNativeApiKey: "key" }).createMessage("", [], {
			taskId: "task",
			signal: controller.signal,
		})
		const next = stream.next()
		await admitted.promise
		const reason = new Error("cancelled stalled request")
		controller.abort(reason)
		expect(await next).toMatchObject({ value: { type: "outcome", status: "cancelled" } })
		await expect(stream.next()).rejects.toBe(reason)
		lateResponse.resolve(streamResponse(answer()))
		expect(await stream.next()).toEqual({ done: true, value: undefined })
	})

	it("reports an incomplete task response once while retaining the actionable error code", async () => {
		mocks.create.mockResolvedValueOnce(
			streamResponse({ ...answer(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
		)
		const chunks: ApiStreamChunk[] = []
		await expect(
			(async () => {
				for await (const chunk of new OpenAiNativeHandler({ openAiNativeApiKey: "key" }).createMessage(
					"",
					[],
				)) {
					chunks.push(chunk)
				}
			})(),
		).rejects.toMatchObject({ code: "response_incomplete" })
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "incomplete", reason: expect.stringContaining("max_output_tokens") }),
		])
	})

	it("uses Responses for auxiliary completions without overwriting retained task state", async () => {
		const handler = new OpenAiNativeHandler({ openAiNativeApiKey: "key" })
		await collect(handler.createMessage("", []))
		mocks.create.mockResolvedValueOnce({ ...answer([message("enhanced")]), id: "resp_auxiliary" })
		await expect(handler.completePrompt("Enhance")).resolves.toBe("enhanced")
		expect(handler.getResponseId()).toBe("resp_native")
		expect(mocks.create.mock.calls[1][0]).toMatchObject({ stream: false, store: false, model: "gpt-6.1-sol" })
		expect(mocks.chat).not.toHaveBeenCalled()
	})

	it.each([
		{ ...answer(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
		{ ...answer(), end_turn: false },
		answer([{ type: "function_call", id: "fc", call_id: "call", name: "read_file", arguments: "{}" }]),
		answer([]),
	])("rejects auxiliary results that do not contain a complete final text answer", async (response) => {
		mocks.create.mockResolvedValueOnce(response)
		await expect(new OpenAiNativeHandler({ openAiNativeApiKey: "key" }).completePrompt("Enhance")).rejects.toThrow()
	})

	it("ignores a late auxiliary result after cancellation", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled auxiliary")
		mocks.create.mockImplementationOnce(() => {
			controller.abort(reason)
			return Promise.resolve(answer())
		})
		await expect(
			new OpenAiNativeHandler({ openAiNativeApiKey: "key" }).completePrompt("Enhance", {
				signal: controller.signal,
			}),
		).rejects.toBe(reason)
		expect(mocks.create.mock.calls[0][1]).toEqual({ signal: controller.signal })
	})
})
