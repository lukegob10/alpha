import { type ModelInfo, vertexModels } from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"
import { AnthropicVertexHandler } from "../anthropic-vertex"
import { VertexHandler } from "../vertex"

const mocks = vi.hoisted(() => ({
	geminiStream: vi.fn(),
	geminiResponse: vi.fn(),
	claudeCreate: vi.fn(),
}))

vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@google/genai")>()),
	GoogleGenAI: vi.fn(function () {
		return {
			models: { generateContentStream: mocks.geminiStream, generateContent: mocks.geminiResponse },
		}
	}),
}))
vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(function () {
		return { messages: { create: mocks.claudeCreate } }
	}),
}))

beforeEach(() => {
	vi.clearAllMocks()
	const geminiResponse = {
		text: "answer",
		candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
	}
	mocks.geminiResponse.mockResolvedValue(geminiResponse)
	mocks.geminiStream.mockResolvedValue({
		async *[Symbol.asyncIterator]() {
			yield geminiResponse
		},
	})
	mocks.claudeCreate.mockImplementation(async ({ stream }: { stream?: boolean }) => {
		if (!stream) {
			return {
				id: "message-id",
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
			}
		}
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } }
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } }
				yield { type: "content_block_stop", index: 0 }
				yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }
				yield { type: "message_stop" }
			},
		}
	})
})

const options: ApiHandlerOptions = {
	vertexProjectId: "fixture-project",
	vertexRegion: "global",
	modelTemperature: 0.4,
	verbosity: "high",
}

const surfaces = ["stream", "response", "single-prompt"] as const

async function runClaude(handler: AnthropicVertexHandler, surface: (typeof surfaces)[number]): Promise<void> {
	if (surface === "single-prompt") {
		await handler.completePrompt("hello")
		return
	}
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
		// Consume the task request path.
	}
}

async function runGemini(handler: VertexHandler, surface: (typeof surfaces)[number]): Promise<void> {
	if (surface === "single-prompt") {
		await handler.completePrompt("hello")
		return
	}
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
		// Consume the native task request path.
	}
}

function budgetGemini(overrides: ApiHandlerOptions): VertexHandler {
	const handler = new VertexHandler({ ...options, apiModelId: "gemini-3.5-flash", ...overrides })
	const model = handler.getModel()
	vi.spyOn(handler, "getModel").mockReturnValue({
		...model,
		info: { ...model.info, supportsReasoningBudget: true },
		maxTokens: 16_384,
		reasoning: { thinkingBudget: 2048, includeThoughts: true },
	})
	return handler
}

describe.each(surfaces)("Vertex request parameters on %s", (surface) => {
	it.each([
		{ modelId: "gemini-3.5-flash", temperature: 0.4 },
		{ modelId: "gemini-3.7-flash", temperature: undefined },
		{ modelId: "gemini-future-preview", temperature: undefined },
	])("Gemini $modelId emits only supported parameters", async ({ modelId, temperature }) => {
		const handler = new VertexHandler({
			...options,
			apiModelId: modelId,
			vertexStreamingEnabled: surface === "stream",
		})
		if (surface === "single-prompt") {
			expect(await handler.completePrompt("hello")).toBe("answer")
		} else {
			for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
				// Consume the real adapter boundary.
			}
		}
		const create = surface === "stream" ? mocks.geminiStream : mocks.geminiResponse
		const [{ config }] = create.mock.calls[0]
		if (temperature === undefined) {
			expect(config).not.toHaveProperty("temperature")
		} else {
			expect(config).toHaveProperty("temperature", temperature)
		}
		expect(config).not.toHaveProperty("verbosity")
	})

	it.each([
		{ modelId: "claude-sonnet-4-6", temperature: 0.4 },
		{ modelId: "claude-sonnet-5", temperature: undefined },
		{ modelId: "claude-future-preview", temperature: undefined },
	])("Claude $modelId emits only supported parameters", async ({ modelId, temperature }) => {
		const handler = new AnthropicVertexHandler({
			...options,
			apiModelId: modelId,
			vertexStreamingEnabled: surface === "stream",
		})
		if (surface === "single-prompt") {
			expect(await handler.completePrompt("hello")).toBe("answer")
		} else {
			for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
				// Consume the real adapter boundary.
			}
		}
		const [request] = mocks.claudeCreate.mock.calls[0]
		if (temperature === undefined) {
			expect(request).not.toHaveProperty("temperature")
		} else {
			expect(request).toHaveProperty("temperature", temperature)
		}
		expect(request).not.toHaveProperty("verbosity")
	})

	it.each([false, undefined])(
		"Gemini omits sampling for descriptor support=%s even with a model default",
		async (support) => {
			const handler = new VertexHandler({
				...options,
				apiModelId: "gemini-future-preview",
				vertexStreamingEnabled: surface === "stream",
			})
			const model = handler.getModel()
			const info: ModelInfo = { ...model.info, supportsTemperature: support, defaultTemperature: 0.7 }
			vi.spyOn(handler, "getModel").mockReturnValue({ ...model, info })
			if (surface === "single-prompt") {
				await handler.completePrompt("hello")
			} else {
				for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
					// The adapter must obey the model descriptor rather than infer from its ID.
				}
			}
			const create = surface === "stream" ? mocks.geminiStream : mocks.geminiResponse
			expect(create.mock.calls[0][0].config).not.toHaveProperty("temperature")
		},
	)

	it("keeps unknown Gemini sampling unavailable when the fallback catalog advertises it", async () => {
		const fallbackInfo: ModelInfo = vertexModels["gemini-3.7-flash"]
		const originalTemperature = fallbackInfo.supportsTemperature
		const originalParameters = fallbackInfo.supportedParameters
		const hadParameters = Object.hasOwn(fallbackInfo, "supportedParameters")
		try {
			fallbackInfo.supportsTemperature = true
			fallbackInfo.supportedParameters = ["temperature"]
			await runGemini(
				new VertexHandler({
					...options,
					apiModelId: "gemini-future-preview",
					vertexStreamingEnabled: surface === "stream",
					modelTemperature: 0.8,
				}),
				surface,
			)
			const create = surface === "stream" ? mocks.geminiStream : mocks.geminiResponse
			expect(create.mock.calls[0][0].config).not.toHaveProperty("temperature")
			await runGemini(
				new VertexHandler({
					...options,
					apiModelId: "gemini-3.7-flash",
					vertexStreamingEnabled: surface === "stream",
					modelTemperature: 0.8,
				}),
				surface,
			)
			expect(create.mock.calls[1][0].config).toHaveProperty("temperature", 0.8)
		} finally {
			fallbackInfo.supportsTemperature = originalTemperature
			if (hadParameters) {
				fallbackInfo.supportedParameters = originalParameters
			} else {
				delete fallbackInfo.supportedParameters
			}
		}
	})

	it.each([
		{ cap: undefined, expected: 16_384 },
		{ cap: -1, expected: 16_384 },
		{ cap: 4096, expected: 4096 },
	])("Gemini budget cap $cap uses the same validated native output limit", async ({ cap, expected }) => {
		await runGemini(budgetGemini({ vertexStreamingEnabled: surface === "stream", modelMaxTokens: cap }), surface)
		const create = surface === "stream" ? mocks.geminiStream : mocks.geminiResponse
		expect(create.mock.calls[0][0].config).toHaveProperty("maxOutputTokens", expected)
	})

	it.each([0, -2, 1.5, Number.POSITIVE_INFINITY])(
		"Gemini rejects invalid applicable budget cap %s before transport",
		async (cap) => {
			await expect(
				runGemini(budgetGemini({ vertexStreamingEnabled: surface === "stream", modelMaxTokens: cap }), surface),
			).rejects.toThrow(/output|token/i)
			expect(mocks.geminiStream).not.toHaveBeenCalled()
			expect(mocks.geminiResponse).not.toHaveBeenCalled()
		},
	)

	it.each([-1, 0, 4096])("Gemini effort-only models ignore the stale budget cap %s", async (cap) => {
		const handler = new VertexHandler({
			...options,
			apiModelId: "gemini-3.5-flash",
			vertexStreamingEnabled: surface === "stream",
			modelMaxTokens: cap,
		})
		const expected = handler.getModel().maxTokens
		await runGemini(handler, surface)
		const create = surface === "stream" ? mocks.geminiStream : mocks.geminiResponse
		expect(create.mock.calls[0][0].config).toHaveProperty("maxOutputTokens", expected)
	})

	it.each([true, false, undefined])(
		"Claude budget sentinel uses a native mandatory cap with includeMaxTokens=%s",
		async (include) => {
			await runClaude(
				new AnthropicVertexHandler({
					...options,
					apiModelId: "claude-sonnet-4-6",
					vertexStreamingEnabled: surface === "stream",
					enableReasoningEffort: true,
					modelMaxThinkingTokens: 2048,
					modelMaxTokens: -1,
					includeMaxTokens: include,
				}),
				surface,
			)
			expect(mocks.claudeCreate.mock.calls[0][0]).toMatchObject({
				max_tokens: 16_384,
				temperature: 1,
				thinking: { type: "enabled", budget_tokens: 2048 },
			})
		},
	)

	it.each([0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"Claude rejects invalid applicable budget cap %s before transport",
		async (cap) => {
			await expect(
				runClaude(
					new AnthropicVertexHandler({
						...options,
						apiModelId: "claude-sonnet-4-6",
						vertexStreamingEnabled: surface === "stream",
						enableReasoningEffort: true,
						modelMaxTokens: cap,
					}),
					surface,
				),
			).rejects.toThrow(/output|token/i)
			expect(mocks.claudeCreate).not.toHaveBeenCalled()
		},
	)

	it("rejects a Claude cap equal to the minimum thinking budget", async () => {
		await expect(
			runClaude(
				new AnthropicVertexHandler({
					...options,
					apiModelId: "claude-sonnet-4-6",
					vertexStreamingEnabled: surface === "stream",
					enableReasoningEffort: true,
					modelMaxTokens: 1024,
				}),
				surface,
			),
		).rejects.toThrow(/exceed.*thinking/i)
		expect(mocks.claudeCreate).not.toHaveBeenCalled()
	})

	it("accepts a Claude cap greater than the minimum thinking budget", async () => {
		await runClaude(
			new AnthropicVertexHandler({
				...options,
				apiModelId: "claude-sonnet-4-6",
				vertexStreamingEnabled: surface === "stream",
				enableReasoningEffort: true,
				modelMaxTokens: 1025,
			}),
			surface,
		)
		expect(mocks.claudeCreate.mock.calls[0][0]).toMatchObject({
			max_tokens: 1025,
			thinking: { type: "enabled", budget_tokens: 1024 },
		})
	})

	it("keeps a positive native response cap valid when thinking is absent", async () => {
		const handler = new AnthropicVertexHandler({
			...options,
			apiModelId: "claude-sonnet-4-6",
			vertexStreamingEnabled: surface === "stream",
		})
		const model = handler.getModel()
		vi.spyOn(handler, "getModel").mockReturnValue({ ...model, maxTokens: 1 })
		await runClaude(handler, surface)
		expect(mocks.claudeCreate.mock.calls[0][0]).toHaveProperty("max_tokens", 1)
		expect(mocks.claudeCreate.mock.calls[0][0].thinking).toBeUndefined()
	})
})

it("preserves the fixed native temperature for enabled Claude budget reasoning", async () => {
	const handler = new AnthropicVertexHandler({
		...options,
		apiModelId: "claude-sonnet-4-6",
		enableReasoningEffort: true,
		modelMaxThinkingTokens: 2048,
	})
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
		// Editable sampling is superseded by the native thinking contract.
	}
	expect(mocks.claudeCreate.mock.calls[0][0]).toMatchObject({
		temperature: 1,
		thinking: { type: "enabled", budget_tokens: 2048 },
	})
})
