import type { Mock } from "vitest"

const { mockGetApiRequestTimeoutSetting, mockCancellationSources, mockVsCodeVersion } = vi.hoisted(() => ({
	mockGetApiRequestTimeoutSetting: vi.fn(() => 600),
	mockVsCodeVersion: { value: "1.135.0" },
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

	class MockLanguageModelToolResultPart {
		constructor(
			public callId: string,
			public content: unknown[],
		) {}
	}

	class MockLanguageModelDataPart {
		static image(data: Uint8Array, mimeType: string) {
			return new MockLanguageModelDataPart(data, mimeType)
		}

		constructor(
			public data: Uint8Array,
			public mimeType: string,
		) {}
	}

	return {
		get version() {
			return mockVsCodeVersion.value
		},
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
		LanguageModelToolResultPart: MockLanguageModelToolResultPart,
		LanguageModelDataPart: MockLanguageModelDataPart,
		lm: {
			selectChatModels: vi.fn(),
			onDidChangeChatModels: vi.fn((_callback) => ({
				dispose: vi.fn(),
			})),
		},
	}
})

import * as vscode from "vscode"
import type OpenAI from "openai"
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
		mockVsCodeVersion.value = "1.135.0"
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

		it("should reject an ambiguous broad selector instead of choosing the first model", async () => {
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([
				{ ...mockLanguageModelChat, id: "test-model-standard", version: "standard" },
				{ ...mockLanguageModelChat, id: "test-model-extended", version: "extended" },
			])

			await expect(handler["createClient"]({ vendor: "test-vendor", family: "test-family" })).rejects.toThrow(
				/is ambiguous and matched 2 models/,
			)
		})

		it("should select the unique exact match even if VS Code returns broader results", async () => {
			const selectedModel = { ...mockLanguageModelChat, id: "selected-model" }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([
				{ ...mockLanguageModelChat, id: "other-model" },
				selectedModel,
			])

			const client = await handler["createClient"]({
				vendor: "test-vendor",
				family: "test-family",
				id: "selected-model",
			})

			expect(client).toBe(selectedModel)
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

		it("should explain the VS Code minimum when an unavailable GPT-5.6 selector is stale", async () => {
			mockVsCodeVersion.value = "1.122.1"
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([])

			await expect(
				handler["createClient"]({ vendor: "copilot", family: "gpt-5.6-sol", id: "copilot-gpt-5.6-sol" }),
			).rejects.toThrow(/require VS Code 1\.128\.0 or newer \(current: 1\.122\.1\)/)
			expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(1)
		})

		it("should keep live GPT-5.6 discovery authoritative on older VS Code builds", async () => {
			mockVsCodeVersion.value = "1.122.1"
			const liveModel = {
				...mockLanguageModelChat,
				vendor: "copilot",
				family: "gpt-5.6-sol",
				id: "copilot-gpt-5.6-sol",
			}
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([liveModel])

			await expect(
				handler["createClient"]({ vendor: "copilot", family: "gpt-5.6-sol", id: "copilot-gpt-5.6-sol" }),
			).resolves.toBe(liveModel)
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

		it("should let an active stream finish when the VS Code model list changes", async () => {
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("First")
					yield new vscode.LanguageModelTextPart("Second")
				})(),
			})

			const stream = handler.createMessage("System", [{ role: "user", content: "Hello" }])
			await expect(stream.next()).resolves.toMatchObject({ value: { type: "text", text: "First" } })
			const activeCancellation = mockCancellationSources.at(-1)
			const modelsChanged = (vscode.lm.onDidChangeChatModels as Mock).mock.calls[0][0]

			modelsChanged()

			expect(handler["client"]).toBeNull()
			expect(activeCancellation?.cancel).not.toHaveBeenCalled()
			await expect(stream.next()).resolves.toMatchObject({ value: { type: "text", text: "Second" } })
			await expect(stream.next()).resolves.toMatchObject({ value: { type: "usage" } })
			await expect(stream.next()).resolves.toMatchObject({ done: true })
		})

		it("should send the system prompt as the first user message without pre-stream token API calls", async () => {
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Response")
				})(),
			})

			for await (const _chunk of handler.createMessage("System instructions", [
				{ role: "user", content: "Hello" },
			])) {
				// consume stream
			}

			const requestMessages = mockLanguageModelChat.sendRequest.mock.calls.at(-1)?.[0]
			expect(requestMessages?.[0]).toMatchObject({
				role: "user",
				content: [expect.objectContaining({ value: "System instructions" })],
			})
			expect(mockLanguageModelChat.countTokens).not.toHaveBeenCalled()
		})

		it("should include serialized tool schemas in the synchronous input estimate", async () => {
			mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
				stream: (async function* () {})(),
			}))

			const collectInputTokens = async (tools?: OpenAI.Chat.ChatCompletionTool[]) => {
				const chunks = []
				for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }], {
					taskId: "test-task",
					tools,
				})) {
					chunks.push(chunk)
				}

				return chunks.find((chunk) => chunk.type === "usage")?.inputTokens ?? 0
			}

			const withoutTools = await collectInputTokens()
			const withTools = await collectInputTokens([
				{
					type: "function",
					function: {
						name: "calculator",
						description: "Calculate an arithmetic expression",
						parameters: {
							type: "object",
							properties: { expression: { type: "string" } },
							required: ["expression"],
						},
					},
				},
			])

			expect(withTools).toBeGreaterThan(withoutTools)
			expect(mockLanguageModelChat.countTokens).not.toHaveBeenCalled()
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

		it("should classify VS Code 1.122 Copilot thinking parts before generic text parts", async () => {
			mockVsCodeVersion.value = "1.122.1"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield { value: ["Working", "through the request"], id: undefined, metadata: undefined }
					yield new vscode.LanguageModelTextPart("Final answer")
				})(),
			})

			const chunks = []
			for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }])) {
				chunks.push(chunk)
			}

			expect(chunks.slice(0, 2)).toEqual([
				{ type: "reasoning", text: "Working\nthrough the request" },
				{ type: "text", text: "Final answer" },
			])
		})

		it("should use terminal VS Code LM usage metadata without re-tokenizing the response", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
			const responseText = "Text before metadata"
			const statefulMarker = new TextEncoder().encode("gpt-5.6-sol\\resp_123")
			const usage = {
				prompt_tokens: 321,
				completion_tokens: 45,
				total_tokens: 366,
			}

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart(responseText)
					yield { mimeType: "stateful_marker", data: statefulMarker }
					yield { mimeType: "usage", data: new TextEncoder().encode(JSON.stringify(usage)) }
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
			expect(chunks.at(-1)).toEqual({
				type: "usage",
				inputTokens: usage.prompt_tokens,
				outputTokens: usage.completion_tokens,
			})
			expect(mockLanguageModelChat.countTokens).not.toHaveBeenCalledWith(responseText, expect.anything())
			expect(handler.getStatefulMarker()).toBe(Buffer.from(statefulMarker).toString("base64"))
			expect(warnSpy).not.toHaveBeenCalledWith(
				"Alpha <Language Model API>: Unknown chunk type received:",
				expect.anything(),
			)
			warnSpy.mockRestore()
		})

		it("should replay a persisted stateful marker on its assistant tool-call message", async () => {
			const marker = new TextEncoder().encode("gpt-5.6-sol\\resp_123")
			const messages = [
				{
					role: "assistant" as const,
					content: [
						{
							type: "tool_use" as const,
							id: "call-1",
							name: "calculator",
							input: { expression: "2+2" },
						},
					],
					vscodeLmStatefulMarker: Buffer.from(marker).toString("base64"),
				},
			] as unknown as Anthropic.Messages.MessageParam[]
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {})(),
			})

			for await (const _chunk of handler.createMessage("System", messages)) {
				// consume stream
			}

			const requestMessages = mockLanguageModelChat.sendRequest.mock.calls.at(-1)?.[0]
			const assistantMessage = requestMessages?.find((message: any) => message.role === "assistant")
			const markerPart = assistantMessage?.content.at(-1)

			expect(assistantMessage?.content[0]).toMatchObject({ type: "tool_call", callId: "call-1" })
			expect(markerPart).toMatchObject({ mimeType: "stateful_marker" })
			expect(Array.from(markerPart.data)).toEqual(Array.from(marker))
		})

		it("should clear a prior stateful marker when the next response does not emit one", async () => {
			const marker = new TextEncoder().encode("gpt-5.6-sol\\resp_123")
			mockLanguageModelChat.sendRequest
				.mockResolvedValueOnce({
					stream: (async function* () {
						yield { mimeType: "stateful_marker", data: marker }
					})(),
				})
				.mockResolvedValueOnce({
					stream: (async function* () {
						yield new vscode.LanguageModelTextPart("Fresh response")
					})(),
				})

			for await (const _chunk of handler.createMessage("System", [{ role: "user", content: "First" }])) {
				// consume stream
			}
			expect(handler.getStatefulMarker()).toBe(Buffer.from(marker).toString("base64"))

			for await (const _chunk of handler.createMessage("System", [{ role: "user", content: "Second" }])) {
				// consume stream
			}
			expect(handler.getStatefulMarker()).toBeUndefined()
		})

		it("should finish immediately with estimated output usage when metadata is unavailable", async () => {
			const responseText = "Fallback output token estimate"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart(responseText)
				})(),
			})

			const chunks = []
			for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{ type: "text", text: responseText },
				expect.objectContaining({
					type: "usage",
					outputTokens: Math.ceil(new TextEncoder().encode(responseText).byteLength / 3),
				}),
			])
			expect(mockLanguageModelChat.countTokens).not.toHaveBeenCalledWith(responseText, expect.anything())
		})

		it("should ignore malformed usage metadata without delaying stream completion", async () => {
			const responseText = "Response with malformed usage"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart(responseText)
					yield { mimeType: "usage", data: new TextEncoder().encode("not-json") }
				})(),
			})

			const chunks = []
			for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }])) {
				chunks.push(chunk)
			}

			expect(chunks.at(-1)).toEqual({
				type: "usage",
				inputTokens: expect.any(Number),
				outputTokens: Math.ceil(new TextEncoder().encode(responseText).byteLength / 3),
			})
			expect(mockLanguageModelChat.countTokens).not.toHaveBeenCalledWith(responseText, expect.anything())
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

		it("should route reasoning effort through both public and VS Code 1.122 Copilot options", async () => {
			mockVsCodeVersion.value = "1.122.1"
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

		it("should pass maximum reasoning and extended context through both model option routes", async () => {
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

		it("should pass Claude's 1M-tier input budget through both model option routes", async () => {
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

		it("should pass the selected standard context through both model option routes", async () => {
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

		it("should abort a stalled stream read after the first chunk and release request ownership", async () => {
			let readCount = 0
			let stalledReadStarted = false
			const taskCancellation = new AbortController()
			const addAbortListener = vi.spyOn(taskCancellation.signal, "addEventListener")
			const removeAbortListener = vi.spyOn(taskCancellation.signal, "removeEventListener")
			const closeResponseIterator = vi.fn(async () => ({ done: true as const, value: undefined }))
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: {
					[Symbol.asyncIterator]() {
						return {
							next: () => {
								readCount++
								if (readCount === 1) {
									return Promise.resolve({
										done: false as const,
										value: new vscode.LanguageModelTextPart("First chunk"),
									})
								}
								stalledReadStarted = true
								return new Promise<IteratorResult<unknown>>(() => undefined)
							},
							return: closeResponseIterator,
						}
					},
				},
			})

			const stream = handler.createMessage("System", [{ role: "user", content: "Hello" }], {
				taskId: "task-abort",
				signal: taskCancellation.signal,
			})
			await expect(stream.next()).resolves.toMatchObject({
				value: { type: "text", text: "First chunk" },
			})
			const pendingRead = stream.next()
			await vi.waitFor(() => expect(stalledReadStarted).toBe(true))
			const requestCancellation = mockCancellationSources[0]
			expect(addAbortListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
			expect(mockLanguageModelChat.sendRequest.mock.calls[0]?.[2]).toBe(requestCancellation.token)

			taskCancellation.abort()

			expect(requestCancellation.cancel).toHaveBeenCalledOnce()
			expect(requestCancellation.token.isCancellationRequested).toBe(true)
			await expect(pendingRead).rejects.toThrow("Request cancelled by user")
			expect(closeResponseIterator).toHaveBeenCalledOnce()
			expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function))
			expect(requestCancellation.dispose).toHaveBeenCalledOnce()
			expect(handler["currentRequestCancellation"]).toBeNull()
			expect(handler["currentRequestSignalCleanup"]).toBeNull()
		})

		it("should not start a VS Code request when the task signal is already aborted", async () => {
			const taskCancellation = new AbortController()
			taskCancellation.abort()

			const stream = handler.createMessage("System", [{ role: "user", content: "Hello" }], {
				taskId: "already-aborted",
				signal: taskCancellation.signal,
			})

			await expect(stream.next()).rejects.toThrow("Request cancelled by user")
			expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
			expect(mockCancellationSources[0]?.cancel).toHaveBeenCalledOnce()
			expect(mockCancellationSources[0]?.dispose).toHaveBeenCalledOnce()
		})

		it("should cancel and dispose its request when the consumer stops reading early", async () => {
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Partial response")
					yield new vscode.LanguageModelTextPart("Unread response")
				})(),
			})

			const stream = handler.createMessage("System", [{ role: "user", content: "Hello" }])
			await expect(stream.next()).resolves.toMatchObject({
				value: { type: "text", text: "Partial response" },
			})
			const cancellation = mockCancellationSources[0]

			await stream.return(undefined)

			expect(cancellation.cancel).toHaveBeenCalledOnce()
			expect(cancellation.dispose).toHaveBeenCalledOnce()
		})

		it("should not let a cancelled predecessor tear down a newly started follow-up", async () => {
			let rejectFirstRead: ((reason?: unknown) => void) | undefined
			const firstTaskCancellation = new AbortController()
			const followUpTaskCancellation = new AbortController()
			const removeFirstAbortListener = vi.spyOn(firstTaskCancellation.signal, "removeEventListener")
			const removeFollowUpAbortListener = vi.spyOn(followUpTaskCancellation.signal, "removeEventListener")
			mockLanguageModelChat.sendRequest
				.mockResolvedValueOnce({
					stream: {
						[Symbol.asyncIterator]() {
							return {
								next: () =>
									new Promise((_resolve, reject) => {
										rejectFirstRead = reject
									}),
							}
						},
					},
				})
				.mockResolvedValueOnce({
					stream: (async function* () {
						yield new vscode.LanguageModelTextPart("Follow-up response")
					})(),
				})

			const firstStream = handler.createMessage("System", [{ role: "user", content: "First" }], {
				taskId: "first",
				signal: firstTaskCancellation.signal,
			})
			const firstRead = firstStream.next()
			await vi.waitFor(() => expect(rejectFirstRead).toBeTypeOf("function"))

			const followUpStream = handler.createMessage("System", [{ role: "user", content: "Follow-up" }], {
				taskId: "follow-up",
				signal: followUpTaskCancellation.signal,
			})
			const followUpRead = followUpStream.next()
			await vi.waitFor(() => expect(mockCancellationSources).toHaveLength(2))
			const followUpCancellation = mockCancellationSources[1]

			expect(removeFirstAbortListener).toHaveBeenCalledWith("abort", expect.any(Function))
			firstTaskCancellation.abort()
			expect(followUpCancellation.cancel).not.toHaveBeenCalled()
			rejectFirstRead?.(new vscode.CancellationError())
			await expect(firstRead).rejects.toThrow("Request cancelled by user")
			expect(followUpCancellation.cancel).not.toHaveBeenCalled()
			await expect(followUpRead).resolves.toMatchObject({
				value: { type: "text", text: "Follow-up response" },
			})
			await expect(followUpStream.next()).resolves.toMatchObject({ value: { type: "usage" } })
			await expect(followUpStream.next()).resolves.toMatchObject({ done: true })
			expect(followUpCancellation.cancel).not.toHaveBeenCalled()
			expect(removeFollowUpAbortListener).toHaveBeenCalledWith("abort", expect.any(Function))
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
			expect(model.info.contextWindow).toBe(128_000)
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
			expect(model.info.contextWindow).toBe(128_000)
		})

		it("should keep Claude Opus 4.7 on its standard context unless extended context is selected", async () => {
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
			expect(model.info.contextWindow).toBe(200_000)
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

		it("should hard-cap the reported context window to the finite live input limit", () => {
			handler = new VsCodeLmHandler({
				...defaultOptions,
				vsCodeLmContextSize: 922_000,
			})
			handler["client"] = {
				...mockCopilotGpt56TerraLanguageModelChat,
				maxInputTokens: 123_456,
			} as any

			expect(handler.getModel().info.contextWindow).toBe(123_456)
		})

		it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
			"should use a finite positive static context when the live limit is invalid (%s)",
			(maxInputTokens) => {
				handler["client"] = {
					...mockCopilotGpt55LanguageModelChat,
					maxInputTokens,
				} as any

				expect(handler.getModel().info.contextWindow).toBe(272_000)
			},
		)

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
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "user",
					content: [expect.objectContaining({ value: "Hello world" })],
				}),
				expect.any(Object),
			)
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
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "user",
					content: [expect.objectContaining({ value: "Test content" })],
				}),
				expect.any(Object),
			)
		})

		it("should return a conservative nonzero fallback when no client is available", async () => {
			handler["client"] = null
			handler["currentRequestCancellation"] = null

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Hello" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(Math.ceil(new TextEncoder().encode("Hello").byteLength / 3))
		})

		it("should pass complete chat message objects to the VS Code tokenizer", async () => {
			const message = vscode.LanguageModelChatMessage.User("Count the complete message")
			mockLanguageModelChat.countTokens.mockResolvedValueOnce(17)

			const result = await handler["internalCountTokens"](message)

			expect(result).toBe(17)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith(message, expect.any(Object))
		})

		it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "invalid"])(
			"should use a conservative fallback for invalid tokenizer output (%s)",
			async (tokenCount) => {
				mockLanguageModelChat.countTokens.mockResolvedValueOnce(tokenCount as number)

				const result = await handler.countTokens([{ type: "text", text: "Fallback text" }])

				expect(result).toBeGreaterThan(0)
			},
		)

		it("should use a conservative fallback when the tokenizer fails", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
			mockLanguageModelChat.countTokens.mockRejectedValueOnce(new Error("Tokenizer unavailable"))

			const result = await handler.countTokens([{ type: "text", text: "Fallback text" }])

			expect(result).toBeGreaterThan(0)
			warnSpy.mockRestore()
		})

		it("should bound a stalled VS Code token count at five seconds and use the local fallback", async () => {
			vi.useFakeTimers()
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
			try {
				mockLanguageModelChat.countTokens.mockImplementationOnce(() => new Promise(() => undefined))
				const text = "Fallback after a stalled provider tokenizer"
				const result = handler.countTokens([{ type: "text", text }])

				await vi.advanceTimersByTimeAsync(5_000)

				await expect(result).resolves.toBe(Math.ceil(new TextEncoder().encode(text).byteLength / 3))
				expect(mockCancellationSources[0]?.cancel).toHaveBeenCalledOnce()
				expect(mockCancellationSources[0]?.dispose).toHaveBeenCalledOnce()
			} finally {
				warnSpy.mockRestore()
				vi.useRealTimers()
			}
		})

		it("should use the full context as the safety floor when an image token count stalls", async () => {
			vi.useFakeTimers()
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
			try {
				mockLanguageModelChat.countTokens.mockImplementationOnce(() => new Promise(() => undefined))
				const result = handler.countTokens([
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
				])

				await vi.advanceTimersByTimeAsync(5_000)

				await expect(result).resolves.toBe(mockLanguageModelChat.maxInputTokens)
			} finally {
				warnSpy.mockRestore()
				vi.useRealTimers()
			}
		})

		it("should pass structured image messages to the VS Code tokenizer", async () => {
			handler["currentRequestCancellation"] = null
			mockLanguageModelChat.countTokens.mockResolvedValueOnce(5)

			const content: Anthropic.Messages.ContentBlockParam[] = [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
			]
			const result = await handler.countTokens(content)

			expect(result).toBe(5)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "user",
					content: [expect.objectContaining({ mimeType: "image/png", data: expect.any(Uint8Array) })],
				}),
				expect.any(Object),
			)
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

		it("should omit VS Code thinking parts from single-prompt answer text", async () => {
			handler["client"] = mockLanguageModelChat
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield { value: "Internal reasoning", id: "reasoning-1", metadata: {} }
					yield new vscode.LanguageModelTextPart("Answer only")
				})(),
			})

			await expect(handler.completePrompt("Test prompt")).resolves.toBe("Answer only")
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

	it("preserves unique live model ids, deduplicates exact identities, and excludes Mythos", async () => {
		const selectChatModels = vscode.lm.selectChatModels as Mock
		selectChatModels.mockReset()
		selectChatModels.mockResolvedValue([
			{ ...mockCopilotGpt55LanguageModelChat, id: "gpt-5.5-standard", maxInputTokens: 272_000 },
			{ ...mockCopilotGpt55LanguageModelChat, id: "gpt-5.5-extended", maxInputTokens: 500_000 },
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

		expect(gpt55Models).toEqual([
			expect.objectContaining({ id: "gpt-5.5-standard", maxInputTokens: 272_000 }),
			expect.objectContaining({ id: "gpt-5.5-extended", maxInputTokens: 921_793 }),
		])
		expect(models.some((model) => JSON.stringify(model).includes("mythos"))).toBe(false)
	})
})
