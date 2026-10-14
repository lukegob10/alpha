import type { ModelInfo } from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"
import { OpenAiHandler } from "../openai"

const mocks = vi.hoisted(() => ({
	chatCreate: vi.fn(),
	responsesCreate: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn(function () {
		return {
			chat: { completions: { create: mocks.chatCreate } },
			responses: { create: mocks.responsesCreate },
		}
	}),
	AzureOpenAI: vi.fn(function () {
		return {
			chat: { completions: { create: mocks.chatCreate } },
			responses: { create: mocks.responsesCreate },
		}
	}),
}))

function modelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		contextWindow: 128_000,
		maxTokens: 8192,
		supportsPromptCache: false,
		supportsTemperature: true,
		...overrides,
	}
}

function createHandler(overrides: ApiHandlerOptions = {}): OpenAiHandler {
	return new OpenAiHandler({
		openAiApiKey: "test-key",
		openAiModelId: "compatible-model",
		openAiBaseUrl: "https://gateway.example/v1",
		openAiCustomModelInfo: modelInfo(),
		...overrides,
	})
}

async function consumeTask(handler: OpenAiHandler): Promise<void> {
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
		// Observe the complete request path, including non-streaming response consumption.
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.chatCreate.mockImplementation(async ({ stream }: { stream?: boolean }) => {
		if (stream) {
			return {
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ delta: { content: "answer" } }] }
					yield { choices: [{ delta: {}, finish_reason: "stop" }] }
				},
			}
		}
		return { choices: [{ message: { content: "answer" }, finish_reason: "stop" }] }
	})
	mocks.responsesCreate.mockImplementation(async ({ stream }: { stream?: boolean }) => {
		const response = {
			id: "response-id",
			status: "completed",
			output_text: "answer",
			output: [
				{
					id: "message-id",
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "answer", annotations: [] }],
				},
			],
			usage: null,
		}
		if (stream) {
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "answer" }
					yield { type: "response.completed", response }
				},
			}
		}
		return response
	})
})

describe.each([
	{
		name: "compatible Chat Completions",
		modelId: "compatible-model",
		baseUrl: "https://gateway.example/v1",
		parameter: "max_completion_tokens",
		create: mocks.chatCreate,
	},
	{
		name: "native Responses",
		modelId: "gpt-5.5",
		baseUrl: "https://api.openai.com/v1",
		parameter: "max_output_tokens",
		create: mocks.responsesCreate,
	},
])("$name output limits", ({ modelId, baseUrl, parameter, create }) => {
	describe.each([true, false])("streaming=%s", (streaming) => {
		it.each([
			{ include: true, custom: 1024, model: 8192, expected: 1024 },
			{ include: true, custom: undefined, model: 8192, expected: 8192 },
			{ include: true, custom: -1, model: 8192, expected: undefined },
			{ include: true, custom: undefined, model: -1, expected: undefined },
			{ include: true, custom: undefined, model: undefined, expected: undefined },
			{ include: false, custom: 1024, model: 8192, expected: undefined },
			{ include: undefined, custom: 1024, model: 8192, expected: undefined },
			{ include: false, custom: 0, model: 8192, expected: undefined },
		])("include=$include custom=$custom model=$model", async ({ include, custom, model, expected }) => {
			await consumeTask(
				createHandler({
					openAiModelId: modelId,
					openAiBaseUrl: baseUrl,
					openAiStreamingEnabled: streaming,
					includeMaxTokens: include,
					modelMaxTokens: custom,
					openAiCustomModelInfo: modelInfo({ maxTokens: model }),
				}),
			)
			const [request] = create.mock.calls[0]
			if (expected === undefined) {
				expect(request).not.toHaveProperty(parameter)
			} else {
				expect(request[parameter]).toBe(expected)
			}
		})

		it.each([0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
			"rejects invalid explicit cap %s before transport",
			async (cap) => {
				await expect(
					consumeTask(
						createHandler({
							openAiModelId: modelId,
							openAiBaseUrl: baseUrl,
							openAiStreamingEnabled: streaming,
							includeMaxTokens: true,
							modelMaxTokens: cap,
						}),
					),
				).rejects.toThrow(/output|token/i)
				expect(create).not.toHaveBeenCalled()
			},
		)
	})
})

describe("transport parameter applicability", () => {
	it.each([true, false])("honors compatible temperature with streaming=%s", async (streaming) => {
		await consumeTask(
			createHandler({
				openAiStreamingEnabled: streaming,
				modelTemperature: 0,
				openAiCustomModelInfo: modelInfo({ supportsTemperature: true }),
			}),
		)
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("temperature", 0)
	})

	it.each([true, false])("omits explicitly unsupported temperature with streaming=%s", async (streaming) => {
		await consumeTask(
			createHandler({
				openAiStreamingEnabled: streaming,
				modelTemperature: 0.8,
				openAiCustomModelInfo: modelInfo({ supportsTemperature: false }),
			}),
		)
		expect(mocks.chatCreate.mock.calls[0][0]).not.toHaveProperty("temperature")
	})

	it.each(["stream", "response", "single-prompt"])(
		"preserves saved sampling in a legacy compatible profile on %s",
		async (surface) => {
			const handler = createHandler({
				openAiModelId: "legacy-compatible-model",
				openAiStreamingEnabled: surface === "stream",
				modelTemperature: 0.8,
				openAiCustomModelInfo: { contextWindow: 128_000, maxTokens: -1, supportsPromptCache: false },
			})
			if (surface === "single-prompt") {
				await handler.completePrompt("hello")
			} else {
				await consumeTask(handler)
			}
			expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("temperature", 0.8)
		},
	)

	it("honors an advertised compatible temperature parameter", async () => {
		await consumeTask(
			createHandler({
				modelTemperature: 0.8,
				openAiCustomModelInfo: modelInfo({
					supportsTemperature: undefined,
					supportedParameters: ["temperature"],
				}),
			}),
		)
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("temperature", 0.8)
	})

	it("omits a compatible temperature excluded by declared parameter metadata", async () => {
		await consumeTask(
			createHandler({
				modelTemperature: 0.8,
				openAiCustomModelInfo: modelInfo({
					supportsTemperature: undefined,
					supportedParameters: ["reasoning"],
				}),
			}),
		)
		expect(mocks.chatCreate.mock.calls[0][0]).not.toHaveProperty("temperature")
	})

	it.each(["stream", "response", "single-prompt"])(
		"preserves fixed compatible budget sampling on %s",
		async (surface) => {
			const handler = createHandler({
				openAiStreamingEnabled: surface === "stream",
				modelTemperature: 0.4,
				enableReasoningEffort: true,
				openAiCustomModelInfo: modelInfo({ supportsReasoningBudget: true, supportsTemperature: true }),
			})
			if (surface === "single-prompt") {
				await handler.completePrompt("hello")
			} else {
				await consumeTask(handler)
			}
			expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("temperature", 1)
		},
	)

	it.each([true, false])("uses compatible model temperature default with streaming=%s", async (streaming) => {
		await consumeTask(
			createHandler({
				openAiStreamingEnabled: streaming,
				openAiCustomModelInfo: modelInfo({ supportsTemperature: true, defaultTemperature: 0.6 }),
			}),
		)
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("temperature", 0.6)
	})

	it.each([true, false])("preserves the compatible R1 temperature default with streaming=%s", async (streaming) => {
		await consumeTask(createHandler({ openAiStreamingEnabled: streaming, openAiR1FormatEnabled: true }))
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("temperature", 0.3)
	})

	it.each(["o1-custom", "o3-custom", "o4-custom"])("omits temperature on the %s reasoning branch", async (id) => {
		await consumeTask(
			createHandler({
				openAiModelId: id,
				modelTemperature: 0.8,
				openAiCustomModelInfo: modelInfo({ supportsTemperature: true }),
			}),
		)
		expect(mocks.chatCreate.mock.calls[0][0].temperature).toBeUndefined()
	})

	it.each([true, false])("sends supported Responses verbosity with streaming=%s", async (streaming) => {
		await consumeTask(
			createHandler({
				openAiModelId: "gpt-5.5",
				openAiBaseUrl: "https://api.openai.com/v1",
				openAiStreamingEnabled: streaming,
				modelTemperature: 0.8,
				verbosity: "high",
				openAiCustomModelInfo: modelInfo({ supportsTemperature: true, supportsVerbosity: true }),
			}),
		)
		const [request] = mocks.responsesCreate.mock.calls[0]
		expect(request).toHaveProperty("text.verbosity", "high")
		expect(request).not.toHaveProperty("temperature")
		expect(request).not.toHaveProperty("verbosity")
	})

	it.each([false, undefined])("omits unsupported or unknown Responses verbosity (%s)", async (supported) => {
		await consumeTask(
			createHandler({
				openAiModelId: "gpt-5.5",
				openAiBaseUrl: "https://api.openai.com/v1",
				verbosity: "high",
				openAiCustomModelInfo: modelInfo({ supportsVerbosity: supported }),
			}),
		)
		expect(mocks.responsesCreate.mock.calls[0][0]).not.toHaveProperty("text.verbosity")
	})

	it("omits unset verbosity rather than choosing a request default", async () => {
		await consumeTask(
			createHandler({
				openAiModelId: "gpt-5.4",
				openAiBaseUrl: "https://api.openai.com/v1",
				openAiCustomModelInfo: modelInfo({ supportsVerbosity: true }),
			}),
		)
		expect(mocks.responsesCreate.mock.calls[0][0]).not.toHaveProperty("text.verbosity")
	})

	it.each([
		{ name: "an unknown preview", openAiModelId: "gpt-5.5-preview" },
		{ name: "an Azure deployment", openAiUseAzure: true },
		{ name: "the R1 format", openAiR1FormatEnabled: true },
	])("preserves the compatible transport for $name", async ({ name: _name, ...route }) => {
		await consumeTask(
			createHandler({
				openAiModelId: "gpt-5.5",
				openAiBaseUrl: "https://api.openai.com/v1",
				verbosity: "high",
				modelTemperature: 0.5,
				openAiCustomModelInfo: modelInfo({ supportsVerbosity: true }),
				...route,
			}),
		)
		expect(mocks.responsesCreate).not.toHaveBeenCalled()
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("temperature", 0.5)
		expect(mocks.chatCreate.mock.calls[0][0]).not.toHaveProperty("text.verbosity")
	})

	it("keeps saved verbosity out of an unsupported compatible route", async () => {
		await consumeTask(
			createHandler({ verbosity: "high", openAiCustomModelInfo: modelInfo({ supportsVerbosity: true }) }),
		)
		const [request] = mocks.chatCreate.mock.calls[0]
		expect(request).not.toHaveProperty("verbosity")
		expect(request).not.toHaveProperty("text.verbosity")
	})

	it("re-resolves saved parameters when a model moves between native and gateway routes", async () => {
		const settings = {
			openAiModelId: "gpt-5.5",
			modelTemperature: 0.8,
			verbosity: "low" as const,
			openAiCustomModelInfo: modelInfo({ supportsTemperature: true, supportsVerbosity: true }),
		}
		await consumeTask(createHandler({ ...settings, openAiBaseUrl: "https://api.openai.com/v1" }))
		await consumeTask(createHandler({ ...settings, openAiBaseUrl: "https://gateway.example/v1" }))
		const [responsesRequest] = mocks.responsesCreate.mock.calls[0]
		const [chatRequest] = mocks.chatCreate.mock.calls[0]
		expect(responsesRequest).toHaveProperty("text.verbosity", "low")
		expect(responsesRequest).not.toHaveProperty("temperature")
		expect(chatRequest).toHaveProperty("temperature", 0.8)
		expect(chatRequest).not.toHaveProperty("text.verbosity")
	})
})

describe("single prompt parameter routes", () => {
	it("sends supported compatible temperature for a single prompt", async () => {
		const result = await createHandler({ modelTemperature: 0.8 }).completePrompt("hello")
		expect(result).toBe("answer")
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("temperature", 0.8)
	})

	it.each(["low", "medium", "high"] as const)(
		"uses native text-only Chat Completions with supported verbosity=%s and a positive cap",
		async (verbosity) => {
			const result = await createHandler({
				openAiModelId: "gpt-6.1-sol",
				openAiBaseUrl: "https://api.openai.com/v1",
				modelTemperature: 0.8,
				verbosity,
				includeMaxTokens: true,
				modelMaxTokens: 4096,
				openAiCustomModelInfo: modelInfo({ supportsTemperature: true, supportsVerbosity: true }),
			}).completePrompt("hello")
			expect(result).toBe("answer")
			expect(mocks.responsesCreate).not.toHaveBeenCalled()
			expect(mocks.chatCreate).toHaveBeenCalledOnce()
			const [request] = mocks.chatCreate.mock.calls[0]
			expect(request).toMatchObject({
				model: "gpt-6.1-sol",
				messages: [{ role: "user", content: "hello" }],
				max_completion_tokens: 4096,
				verbosity,
			})
			for (const parameter of ["temperature", "tools", "text", "max_output_tokens"]) {
				expect(request).not.toHaveProperty(parameter)
			}
		},
	)

	it.each([
		{ support: false, verbosity: "high" as const },
		{ support: undefined, verbosity: "high" as const },
		{ support: true, verbosity: undefined },
	])("omits inapplicable native single-prompt verbosity ($support, $verbosity)", async ({ support, verbosity }) => {
		await createHandler({
			openAiModelId: "gpt-6.1-sol",
			openAiBaseUrl: "https://api.openai.com/v1",
			verbosity,
			openAiCustomModelInfo: modelInfo({ supportsVerbosity: support }),
		}).completePrompt("hello")
		expect(mocks.responsesCreate).not.toHaveBeenCalled()
		expect(mocks.chatCreate.mock.calls[0][0]).not.toHaveProperty("verbosity")
	})

	describe.each([
		{ name: "native", modelId: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1" },
		{ name: "compatible", modelId: "compatible-model", baseUrl: "https://gateway.example/v1" },
	])("$name single-prompt output limits and failures", ({ modelId, baseUrl }) => {
		it.each([
			{ include: true, cap: 1024, model: 8192, expected: 1024 },
			{ include: true, cap: undefined, model: 8192, expected: 8192 },
			{ include: true, cap: -1, model: 8192, expected: undefined },
			{ include: true, cap: undefined, model: -1, expected: undefined },
			{ include: true, cap: undefined, model: undefined, expected: undefined },
			{ include: false, cap: 1024, model: 8192, expected: undefined },
			{ include: undefined, cap: 1024, model: 8192, expected: undefined },
			{ include: false, cap: 0, model: 8192, expected: undefined },
		])("include=$include cap=$cap model=$model", async ({ include, cap, model, expected }) => {
			await createHandler({
				openAiModelId: modelId,
				openAiBaseUrl: baseUrl,
				includeMaxTokens: include,
				modelMaxTokens: cap,
				openAiCustomModelInfo: modelInfo({ maxTokens: model }),
			}).completePrompt("hello")
			expect(mocks.responsesCreate).not.toHaveBeenCalled()
			const [request] = mocks.chatCreate.mock.calls[0]
			if (expected === undefined) {
				expect(request).not.toHaveProperty("max_completion_tokens")
			} else {
				expect(request).toHaveProperty("max_completion_tokens", expected)
			}
		})

		it.each([0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
			"rejects invalid single-prompt cap %s before transport",
			async (cap) => {
				await expect(
					createHandler({
						openAiModelId: modelId,
						openAiBaseUrl: baseUrl,
						includeMaxTokens: true,
						modelMaxTokens: cap,
					}).completePrompt("hello"),
				).rejects.toThrow(/output|token/i)
				expect(mocks.chatCreate).not.toHaveBeenCalled()
				expect(mocks.responsesCreate).not.toHaveBeenCalled()
			},
		)

		it("preserves SDK failure advice and saved parameters through the text-only request", async () => {
			const savedOptions: ApiHandlerOptions = {
				openAiModelId: modelId,
				openAiBaseUrl: baseUrl,
				modelTemperature: 0.8,
				verbosity: "high",
				includeMaxTokens: true,
				modelMaxTokens: 4096,
				openAiCustomModelInfo: modelInfo({ supportsVerbosity: true }),
			}
			const savedSnapshot = structuredClone(savedOptions)
			const handler = createHandler(savedOptions)
			const modelBefore = handler.getModel()
			mocks.chatCreate.mockRejectedValueOnce(
				Object.assign(new Error("Rate limited"), {
					status: 429,
					code: "rate_limit_exceeded",
					headers: { "retry-after": "60" },
				}),
			)
			await expect(handler.completePrompt("hello")).rejects.toMatchObject({
				status: 429,
				code: "rate_limit_exceeded",
				retryAfterMs: 60_000,
				message: "OpenAI completion error: Rate limited",
			})
			expect(mocks.chatCreate).toHaveBeenCalledOnce()
			expect(mocks.responsesCreate).not.toHaveBeenCalled()
			expect(handler.getModel()).toEqual(modelBefore)
			expect(savedOptions).toEqual(savedSnapshot)
		})
	})

	it.each([1, 15, 16])("keeps positive text-only caps below the Responses minimum (%s)", async (cap) => {
		await createHandler({
			openAiModelId: "gpt-6.1-sol",
			openAiBaseUrl: "https://api.openai.com/v1",
			includeMaxTokens: true,
			modelMaxTokens: cap,
		}).completePrompt("hello")
		expect(mocks.responsesCreate).not.toHaveBeenCalled()
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("max_completion_tokens", cap)
	})
})

describe.each(["stream", "response"])("output-cap task transport minimum on %s", (surface) => {
	it("rejects native Responses cap 15 before transport", async () => {
		await expect(
			consumeTask(
				createHandler({
					openAiModelId: "gpt-5.4",
					openAiBaseUrl: "https://api.openai.com/v1",
					openAiStreamingEnabled: surface === "stream",
					includeMaxTokens: true,
					modelMaxTokens: 15,
				}),
			),
		).rejects.toThrow(/16|minimum|output/i)
		expect(mocks.responsesCreate).not.toHaveBeenCalled()
	})

	it("accepts native Responses cap 16", async () => {
		await consumeTask(
			createHandler({
				openAiModelId: "gpt-5.4",
				openAiBaseUrl: "https://api.openai.com/v1",
				openAiStreamingEnabled: surface === "stream",
				includeMaxTokens: true,
				modelMaxTokens: 16,
			}),
		)
		expect(mocks.responsesCreate.mock.calls[0][0]).toHaveProperty("max_output_tokens", 16)
	})

	it("preserves compatible Chat Completions cap 1", async () => {
		await consumeTask(
			createHandler({ openAiStreamingEnabled: surface === "stream", includeMaxTokens: true, modelMaxTokens: 1 }),
		)
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("max_completion_tokens", 1)
	})
})
