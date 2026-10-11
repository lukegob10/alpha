import type { ModelInfo } from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"
import { OpenAiHandler } from "../openai"

const mocks = vi.hoisted(() => ({
	chatCreate: vi.fn(),
	responsesCreate: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn(() => ({
		chat: { completions: { create: mocks.chatCreate } },
		responses: { create: mocks.responsesCreate },
	})),
	AzureOpenAI: vi.fn(() => ({
		chat: { completions: { create: mocks.chatCreate } },
		responses: { create: mocks.responsesCreate },
	})),
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

	it("uses the native Responses transport with verbosity and a positive cap for a single prompt", async () => {
		const result = await createHandler({
			openAiModelId: "gpt-5.5",
			openAiBaseUrl: "https://api.openai.com/v1",
			modelTemperature: 0.8,
			verbosity: "medium",
			includeMaxTokens: true,
			modelMaxTokens: 4096,
			openAiCustomModelInfo: modelInfo({ supportsTemperature: true, supportsVerbosity: true }),
		}).completePrompt("hello")
		expect(result).toBe("answer")
		expect(mocks.chatCreate).not.toHaveBeenCalled()
		expect(mocks.responsesCreate.mock.calls[0][0]).toMatchObject({
			model: "gpt-5.5",
			input: [{ role: "user", content: "hello" }],
			stream: false,
			store: false,
			max_output_tokens: 4096,
			text: { verbosity: "medium" },
		})
		expect(mocks.responsesCreate.mock.calls[0][0]).not.toHaveProperty("temperature")
	})

	it.each([
		{
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
			expected: /status: incomplete; reason: max_output_tokens/,
		},
		{
			status: "failed",
			error: { code: "server_error", message: "private provider error content" },
			expected: /status: failed; code: server_error/,
		},
		{ status: "in_progress", expected: /status: in_progress/ },
		{ status: undefined, expected: /status: unknown/ },
	])(
		"rejects a native single prompt response with status $status without changing saved parameters",
		async (outcome) => {
			const savedOptions: ApiHandlerOptions = {
				openAiModelId: "gpt-5.5",
				openAiBaseUrl: "https://api.openai.com/v1",
				modelTemperature: 0.8,
				verbosity: "high",
				includeMaxTokens: true,
				modelMaxTokens: 4096,
				openAiCustomModelInfo: modelInfo({ supportsVerbosity: true }),
			}
			const savedSnapshot = structuredClone(savedOptions)
			const handler = createHandler(savedOptions)
			const modelBefore = handler.getModel()
			mocks.responsesCreate.mockResolvedValueOnce({
				id: "response-id",
				output_text: "private partial output",
				...outcome,
			})

			const completion = handler.completePrompt("private prompt")
			await expect(completion).rejects.toThrow(outcome.expected)
			const failure = await completion.catch((error: unknown) => error)
			expect(failure).toMatchObject({
				message: expect.not.stringMatching(
					/private provider error content|private partial output|private prompt/,
				),
			})
			expect(mocks.responsesCreate).toHaveBeenCalledTimes(1)
			expect(mocks.chatCreate).not.toHaveBeenCalled()
			expect(handler.getModel()).toEqual(modelBefore)
			expect(savedOptions).toEqual(savedSnapshot)
		},
	)

	it.each(["chat", "responses"])("omits the server-default cap for single prompt %s", async (route) => {
		await createHandler({
			...(route === "responses" ? { openAiModelId: "gpt-5.5", openAiBaseUrl: "https://api.openai.com/v1" } : {}),
			includeMaxTokens: true,
			modelMaxTokens: -1,
		}).completePrompt("hello")
		const create = route === "responses" ? mocks.responsesCreate : mocks.chatCreate
		expect(create).toHaveBeenCalledTimes(1)
		const [request] = create.mock.calls[0]
		expect(request).not.toHaveProperty(route === "responses" ? "max_output_tokens" : "max_completion_tokens")
	})
})

describe.each(["stream", "response", "single-prompt"])("output-cap transport minimum on %s", (surface) => {
	async function run(handler: OpenAiHandler) {
		if (surface === "single-prompt") {
			await handler.completePrompt("hello")
		} else {
			await consumeTask(handler)
		}
	}

	it("rejects native Responses cap 15 before transport", async () => {
		await expect(
			run(
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
		await run(
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
		await run(
			createHandler({ openAiStreamingEnabled: surface === "stream", includeMaxTokens: true, modelMaxTokens: 1 }),
		)
		expect(mocks.chatCreate.mock.calls[0][0]).toHaveProperty("max_completion_tokens", 1)
	})
})
