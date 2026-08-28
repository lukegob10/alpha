import type { Mock } from "vitest"

const { mockGetApiRequestTimeoutSetting, mockCancellationSources } = vi.hoisted(() => ({
	mockGetApiRequestTimeoutSetting: vi.fn(() => 600),
	mockCancellationSources: [] as Array<{
		token: {
			isCancellationRequested: boolean
			onCancellationRequested: ReturnType<typeof vi.fn>
		}
		cancel: ReturnType<typeof vi.fn>
		dispose: ReturnType<typeof vi.fn>
	}>,
}))

// Mocks must come first, before imports
vi.mock("vscode", () => {
	class MockLanguageModelTextPart {
		type = "text"
		constructor(public value: string) {}
	}

	class MockLanguageModelToolCallPart {
		type = "tool_call"
		constructor(
			public callId: string,
			public name: string,
			public input: any,
		) {}
	}

	return {
		workspace: {
			onDidChangeConfiguration: vi.fn((_callback) => ({
				dispose: vi.fn(),
			})),
			getConfiguration: vi.fn(() => ({
				get: mockGetApiRequestTimeoutSetting,
			})),
		},
		CancellationTokenSource: vi.fn(() => {
			const token = {
				isCancellationRequested: false,
				onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
			}
			const source = {
				token,
				cancel: vi.fn(() => {
					token.isCancellationRequested = true
				}),
				dispose: vi.fn(),
			}
			mockCancellationSources.push(source)
			return source
		}),
		CancellationError: class CancellationError extends Error {
			constructor() {
				super("Operation cancelled")
				this.name = "CancellationError"
			}
		},
		LanguageModelChatMessage: {
			Assistant: vi.fn((content) => ({
				role: "assistant",
				content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
			})),
			User: vi.fn((content) => ({
				role: "user",
				content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
			})),
		},
		LanguageModelTextPart: MockLanguageModelTextPart,
		LanguageModelToolCallPart: MockLanguageModelToolCallPart,
		lm: {
			selectChatModels: vi.fn(),
			onDidChangeChatModels: vi.fn((_callback) => ({
				dispose: vi.fn(),
			})),
		},
	}
})

import * as vscode from "vscode"
import { VsCodeLmHandler, getVsCodeLmModels } from "../vscode-lm"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { Anthropic } from "@anthropic-ai/sdk"

const mockLanguageModelChat = {
	id: "test-model",
	name: "Test Model",
	vendor: "test-vendor",
	family: "test-family",
	version: "1.0",
	maxInputTokens: 4096,
	sendRequest: vi.fn(),
	countTokens: vi.fn(),
}

const mockCopilotGpt55LanguageModelChat = {
	...mockLanguageModelChat,
	id: "copilot-gpt-5.5",
	name: "GPT-5.5",
	vendor: "copilot",
	family: "gpt-5.5",
	version: "2026-06-01",
	maxInputTokens: 921_793,
}

const mockCopilotGpt53CodexLanguageModelChat = {
	...mockLanguageModelChat,
	id: "copilot-gpt-5.3-codex",
	name: "GPT-5.3-Codex",
	vendor: "copilot",
	family: "gpt-5.3-codex",
	version: "2026-06-01",
}

const mockCopilotGpt56TerraLanguageModelChat = {
	...mockLanguageModelChat,
	id: "gpt-5.6-terra",
	name: "GPT-5.6 Terra",
	vendor: "copilot",
	family: "gpt-5.6-terra",
	version: "gpt-5.6-terra",
	maxInputTokens: 921_793,
}

describe("VsCodeLmHandler", () => {
	let handler: VsCodeLmHandler
	const defaultOptions: ApiHandlerOptions = {
		vsCodeLmModelSelector: {
			vendor: "test-vendor",
			family: "test-family",
		},
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockCancellationSources.length = 0
		mockGetApiRequestTimeoutSetting.mockReturnValue(600)
		handler = new VsCodeLmHandler(defaultOptions)
	})

	afterEach(() => {
		handler.dispose()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeDefined()
			expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalled()
		})

		it("should handle configuration changes", () => {
			const callback = (vscode.workspace.onDidChangeConfiguration as Mock).mock.calls[0][0]
			callback({ affectsConfiguration: () => true })
			// Should reset client when config changes
			expect(handler["client"]).toBeNull()
		})

		it("should reset client when VS Code chat models change", () => {
			handler["client"] = mockLanguageModelChat as any
			const callback = (vscode.lm.onDidChangeChatModels as Mock).mock.calls[0][0]

			callback()

			expect(handler["client"]).toBeNull()
		})
	})

	describe("createClient", () => {
		it("should create client with selector", async () => {
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([mockModel])

			const client = await handler["createClient"]({
				vendor: "test-vendor",
				family: "test-family",
			})

			expect(client).toBeDefined()
			expect(client.id).toBe("test-model")
			expect(vscode.lm.selectChatModels).toHaveBeenCalledWith({
				vendor: "test-vendor",
				family: "test-family",
			})
		})

		it("should throw a clear error when no models are available", async () => {
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([])

			await expect(handler["createClient"]({})).rejects.toThrow(
				"No VS Code language models are available in this window",
			)
		})

		it("should distinguish an unavailable selection from an unavailable provider", async () => {
			;(vscode.lm.selectChatModels as Mock)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([mockLanguageModelChat])

			await expect(handler["createClient"]({ vendor: "copilot", family: "gpt-5.6-sol" })).rejects.toThrow(
				"The selected VS Code language model is not available in this window",
			)
			expect(vscode.lm.selectChatModels).toHaveBeenNthCalledWith(2, {})
		})
	})

	describe("createMessage", () => {
		beforeEach(() => {
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([mockModel])
			mockLanguageModelChat.countTokens.mockResolvedValue(10)

			// Override the default client with our test client
			handler["client"] = mockLanguageModelChat
		})

		it("should stream text responses", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			const responseText = "Hello! How can I help you?"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart(responseText)
					return
				})(),
				text: (async function* () {
					yield responseText
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2) // Text chunk + usage chunk
			expect(chunks[0]).toEqual({
				type: "text",
				text: responseText,
			})
			expect(chunks[1]).toMatchObject({
				type: "usage",
				inputTokens: expect.any(Number),
				outputTokens: expect.any(Number),
			})
		})

		it("should stream structurally compatible text parts", async () => {
			const responseText = "Structural text part"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield { value: responseText }
				})(),
			})

			const chunks = []
			for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }])) {
				chunks.push(chunk)
			}

			expect(chunks[0]).toEqual({
				type: "text",
				text: responseText,
			})
		})

		it("should stream plain string chunks defensively", async () => {
			const responseText = "Plain text chunk"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield responseText
				})(),
			})

			const chunks = []
			for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }])) {
				chunks.push(chunk)
			}

			expect(chunks[0]).toEqual({
				type: "text",
				text: responseText,
			})
		})

		it("should ignore VS Code LM metadata chunks", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
			const responseText = "Text before metadata"

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart(responseText)
					yield { mimeType: "stateful_marker", data: new Uint8Array() }
					yield { mimeType: "usage", data: new Uint8Array() }
				})(),
			})

			const chunks = []
			for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }])) {
				chunks.push(chunk)
			}

			expect(chunks[0]).toEqual({
				type: "text",
				text: responseText,
			})
			expect(chunks.at(-1)).toMatchObject({
				type: "usage",
				inputTokens: expect.any(Number),
				outputTokens: expect.any(Number),
			})
			expect(warnSpy).not.toHaveBeenCalledWith(
				"Alpha <Language Model API>: Unknown chunk type received:",
				expect.anything(),
			)
			warnSpy.mockRestore()
		})

		it("should emit tool_call chunks when tools are provided", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Calculate 2+2",
				},
			]

			const toolCallData = {
				name: "calculator",
				arguments: { operation: "add", numbers: [2, 2] },
				callId: "call-1",
			}

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelToolCallPart(
						toolCallData.callId,
						toolCallData.name,
						toolCallData.arguments,
					)
					return
				})(),
				text: (async function* () {
					yield JSON.stringify({ type: "tool_call", ...toolCallData })
					return
				})(),
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "calculator",
						description: "A simple calculator",
						parameters: {
							type: "object",
							properties: {
								operation: { type: "string" },
								numbers: { type: "array", items: { type: "number" } },
							},
						},
					},
				},
			]

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				tools,
			})
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2) // Tool call chunk + usage chunk
			expect(chunks[0]).toEqual({
				type: "tool_call",
				id: toolCallData.callId,
				name: toolCallData.name,
				arguments: JSON.stringify(toolCallData.arguments),
			})
		})

		it("should emit structurally compatible tool calls when tools are provided", async () => {
			const toolCallData = {
				name: "calculator",
				arguments: { operation: "add", numbers: [2, 2] },
				callId: "call-1",
			}

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield {
						callId: toolCallData.callId,
						name: toolCallData.name,
						input: toolCallData.arguments,
					}
				})(),
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "calculator",
						description: "A simple calculator",
						parameters: {
							type: "object",
							properties: {
								operation: { type: "string" },
							},
						},
					},
				},
			]

			const chunks = []
			for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Calculate 2+2" }], {
				taskId: "test-task",
				tools,
			})) {
				chunks.push(chunk)
			}

			expect(chunks[0]).toEqual({
				type: "tool_call",
				id: toolCallData.callId,
				name: toolCallData.name,
				arguments: JSON.stringify(toolCallData.arguments),
			})
		})

		it("should handle native tool calls when tools are provided", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Calculate 2+2",
				},
			]

			const toolCallData = {
				name: "calculator",
				arguments: { operation: "add", numbers: [2, 2] },
				callId: "call-1",
			}

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "calculator",
						description: "A simple calculator",
						parameters: {
							type: "object",
							properties: {
								operation: { type: "string" },
								numbers: { type: "array", items: { type: "number" } },
							},
						},
					},
				},
			]

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelToolCallPart(
						toolCallData.callId,
						toolCallData.name,
						toolCallData.arguments,
					)
					return
				})(),
				text: (async function* () {
					yield JSON.stringify({ type: "tool_call", ...toolCallData })
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				tools,
			})
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2) // Tool call chunk + usage chunk
			expect(chunks[0]).toEqual({
				type: "tool_call",
				id: toolCallData.callId,
				name: toolCallData.name,
				arguments: JSON.stringify(toolCallData.arguments),
			})
		})

		it("should pass tools to request options when tools are provided", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Calculate 2+2",
				},
			]

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "calculator",
						description: "A simple calculator",
						parameters: {
							type: "object",
							properties: {
								operation: { type: "string" },
							},
						},
					},
				},
			]

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Result: 4")
					return
				})(),
				text: (async function* () {
					yield "Result: 4"
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				tools,
			})
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify sendRequest was called with tools in options
			// Note: normalizeToolSchema adds additionalProperties: false for JSON Schema 2020-12 compliance
			expect(mockLanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					tools: [
						{
							name: "calculator",
							description: "A simple calculator",
							inputSchema: {
								type: "object",
								properties: {
									operation: { type: "string" },
								},
								additionalProperties: false,
							},
						},
					],
				}),
				expect.anything(),
			)
		})

		it("should pass selected reasoning effort through request options", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				enableReasoningEffort: true,
				reasoningEffort: "high",
			})
			handler["client"] = mockCopilotGpt55LanguageModelChat as any

			mockCopilotGpt55LanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Reasoned response")
				})(),
			})

			const chunks = []
			for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Think carefully" }])) {
				chunks.push(chunk)
			}

			expect(mockCopilotGpt55LanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					modelOptions: {
						reasoningEffort: "high",
					},
					configuration: {
						reasoningEffort: "high",
					},
				}),
				expect.anything(),
			)
			expect(chunks[0]).toEqual({
				type: "text",
				text: "Reasoned response",
			})
		})

		it("should pass selected extra-high reasoning effort through request options", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				enableReasoningEffort: true,
				reasoningEffort: "xhigh",
			})
			handler["client"] = mockCopilotGpt55LanguageModelChat as any

			mockCopilotGpt55LanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Extra reasoned response")
				})(),
			})

			for await (const _chunk of handler.createMessage("System", [{ role: "user", content: "Think hardest" }])) {
				// consume stream
			}

			expect(mockCopilotGpt55LanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					modelOptions: {
						reasoningEffort: "xhigh",
					},
					configuration: {
						reasoningEffort: "xhigh",
					},
				}),
				expect.anything(),
			)
		})

		it("should pass maximum reasoning and extended context through Copilot model configuration", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				enableReasoningEffort: true,
				reasoningEffort: "max",
				vsCodeLmContextSize: 922_000,
			})
			handler["client"] = mockCopilotGpt56TerraLanguageModelChat as any

			mockCopilotGpt56TerraLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Maximum reasoned response")
				})(),
			})

			for await (const _chunk of handler.createMessage("System", [{ role: "user", content: "Think fully" }])) {
				// consume stream
			}

			expect(mockCopilotGpt56TerraLanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					modelOptions: {
						reasoningEffort: "max",
						contextSize: 922_000,
					},
					configuration: {
						reasoningEffort: "max",
						contextSize: 922_000,
					},
				}),
				expect.anything(),
			)
		})

		it("should pass Claude's 1M-tier input budget through Copilot model configuration", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				enableReasoningEffort: true,
				reasoningEffort: "max",
				vsCodeLmContextSize: 936_000,
			})
			const claudeModel = {
				...mockLanguageModelChat,
				id: "claude-opus-4.8",
				name: "Claude Opus 4.8",
				vendor: "copilot",
				family: "claude-opus-4.8",
				version: "claude-opus-4.8",
				maxInputTokens: 936_000,
			}
			handler["client"] = claudeModel as any

			claudeModel.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Claude response")
				})(),
			})

			for await (const _chunk of handler.createMessage("System", [{ role: "user", content: "Think fully" }])) {
				// consume stream
			}

			expect(claudeModel.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					modelOptions: { reasoningEffort: "max", contextSize: 936_000 },
					configuration: { reasoningEffort: "max", contextSize: 936_000 },
				}),
				expect.anything(),
			)
		})

		it("should pass the selected standard context through Copilot model configuration", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				vsCodeLmContextSize: 272_000,
			})
			handler["client"] = mockCopilotGpt55LanguageModelChat as any

			mockCopilotGpt55LanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Standard context response")
				})(),
			})

			for await (const _chunk of handler.createMessage("System", [
				{ role: "user", content: "Use standard context" },
			])) {
				// consume stream
			}

			expect(mockCopilotGpt55LanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					modelOptions: { contextSize: 272_000 },
					configuration: { contextSize: 272_000 },
				}),
				expect.anything(),
			)
		})

		it("should pass selected high reasoning effort through request options for Copilot GPT-5.3 Codex", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				enableReasoningEffort: true,
				reasoningEffort: "high",
			})
			handler["client"] = mockCopilotGpt53CodexLanguageModelChat as any

			mockCopilotGpt53CodexLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Codex high reasoning response")
				})(),
			})

			for await (const _chunk of handler.createMessage("System", [
				{ role: "user", content: "Think carefully" },
			])) {
				// consume stream
			}

			expect(mockCopilotGpt53CodexLanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					modelOptions: {
						reasoningEffort: "high",
					},
					configuration: {
						reasoningEffort: "high",
					},
				}),
				expect.anything(),
			)
		})

		it("should omit stale reasoning effort model options for models without reasoning support", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				enableReasoningEffort: true,
				reasoningEffort: "high",
			})
			const unsupportedModel = {
				...mockLanguageModelChat,
				id: "copilot-claude-opus-4.5",
				name: "Claude Opus 4.5",
				vendor: "copilot",
				family: "claude-opus-4.5",
				version: "2026-06-01",
			}
			handler["client"] = unsupportedModel as any

			unsupportedModel.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Plain response")
				})(),
			})

			for await (const _chunk of handler.createMessage("System", [{ role: "user", content: "Answer" }])) {
				// consume stream
			}

			expect(unsupportedModel.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.not.objectContaining({
					modelOptions: expect.anything(),
					configuration: expect.anything(),
				}),
				expect.anything(),
			)
			const requestOptions = unsupportedModel.sendRequest.mock.calls.at(-1)?.[1]
			expect(requestOptions).not.toHaveProperty("modelOptions")
			expect(requestOptions).not.toHaveProperty("configuration")
		})

		it("should omit reasoning effort model options when disabled", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				enableReasoningEffort: false,
				reasoningEffort: "high",
			})
			handler["client"] = mockLanguageModelChat

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Fast response")
				})(),
			})

			for await (const _chunk of handler.createMessage("System", [{ role: "user", content: "Answer quickly" }])) {
				// consume stream
			}

			expect(mockLanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.not.objectContaining({
					modelOptions: expect.anything(),
					configuration: expect.anything(),
				}),
				expect.anything(),
			)
			const requestOptions = mockLanguageModelChat.sendRequest.mock.calls.at(-1)?.[1]
			expect(requestOptions).not.toHaveProperty("modelOptions")
			expect(requestOptions).not.toHaveProperty("configuration")
		})

		it("should handle errors", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			mockLanguageModelChat.sendRequest.mockRejectedValueOnce(new Error("API Error"))

			await expect(handler.createMessage(systemPrompt, messages).next()).rejects.toThrow("API Error")
		})

		it("should cancel when VS Code LM request startup hangs past the API timeout", async () => {
			mockGetApiRequestTimeoutSetting.mockReturnValue(0.001)

			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			mockLanguageModelChat.sendRequest.mockImplementationOnce(() => new Promise(() => undefined))

			await expect(handler.createMessage(systemPrompt, messages).next()).rejects.toThrow(
				/VS Code LM request .* timed out after 1 second/,
			)
			expect(mockCancellationSources[0]?.cancel).toHaveBeenCalled()
		})

		it("should cancel when VS Code LM response stream stalls past the API timeout", async () => {
			mockGetApiRequestTimeoutSetting.mockReturnValue(0.001)

			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: {
					[Symbol.asyncIterator]() {
						return {
							next: () => new Promise(() => undefined),
						}
					},
				},
			})

			await expect(handler.createMessage(systemPrompt, messages).next()).rejects.toThrow(
				/VS Code LM response stream .* timed out after 1 second/,
			)
			expect(mockCancellationSources[0]?.cancel).toHaveBeenCalled()
		})
	})

	describe("getModel", () => {
		it("should return model info when client exists", async () => {
			const mockModel = { ...mockLanguageModelChat }
			// The handler starts async initialization in the constructor.
			// Make the test deterministic by explicitly (re)initializing here.
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null
			await handler.initializeClient()

			const model = handler.getModel()
			expect(model.id).toBe("test-model")
			expect(model.info).toBeDefined()
			expect(model.info.contextWindow).toBe(4096)
		})

		it("should return fallback model info when no client exists", () => {
			// Clear the client first
			handler["client"] = null
			const model = handler.getModel()
			expect(model.id).toBe("test-vendor/test-family")
			expect(model.info).toBeDefined()
		})

		it("should return basic model info when client exists", async () => {
			const mockModel = { ...mockLanguageModelChat }
			// The handler starts async initialization in the constructor.
			// Make the test deterministic by explicitly (re)initializing here.
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null
			await handler.initializeClient()

			const model = handler.getModel()
			expect(model.info).toBeDefined()
			expect(model.info.contextWindow).toBe(4096)
		})

		it("should return Copilot GPT-5.5 reasoning effort support from static model metadata", async () => {
			const mockModel = {
				...mockLanguageModelChat,
				id: "copilot-gpt-5.5",
				name: "GPT-5.5",
				vendor: "copilot",
				family: "gpt-5.5",
				version: "2026-06-01",
				maxInputTokens: 128_000,
			}
			handler["client"] = mockModel as any

			const model = handler.getModel()
			expect(model.info.supportsReasoningEffort).toEqual(["none", "low", "medium", "high", "xhigh"])
			expect(model.info.contextWindow).toBe(272_000)
		})

		it("should return Copilot GPT-5.3 Codex reasoning effort support from static model metadata", async () => {
			const mockModel = {
				...mockLanguageModelChat,
				id: "copilot-gpt-5.3-codex",
				name: "GPT-5.3-Codex",
				vendor: "copilot",
				family: "gpt-5.3-codex",
				version: "2026-06-01",
				maxInputTokens: 128_000,
			}
			handler["client"] = mockModel as any

			const model = handler.getModel()
			expect(model.info.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh"])
			expect(model.info.contextWindow).toBe(272_000)
		})

		it("should return Copilot's provider-default extended window for Claude Opus 4.7", async () => {
			const mockModel = {
				...mockLanguageModelChat,
				id: "copilot-claude-opus-4.7",
				name: "Claude Opus 4.7",
				vendor: "copilot",
				family: "claude-opus-4.7",
				version: "2026-06-01",
				maxInputTokens: 1_000_000,
			}
			handler["client"] = mockModel as any

			const model = handler.getModel()
			expect(model.info.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
			expect(model.info.contextWindow).toBe(936_000)
		})

		it("should report the selected extended input window", () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				vsCodeLmContextSize: 922_000,
			})
			handler["client"] = mockCopilotGpt56TerraLanguageModelChat as any

			const model = handler.getModel()
			expect(model.info.contextWindow).toBe(921_793)
			expect(model.info.supportsReasoningEffort).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
		})

		it("should ignore a stale extended setting when the live selector only advertises the standard tier", () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				vsCodeLmContextSize: 922_000,
			})
			handler["client"] = {
				...mockCopilotGpt55LanguageModelChat,
				maxInputTokens: 272_000,
			} as any

			const model = handler.getModel()
			expect(model.info.contextWindow).toBe(272_000)
		})

		it("should return fallback model info when no client exists", () => {
			// Clear the client first
			handler["client"] = null
			const model = handler.getModel()
			expect(model.info).toBeDefined()
		})
	})

	describe("countTokens", () => {
		beforeEach(() => {
			handler["client"] = mockLanguageModelChat
		})

		it("should count tokens when called outside of an active request", async () => {
			// Ensure no active request cancellation token exists
			handler["currentRequestCancellation"] = null

			mockLanguageModelChat.countTokens.mockResolvedValueOnce(42)

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Hello world" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(42)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith("Hello world", expect.any(Object))
		})

		it("should count tokens when called during an active request", async () => {
			// Simulate an active request with a cancellation token
			const mockCancellation = {
				token: { isCancellationRequested: false, onCancellationRequested: vi.fn() },
				cancel: vi.fn(),
				dispose: vi.fn(),
			}
			handler["currentRequestCancellation"] = mockCancellation as any

			mockLanguageModelChat.countTokens.mockResolvedValueOnce(50)

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Test content" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(50)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith("Test content", expect.any(Object))
		})

		it("should return 0 when no client is available", async () => {
			handler["client"] = null
			handler["currentRequestCancellation"] = null

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Hello" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(0)
		})

		it("should handle image blocks with placeholder", async () => {
			handler["currentRequestCancellation"] = null
			mockLanguageModelChat.countTokens.mockResolvedValueOnce(5)

			const content: Anthropic.Messages.ContentBlockParam[] = [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
			]
			const result = await handler.countTokens(content)

			expect(result).toBe(5)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith("[IMAGE]", expect.any(Object))
		})
	})

	describe("completePrompt", () => {
		it("should complete single prompt", async () => {
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([mockModel])

			const responseText = "Completed text"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart(responseText)
					return
				})(),
				text: (async function* () {
					yield responseText
					return
				})(),
			})

			// Override the default client with our test client to ensure it uses
			// the mock implementation rather than the default fallback
			handler["client"] = mockLanguageModelChat

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe(responseText)
			expect(mockLanguageModelChat.sendRequest).toHaveBeenCalled()
		})

		it("should pass selected reasoning effort through single prompt completion request options", async () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				enableReasoningEffort: true,
				reasoningEffort: "medium",
			})
			handler["client"] = mockCopilotGpt55LanguageModelChat as any

			mockCopilotGpt55LanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Completed text")
				})(),
			})

			await handler.completePrompt("Test prompt")

			expect(mockCopilotGpt55LanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					modelOptions: {
						reasoningEffort: "medium",
					},
					configuration: {
						reasoningEffort: "medium",
					},
				}),
				expect.anything(),
			)
		})

		it("should handle errors during completion", async () => {
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([mockModel])

			mockLanguageModelChat.sendRequest.mockRejectedValueOnce(new Error("Completion failed"))

			// Make sure we're using the mock client
			handler["client"] = mockLanguageModelChat

			const promise = handler.completePrompt("Test prompt")
			await expect(promise).rejects.toThrow("VSCode LM completion error: Completion failed")
		})
	})
})

describe("getVsCodeLmModels", () => {
	it("returns only serializable selectors discovered in the current VS Code window", async () => {
		const unknownModel = {
			...mockLanguageModelChat,
			id: "claude-3.7-sonnet",
			name: "Claude 3.7 Sonnet",
		}
		const currentModel = { ...mockCopilotGpt56TerraLanguageModelChat }
		const selectChatModels = vscode.lm.selectChatModels as Mock
		selectChatModels.mockReset()
		selectChatModels.mockResolvedValue([unknownModel, currentModel])

		const models = await getVsCodeLmModels()

		expect(vscode.lm.selectChatModels).toHaveBeenCalledWith({})
		expect(models).toEqual([
			expect.objectContaining({ id: unknownModel.id, name: unknownModel.name }),
			expect.objectContaining({
				vendor: currentModel.vendor,
				family: currentModel.family,
				version: currentModel.version,
				id: currentModel.id,
				name: currentModel.name,
				maxInputTokens: currentModel.maxInputTokens,
			}),
		])
		expect(models.some((model) => model.family === "gpt-5.5")).toBe(false)
		expect(models.every((model) => !("sendRequest" in model))).toBe(true)
	})

	it("returns no clickable models when VS Code model discovery fails", async () => {
		const selectChatModels = vscode.lm.selectChatModels as Mock
		selectChatModels.mockReset()
		selectChatModels.mockRejectedValue(new Error("Copilot consent required"))

		const models = await getVsCodeLmModels()

		expect(models).toEqual([])
	})

	it("deduplicates live variants and excludes Mythos", async () => {
		const selectChatModels = vscode.lm.selectChatModels as Mock
		selectChatModels.mockReset()
		selectChatModels.mockResolvedValue([
			{ ...mockCopilotGpt55LanguageModelChat, id: "gpt-5.5-standard", maxInputTokens: 272_000 },
			{ ...mockCopilotGpt55LanguageModelChat, id: "gpt-5.5-extended", maxInputTokens: 921_793 },
			{
				...mockLanguageModelChat,
				vendor: "copilot",
				family: "claude-mythos-5",
				id: "claude-mythos-5",
				name: "Claude Mythos 5",
			},
		])

		const models = await getVsCodeLmModels()
		const gpt55Models = models.filter((model) => model.family === "gpt-5.5")

		expect(gpt55Models).toEqual([expect.objectContaining({ id: "gpt-5.5-extended", maxInputTokens: 921_793 })])
		expect(models.some((model) => JSON.stringify(model).includes("mythos"))).toBe(false)
	})
})
