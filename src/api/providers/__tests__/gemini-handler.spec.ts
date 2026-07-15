import { t } from "i18next"
import { FunctionCallingConfigMode } from "@google/genai"

import { GeminiHandler } from "../gemini"
import type { ApiHandlerOptions } from "../../../shared/api"
import { collectAgentResponse } from "../../../core/agent/AgentResponseAccumulator"

describe("GeminiHandler backend support", () => {
	it("createMessage uses function declarations (URL context and grounding are only for completePrompt)", async () => {
		// URL context and grounding are mutually exclusive with function declarations
		// in Gemini API, so createMessage only uses function declarations.
		// URL context/grounding are only added in completePrompt.
		const options = {
			apiProvider: "gemini",
			enableUrlContext: true,
			enableGrounding: true,
		} as ApiHandlerOptions
		const handler = new GeminiHandler(options)
		const stub = vi.fn().mockReturnValue((async function* () {})())
		// @ts-ignore access private client
		handler["client"].models.generateContentStream = stub
		await handler.createMessage("instr", [] as any).next()
		const config = stub.mock.calls[0][0].config
		// createMessage always uses function declarations only
		// (tools are always present from ALWAYS_AVAILABLE_TOOLS)
		expect(config.tools).toEqual([{ functionDeclarations: expect.any(Array) }])
	})

	it("completePrompt passes config overrides without tools when URL context and grounding disabled", async () => {
		const options = {
			apiProvider: "gemini",
			enableUrlContext: false,
			enableGrounding: false,
		} as ApiHandlerOptions
		const handler = new GeminiHandler(options)
		const stub = vi.fn().mockResolvedValue({ text: "ok" })
		// @ts-ignore access private client
		handler["client"].models.generateContent = stub
		const res = await handler.completePrompt("hi")
		expect(res).toBe("ok")
		const promptConfig = stub.mock.calls[0][0].config
		expect(promptConfig.tools).toBeUndefined()
	})

	describe("error scenarios", () => {
		it("should handle grounding metadata extraction failure gracefully", async () => {
			const options = {
				apiProvider: "gemini",
				enableGrounding: true,
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)

			const mockStream = async function* () {
				yield {
					candidates: [
						{
							groundingMetadata: {
								// Invalid structure - missing groundingChunks
							},
							content: { parts: [{ text: "test response" }] },
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
				}
			}

			const stub = vi.fn().mockReturnValue(mockStream())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			const messages = []
			for await (const chunk of handler.createMessage("test", [] as any)) {
				messages.push(chunk)
			}

			// Should still return the main content without sources
			expect(messages.some((m) => m.type === "text" && m.text === "test response")).toBe(true)
			expect(messages.some((m) => m.type === "text" && m.text?.includes("Sources:"))).toBe(false)
		})

		it("should handle malformed grounding metadata", async () => {
			const options = {
				apiProvider: "gemini",
				enableGrounding: true,
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)

			const mockStream = async function* () {
				yield {
					candidates: [
						{
							groundingMetadata: {
								groundingChunks: [
									{ web: null }, // Missing URI
									{ web: { uri: "https://example.com", title: "Example Site" } }, // Valid
									{}, // Missing web property entirely
								],
							},
							content: { parts: [{ text: "test response" }] },
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
				}
			}

			const stub = vi.fn().mockReturnValue(mockStream())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			const messages = []
			for await (const chunk of handler.createMessage("test", [] as any)) {
				messages.push(chunk)
			}

			// Should have the text response
			const textMessage = messages.find((m) => m.type === "text")
			expect(textMessage).toBeDefined()
			if (textMessage && "text" in textMessage) {
				expect(textMessage.text).toBe("test response")
			}

			// Should have grounding chunk with only valid sources
			const groundingMessage = messages.find((m) => m.type === "grounding")
			expect(groundingMessage).toBeDefined()
			if (groundingMessage && "sources" in groundingMessage) {
				expect(groundingMessage.sources).toHaveLength(1)
				expect(groundingMessage.sources[0].url).toBe("https://example.com")
				expect(groundingMessage.sources[0].title).toBe("Example Site")
			}
		})

		it("feeds Gemini reasoning, tool calls, and grounding through the shared response model", async () => {
			const handler = new GeminiHandler({ apiProvider: "gemini", enableGrounding: true } as ApiHandlerOptions)
			const mockStream = async function* () {
				yield {
					candidates: [
						{
							content: {
								parts: [{ thought: true, text: "I will inspect the repository." }],
							},
							groundingMetadata: {
								groundingChunks: [{ web: { uri: "https://example.com/repo", title: "Repository" } }],
							},
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
				}
				yield {
					candidates: [
						{
							finishReason: "STOP",
							content: {
								parts: [
									{
										functionCall: {
											id: "gemini-call-1",
											name: "read_file",
											args: { path: "README.md" },
										},
									},
								],
							},
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
				}
			}

			const stub = vi.fn().mockReturnValue(mockStream())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			const chunks = []
			for await (const chunk of handler.createMessage("test", [] as any, { taskId: "test-task" })) {
				chunks.push(chunk)
			}
			const normalized = await collectAgentResponse(
				(async function* () {
					for (const chunk of chunks) {
						yield chunk
					}
				})(),
			)

			expect(normalized.reasoning).toBe("I will inspect the repository.")
			expect(normalized.toolCalls).toEqual([
				{
					type: "tool_call",
					id: "gemini-call-1",
					name: "read_file",
					arguments: { path: "README.md" },
				},
			])
			expect(normalized.items).toContainEqual({
				type: "grounding",
				sources: [{ title: "Repository", url: "https://example.com/repo" }],
			})
		})

		it("should handle API errors when tools are enabled", async () => {
			const options = {
				apiProvider: "gemini",
				enableUrlContext: true,
				enableGrounding: true,
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)

			const mockError = new Error("API rate limit exceeded")
			const stub = vi.fn().mockRejectedValue(mockError)
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await expect(async () => {
				const generator = handler.createMessage("test", [] as any)
				await generator.next()
			}).rejects.toThrow(t("common:errors.gemini.generate_stream", { error: "API rate limit exceeded" }))
		})
	})

	describe("allowedFunctionNames support", () => {
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function" as const,
				function: {
					name: "write_to_file",
					description: "Write to a file",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function" as const,
				function: {
					name: "execute_command",
					description: "Execute a command",
					parameters: { type: "object", properties: {} },
				},
			},
		]

		it("should pass allowedFunctionNames to toolConfig when provided", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
					allowedFunctionNames: ["read_file", "write_to_file"],
				})
				.next()

			const config = stub.mock.calls[0][0].config
			expect(config.toolConfig).toEqual({
				functionCallingConfig: {
					mode: FunctionCallingConfigMode.VALIDATED,
					allowedFunctionNames: ["read_file", "write_to_file"],
				},
			})
		})

		it("should include all tools but restrict callable functions via allowedFunctionNames", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
					allowedFunctionNames: ["read_file"],
				})
				.next()

			const config = stub.mock.calls[0][0].config
			// All tools should be passed to the model
			expect(config.tools[0].functionDeclarations).toHaveLength(3)
			// But only read_file should be allowed to be called
			expect(config.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["read_file"])
		})

		it("should take precedence over tool_choice when allowedFunctionNames is provided", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
					tool_choice: "auto",
					allowedFunctionNames: ["read_file"],
				})
				.next()

			const config = stub.mock.calls[0][0].config
			// allowedFunctionNames should take precedence - mode should be VALIDATED, not AUTO
			expect(config.toolConfig.functionCallingConfig.mode).toBe(FunctionCallingConfigMode.VALIDATED)
			expect(config.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["read_file"])
		})

		it("should fall back to tool_choice when allowedFunctionNames is empty", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
					tool_choice: "auto",
					allowedFunctionNames: [],
				})
				.next()

			const config = stub.mock.calls[0][0].config
			// Empty allowedFunctionNames should fall back to tool_choice behavior
			expect(config.toolConfig.functionCallingConfig.mode).toBe(FunctionCallingConfigMode.AUTO)
			expect(config.toolConfig.functionCallingConfig.allowedFunctionNames).toBeUndefined()
		})

		it("should not set toolConfig when allowedFunctionNames is undefined and no tool_choice", async () => {
			const options = {
				apiProvider: "gemini",
			} as ApiHandlerOptions
			const handler = new GeminiHandler(options)
			const stub = vi.fn().mockReturnValue((async function* () {})())
			// @ts-ignore access private client
			handler["client"].models.generateContentStream = stub

			await handler
				.createMessage("test", [] as any, {
					taskId: "test-task",
					tools: testTools,
				})
				.next()

			const config = stub.mock.calls[0][0].config
			// No toolConfig should be set when neither allowedFunctionNames nor tool_choice is provided
			expect(config.toolConfig).toBeUndefined()
		})
	})
})
