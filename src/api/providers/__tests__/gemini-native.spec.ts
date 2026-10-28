import type { Anthropic } from "@anthropic-ai/sdk"
import { FunctionCallingConfigMode, ThinkingLevel, type GenerateContentParameters } from "@google/genai"

import { ApiStreamDeadlineError, type ApiStream, type ApiStreamChunk } from "../../transform/stream"
import { GeminiHandler } from "../gemini-native"
import i18next from "../../../i18n"
import commonTranslations from "../../../i18n/locales/en/common.json"

const { generateContent, generateContentStream, constructor } = vi.hoisted(() => ({
	generateContent: vi.fn(),
	generateContentStream: vi.fn(),
	constructor: vi.fn(),
}))

vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@google/genai")>()),
	GoogleGenAI: vi.fn(function (options) {
		constructor(options)
		return { models: { generateContent, generateContentStream } }
	}),
}))

const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Inspect the project" }]
const metadata = { taskId: "gemini-task", requestId: "gemini-request", attemptId: "gemini-attempt" }

async function* fixtureStream<T>(chunks: readonly T[]) {
	yield* chunks
}

async function collect(stream: ApiStream): Promise<ApiStreamChunk[]> {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

function response(parts: unknown[], finishReason = "STOP") {
	return { candidates: [{ content: { parts }, finishReason }] }
}

describe("native Gemini provider", () => {
	beforeAll(() => {
		i18next.addResourceBundle("en", "common", commonTranslations, true, true)
	})

	beforeEach(() => {
		vi.clearAllMocks()
		generateContentStream.mockResolvedValue(fixtureStream([response([{ text: "Done" }])]))
	})

	it("pins direct API-key authentication independently of Vertex profile fields", async () => {
		const handler = new GeminiHandler({
			geminiApiKey: " native-key ",
			vertexProjectId: "unused-project",
			vertexJsonCredentials: "invalid-vertex-json",
			vertexGatewayBaseUrl: "https://unrelated.example",
			vertexStreamingEnabled: false,
			openAiApiKey: "unrelated-key",
		})
		await collect(handler.createMessage("System", messages, metadata))
		expect(constructor).toHaveBeenCalledExactlyOnceWith({
			apiKey: "native-key",
			vertexai: false,
			httpOptions: { baseUrl: "https://generativelanguage.googleapis.com", apiVersion: "v1beta" },
		})
		expect(generateContentStream).toHaveBeenCalledOnce()
		expect(generateContent).not.toHaveBeenCalled()
	})

	it.each([undefined, "", " "])("rejects a missing native credential (%s)", (geminiApiKey) => {
		expect(() => new GeminiHandler({ geminiApiKey, openAiApiKey: "wrong-provider" })).toThrow(/API key is required/)
		expect(constructor).not.toHaveBeenCalled()
	})

	it.each(["gemini-unknown", "__proto__", ""])(
		"rejects unsupported model %s before constructing a client",
		(apiModelId) => {
			expect(() => new GeminiHandler({ geminiApiKey: "key", apiModelId })).toThrow(/Unsupported Gemini model/)
			expect(constructor).not.toHaveBeenCalled()
		},
	)

	it("rejects the retired Gemini 3.8 Flash model before constructing a client", () => {
		expect(() => new GeminiHandler({ geminiApiKey: "key", apiModelId: "gemini-3.8-flash" })).toThrow(
			"Unsupported Gemini model: gemini-3.8-flash",
		)
		expect(constructor).not.toHaveBeenCalled()
		expect(generateContent).not.toHaveBeenCalled()
		expect(generateContentStream).not.toHaveBeenCalled()
	})

	it("rejects a retained nondefault endpoint", () => {
		expect(
			() => new GeminiHandler({ geminiApiKey: "key", googleGeminiBaseUrl: "https://unrelated.example" }),
		).toThrow(/official Google API endpoint/)
		expect(constructor).not.toHaveBeenCalled()
	})

	it("uses the verified Argon model and reasoning default", () => {
		const model = new GeminiHandler({ geminiApiKey: "key" }).getModel()
		expect(model.id).toBe("gemini-4-argon")
		expect(model.reasoning).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM, includeThoughts: true })
		expect(model.info.supportsReasoningEffort).toEqual(["low", "medium", "high"])
		expect(model.info.contextWindow).toBe(1_048_576)
		expect(model.info.maxTokens).toBe(65_536)
		expect(model.info.requiredReasoningEffort).toBe(true)
		expect(model.info.contextWindowIncludesOutput).toBe(true)
	})

	it("translates the shared reasoning choice and ignores stale budget/sampling settings", async () => {
		const handler = new GeminiHandler({
			geminiApiKey: "key",
			apiModelId: "gemini-4-argon",
			reasoningEffort: "high",
			modelTemperature: 0.5,
			modelMaxThinkingTokens: 1024,
			includeMaxTokens: true,
			modelMaxTokens: 8192,
		})
		await collect(handler.createMessage("System", messages, metadata))
		const request: GenerateContentParameters = generateContentStream.mock.calls[0]![0]
		expect(request).toMatchObject({
			model: "gemini-4-argon",
			config: {
				thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH, includeThoughts: true },
				maxOutputTokens: 8192,
			},
		})
		expect(request.config).not.toHaveProperty("temperature")
		expect(request.config?.thinkingConfig).not.toHaveProperty("thinkingBudget")
	})

	it("rejects enabled output caps that require an unimplemented long-decode continuation", () => {
		const handler = new GeminiHandler({ geminiApiKey: "key", includeMaxTokens: true, modelMaxTokens: 65_537 })
		expect(() => handler.getModel()).toThrow(/model maximum/)
	})

	it("omits empty tool declarations on a request without tools", async () => {
		await collect(new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, metadata))
		const request: GenerateContentParameters = generateContentStream.mock.calls[0]![0]
		expect(request.config).not.toHaveProperty("tools")
	})

	it.each([{ allowedFunctionNames: [] }, { allowedFunctionNames: ["read_file"], tool_choice: "none" as const }])(
		"keeps an explicitly noncallable tool request disabled (%j)",
		async (restriction) => {
			await collect(
				new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, {
					...metadata,
					...restriction,
				}),
			)
			const request: GenerateContentParameters = generateContentStream.mock.calls[0]![0]
			expect(request.config?.toolConfig).toEqual({
				functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
			})
		},
	)

	it("retains historical schemas while restricting the callable function names", async () => {
		await collect(
			new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, {
				...metadata,
				allowedFunctionNames: ["read_file"],
				tools: [
					{ type: "function", function: { name: "read_file", parameters: { type: "object" } } },
					{ type: "function", function: { name: "write_to_file", parameters: { type: "object" } } },
				],
			}),
		)
		const request: GenerateContentParameters = generateContentStream.mock.calls[0]![0]
		expect(request.config?.tools).toEqual([
			{
				functionDeclarations: [
					{ name: "read_file", parametersJsonSchema: { type: "object" } },
					{ name: "write_to_file", parametersJsonSchema: { type: "object" } },
				],
			},
		])
		expect(request.config?.toolConfig).toEqual({
			functionCallingConfig: { mode: FunctionCallingConfigMode.VALIDATED, allowedFunctionNames: ["read_file"] },
		})
	})

	it("preserves signed original parts alongside ordered visible reasoning and tool output", async () => {
		const first = { thought: true, text: "Inspect first", thoughtSignature: "thought-signature" }
		const call = {
			functionCall: { name: "read_file", args: { path: "main.ts" } },
			thoughtSignature: "call-signature",
		}
		const signatureOnly = { text: "", thoughtSignature: "trailing-signature" }
		generateContentStream.mockResolvedValue(
			fixtureStream([
				{ candidates: [{ content: { parts: [first, { text: "Checking" }, call] } }] },
				{
					...response([signatureOnly]),
					usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
				},
			]),
		)
		const chunks = await collect(
			new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, metadata),
		)
		expect(chunks.filter((chunk) => chunk.type === "reasoning" && chunk.text)).toEqual([
			{ type: "reasoning", text: "Inspect first" },
		])
		expect(chunks).toContainEqual({ type: "text", text: "Checking" })
		expect(chunks).toContainEqual(expect.objectContaining({ type: "tool_call_end", id: "read_file-0" }))
		expect(chunks).toContainEqual(expect.objectContaining({ type: "usage", outputTokens: 5, reasoningTokens: 2 }))
		const replay = chunks.find((chunk) => chunk.type === "reasoning" && chunk.geminiResponse !== undefined)
		expect(replay).toEqual({
			type: "reasoning",
			text: "",
			geminiResponse: { modelId: "gemini-4-argon", parts: [first, { text: "Checking" }, call, signatureOnly] },
		})
		first.text = "External mutation"
		expect(replay && replay.type === "reasoning" && replay.geminiResponse?.parts[0]?.text).toBe("Inspect first")
		expect(chunks.at(-1)).toMatchObject({ type: "outcome", status: "completed", terminal: true })
	})

	it("normalizes an argument-free Google function call into an empty canonical object", async () => {
		generateContentStream.mockResolvedValue(
			fixtureStream([response([{ functionCall: { name: "list_tools" }, thoughtSignature: "signature" }])]),
		)
		const chunks = await collect(
			new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, metadata),
		)
		expect(chunks).toContainEqual(expect.objectContaining({ type: "tool_call_partial", arguments: "{}" }))
	})

	it("rejects a native function call missing its required thought signature before acceptance", async () => {
		generateContentStream.mockResolvedValue(fixtureStream([response([{ functionCall: { name: "list_tools" } }])]))
		await expect(
			collect(new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, metadata)),
		).rejects.toThrow(/without its thought signature/)
	})

	it.each(["MAX_TOKENS", "SAFETY"])("keeps the %s outcome incomplete", async (finishReason) => {
		generateContentStream.mockResolvedValue(fixtureStream([response([{ text: "Partial" }], finishReason)]))
		const chunks = await collect(
			new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, metadata),
		)
		expect(chunks.at(-1)).toMatchObject({ type: "outcome", status: "incomplete", terminal: true })
	})

	it("does not treat an EOF without a finish reason as successful completion", async () => {
		generateContentStream.mockResolvedValue(
			fixtureStream([{ candidates: [{ content: { parts: [{ text: "Partial" }] } }] }]),
		)
		const chunks = await collect(
			new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, metadata),
		)
		expect(chunks.at(-1)).toMatchObject({ type: "outcome", status: "incomplete", terminal: false })
	})

	it("does not promote a thought-only STOP response into a successful final answer", async () => {
		generateContentStream.mockResolvedValue(
			fixtureStream([response([{ thought: true, text: "Still considering", thoughtSignature: "signature" }])]),
		)
		const chunks = await collect(
			new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, metadata),
		)
		expect(chunks.at(-1)).toMatchObject({
			type: "outcome",
			status: "incomplete",
			terminal: true,
			reason: expect.stringMatching(/without visible content/),
		})
	})

	it("cancels a blocked stream and closes the iterator without publishing replay state", async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => (markStarted = resolve))
		const next = vi.fn(() => new Promise<IteratorResult<never>>(() => markStarted()))
		const close = vi.fn().mockResolvedValue({ done: true, value: undefined })
		generateContentStream.mockResolvedValue({ [Symbol.asyncIterator]: () => ({ next, return: close }) })
		const controller = new AbortController()
		const collecting = collect(
			new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, {
				...metadata,
				signal: controller.signal,
			}),
		)
		const rejected = expect(collecting).rejects.toMatchObject({ name: "AbortError" })
		await started
		controller.abort()
		await rejected
		expect(close).toHaveBeenCalledOnce()
		const request: GenerateContentParameters = generateContentStream.mock.calls[0]![0]
		expect(request.config?.abortSignal?.aborted).toBe(true)
	})

	it("seals the accepted tool's signed prefix atomically and stops before a later parallel part on cancellation", async () => {
		const first = { functionCall: { name: "read_file", args: { path: "one.ts" } }, thoughtSignature: "signature" }
		const second = { functionCall: { name: "read_file", args: { path: "two.ts" } } }
		generateContentStream.mockResolvedValue(fixtureStream([response([first, second])]))
		const controller = new AbortController()
		const chunks: ApiStreamChunk[] = []
		const consuming = async () => {
			for await (const chunk of new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, {
				...metadata,
				signal: controller.signal,
			})) {
				chunks.push(chunk)
				if (chunk.type === "tool_call_end") controller.abort()
			}
		}
		await expect(consuming()).rejects.toMatchObject({ name: "AbortError" })
		expect(chunks.find((chunk) => chunk.type === "tool_call_end")).toEqual({
			type: "tool_call_end",
			id: "read_file-0",
			geminiResponse: { modelId: "gemini-4-argon", parts: [first] },
		})
		expect(chunks.some((chunk) => chunk.type === "tool_call_partial" && chunk.id === "read_file-1")).toBe(false)
		expect(chunks.some((chunk) => chunk.type === "outcome")).toBe(false)
	})

	it("rejects an expired request deadline before dispatch", async () => {
		await expect(
			collect(
				new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, {
					...metadata,
					deadline: Date.now() - 1,
				}),
			),
		).rejects.toBeInstanceOf(ApiStreamDeadlineError)
		expect(generateContentStream).not.toHaveBeenCalled()
	})

	it("does not accept a function call cancelled while its partial payload is being delivered", async () => {
		generateContentStream.mockResolvedValue(
			fixtureStream([response([{ functionCall: { name: "list_tools" }, thoughtSignature: "signature" }])]),
		)
		const controller = new AbortController()
		const chunks: ApiStreamChunk[] = []
		const consuming = async () => {
			for await (const chunk of new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, {
				...metadata,
				signal: controller.signal,
			})) {
				chunks.push(chunk)
				if (chunk.type === "tool_call_partial") controller.abort()
			}
		}
		await expect(consuming()).rejects.toMatchObject({ name: "AbortError" })
		expect(chunks.some((chunk) => chunk.type === "tool_call_end")).toBe(false)
		expect(chunks.some((chunk) => chunk.type === "reasoning" && chunk.geminiResponse)).toBe(false)
	})

	it("does not publish successful completion after cancellation at the final replay boundary", async () => {
		const controller = new AbortController()
		const chunks: ApiStreamChunk[] = []
		const consuming = async () => {
			for await (const chunk of new GeminiHandler({ geminiApiKey: "key" }).createMessage("System", messages, {
				...metadata,
				signal: controller.signal,
			})) {
				chunks.push(chunk)
				if (chunk.type === "reasoning" && chunk.geminiResponse) controller.abort()
			}
		}
		await expect(consuming()).rejects.toMatchObject({ name: "AbortError" })
		expect(chunks.some((chunk) => chunk.type === "outcome")).toBe(false)
	})

	it.each(["MAX_TOKENS", "SAFETY", undefined])(
		"rejects an incomplete auxiliary response (%s)",
		async (finishReason) => {
			generateContent.mockResolvedValue({ text: "Partial", candidates: [{ finishReason }] })
			await expect(new GeminiHandler({ geminiApiKey: "key" }).completePrompt("Enhance")).rejects.toThrow(
				/did not finish successfully/,
			)
		},
	)

	it("uses shared reasoning on auxiliary completions and caps Argon's synchronous output", async () => {
		generateContent.mockResolvedValue({ text: "Enhanced", candidates: [{ finishReason: "STOP" }] })
		const handler = new GeminiHandler({
			geminiApiKey: "key",
			reasoningEffort: "low",
			includeMaxTokens: true,
			modelMaxTokens: 65_536,
		})
		await expect(handler.completePrompt("Enhance")).resolves.toBe("Enhanced")
		expect(generateContent).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "gemini-4-argon",
				config: expect.objectContaining({
					maxOutputTokens: 32_768,
					thinkingConfig: { thinkingLevel: ThinkingLevel.LOW, includeThoughts: true },
				}),
			}),
		)
	})
})
