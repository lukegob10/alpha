// npx vitest run src/api/providers/__tests__/vertex.spec.ts

const { mockExecFile, mockGoogleGenAI } = vitest.hoisted(() => ({
	mockExecFile: vitest.fn(),
	mockGoogleGenAI: vitest.fn(() => ({
		models: {
			generateContentStream: vitest.fn(),
			generateContent: vitest.fn(),
			getGenerativeModel: vitest.fn(),
		},
	})),
}))

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({}))

vitest.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>()
	return {
		...actual,
		execFile: mockExecFile,
	}
})

vitest.mock("@google/genai", () => ({
	GoogleGenAI: mockGoogleGenAI,
	FunctionCallingConfigMode: {
		ANY: "ANY",
		AUTO: "AUTO",
		NONE: "NONE",
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"

import { ApiStreamChunk } from "../../transform/stream"

import { t } from "i18next"
import { VertexHandler } from "../vertex"
import {
	createVertexGatewayRefreshHandler,
	fetchVertexGatewayAccessToken,
	resetVertexGatewayCaBundleForTests,
} from "../vertex-gateway"

describe("VertexHandler", () => {
	let handler: VertexHandler
	const originalUsername = process.env.USERNAME
	const originalUser = process.env.USER

	beforeEach(() => {
		vitest.clearAllMocks()
		resetVertexGatewayCaBundleForTests()
		restoreEnv("USERNAME", originalUsername)
		restoreEnv("USER", originalUser)

		// Create mock functions
		const mockGenerateContentStream = vitest.fn()
		const mockGenerateContent = vitest.fn()
		const mockGetGenerativeModel = vitest.fn()

		handler = new VertexHandler({
			apiModelId: "gemini-1.5-pro-001",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
		})

		// Replace the client with our mock
		handler["client"] = {
			models: {
				generateContentStream: mockGenerateContentStream,
				generateContent: mockGenerateContent,
				getGenerativeModel: mockGetGenerativeModel,
			},
		} as any
	})

	afterAll(() => {
		resetVertexGatewayCaBundleForTests()
		restoreEnv("USERNAME", originalUsername)
		restoreEnv("USER", originalUser)
	})

	describe("constructor", () => {
		it("should initialize GoogleGenAI with Vertex gateway options", () => {
			process.env.USERNAME = "soe123"

			new VertexHandler({
				apiModelId: "gemini-3-flash-preview",
				vertexProjectId: "test-project",
				vertexRegion: "global",
				vertexGatewayBaseUrl: "https://gateway.example.com/vertex",
				vertexGatewayCaBundlePath: "C:\\certs\\gateway.pem",
				vertexGatewayHelixCommand: "helix auth access-token print -a",
			})

			expect(mockGoogleGenAI).toHaveBeenLastCalledWith(
				expect.objectContaining({
					vertexai: true,
					project: "test-project",
					location: "global",
					httpOptions: {
						baseUrl: "https://gateway.example.com/vertex",
					},
					googleAuthOptions: {
						authClient: expect.objectContaining({
							getRequestHeaders: expect.any(Function),
						}),
					},
				}),
			)
		})
	})

	describe("createMessage", () => {
		const mockMessages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		]

		const systemPrompt = "You are a helpful assistant"

		it("should handle streaming responses correctly for Gemini", async () => {
			;(handler["client"].models.generateContentStream as any).mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield {
						candidates: [{ content: { parts: [{ text: "Gemini response part 1" }] } }],
					}
					yield {
						candidates: [{ content: { parts: [{ text: " part 2" }] }, finishReason: "STOP" }],
						responseId: "response-1",
						usageMetadata: {
							promptTokenCount: 10,
							candidatesTokenCount: 5,
						},
					}
				},
			})
			const chunks: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage(systemPrompt, mockMessages)) {
				chunks.push(chunk)
			}

			expect(handler["client"].models.generateContentStream).toHaveBeenCalled()
			expect(handler["client"].models.generateContent).not.toHaveBeenCalled()
			expect(chunks).toEqual([
				{ type: "text", text: "Gemini response part 1" },
				{ type: "text", text: " part 2" },
				expect.objectContaining({ type: "usage", inputTokens: 10, outputTokens: 5 }),
			])
		})

		it("should use non-streaming responses when Vertex streaming is disabled for Gemini", async () => {
			handler = new VertexHandler({
				apiModelId: "gemini-2.0-flash-001",
				vertexProjectId: "test-project",
				vertexRegion: "us-central1",
				vertexStreamingEnabled: false,
			})
			handler["client"] = {
				models: {
					generateContentStream: vitest.fn(),
					generateContent: vitest.fn().mockResolvedValue({
						responseId: "response-1",
						candidates: [
							{
								content: {
									parts: [
										{ text: "Completed response" },
										{ thought: true, text: "Reasoning trace" },
										{ functionCall: { name: "read_file", args: { path: "src/index.ts" } } },
									],
								},
								groundingMetadata: {
									groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
								},
							},
						],
						usageMetadata: {
							promptTokenCount: 11,
							candidatesTokenCount: 7,
							cachedContentTokenCount: 2,
							thoughtsTokenCount: 3,
						},
					}),
					getGenerativeModel: vitest.fn(),
				},
			} as any

			const chunks: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage(systemPrompt, mockMessages)) {
				chunks.push(chunk)
			}

			expect(handler["client"].models.generateContent).toHaveBeenCalled()
			expect(handler["client"].models.generateContentStream).not.toHaveBeenCalled()
			expect(chunks).toEqual([
				{ type: "text", text: "Completed response" },
				{ type: "reasoning", text: "Reasoning trace" },
				{ type: "tool_call", id: "read_file-0", name: "read_file", arguments: '{"path":"src/index.ts"}' },
				{ type: "grounding", sources: [{ title: "Example", url: "https://example.com" }] },
				expect.objectContaining({
					type: "usage",
					inputTokens: 11,
					outputTokens: 7,
					cacheReadTokens: 2,
					reasoningTokens: 3,
				}),
			])
		})

		it("should retry auth failures before emitting chunks when Vertex streaming is disabled", async () => {
			handler = new VertexHandler({
				apiModelId: "gemini-2.0-flash-001",
				vertexProjectId: "test-project",
				vertexRegion: "us-central1",
				vertexStreamingEnabled: false,
			})
			const generateContent = vitest
				.fn()
				.mockRejectedValueOnce(new Error("401 unauthorized"))
				.mockResolvedValueOnce({
					candidates: [{ content: { parts: [{ text: "Retried response" }] } }],
					usageMetadata: {
						promptTokenCount: 3,
						candidatesTokenCount: 4,
					},
				})
			handler["client"] = {
				models: {
					generateContentStream: vitest.fn(),
					generateContent,
					getGenerativeModel: vitest.fn(),
				},
			} as any
			vitest.spyOn(handler as any, "shouldRetryWithRefreshedGatewayToken").mockResolvedValueOnce(true)

			const chunks: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage(systemPrompt, mockMessages)) {
				chunks.push(chunk)
			}

			expect(generateContent).toHaveBeenCalledTimes(2)
			expect(chunks).toEqual([
				{ type: "text", text: "Retried response" },
				expect.objectContaining({ type: "usage", inputTokens: 3, outputTokens: 4 }),
			])
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully for Gemini", async () => {
			// Mock the response with text property
			;(handler["client"].models.generateContent as any).mockResolvedValue({
				text: "Test Gemini response",
			})

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test Gemini response")

			// Verify the call to generateContent
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith(
				expect.objectContaining({
					model: expect.any(String),
					contents: [{ role: "user", parts: [{ text: "Test prompt" }] }],
					config: expect.objectContaining({
						temperature: 1,
					}),
				}),
			)
		})

		it("should handle API errors for Gemini", async () => {
			const mockError = new Error("Vertex API error")
			;(handler["client"].models.generateContent as any).mockRejectedValue(mockError)

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow(
				t("common:errors.gemini.generate_complete_prompt", { error: "Vertex API error" }),
			)
		})

		it("should handle empty response for Gemini", async () => {
			// Mock the response with empty text
			;(handler["client"].models.generateContent as any).mockResolvedValue({
				text: "",
			})

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})
	})

	describe("getModel", () => {
		it("should return correct model info for Gemini", () => {
			// Create a new instance with specific model ID
			const testHandler = new VertexHandler({
				apiModelId: "gemini-2.0-flash-001",
				vertexProjectId: "test-project",
				vertexRegion: "us-central1",
			})

			// Don't mock getModel here as we want to test the actual implementation
			const modelInfo = testHandler.getModel()
			expect(modelInfo.id).toBe("gemini-2.0-flash-001")
			expect(modelInfo.info).toBeDefined()
			expect(modelInfo.info.maxTokens).toBe(8192)
			expect(modelInfo.info.contextWindow).toBe(1048576)
		})

		it("should exclude apply_diff and include edit in tool preferences", () => {
			const testHandler = new VertexHandler({
				apiModelId: "gemini-2.0-flash-001",
				vertexProjectId: "test-project",
				vertexRegion: "us-central1",
			})

			const modelInfo = testHandler.getModel()
			expect(modelInfo.info.excludedTools).toContain("apply_diff")
			expect(modelInfo.info.includedTools).toContain("edit")
		})

		it("should not duplicate tool entries if already present", () => {
			const testHandler = new VertexHandler({
				apiModelId: "gemini-2.0-flash-001",
				vertexProjectId: "test-project",
				vertexRegion: "us-central1",
			})

			const modelInfo = testHandler.getModel()
			const excludedCount = modelInfo.info.excludedTools!.filter((t: string) => t === "apply_diff").length
			const includedCount = modelInfo.info.includedTools!.filter((t: string) => t === "edit").length
			expect(excludedCount).toBe(1)
			expect(includedCount).toBe(1)
		})

		it("should route selected model IDs through the Vertex gateway map", () => {
			const testHandler = new VertexHandler({
				apiModelId: "gemini-3-flash-preview",
				vertexProjectId: "test-project",
				vertexRegion: "global",
				vertexGatewayModelRoutingMap: '{"gemini-3-flash-preview":"gateway-gemini-flash"}',
			})

			expect(testHandler.getModel().id).toBe("gemini-3-flash-preview")
		})

		it("should pass through unknown Vertex Gemini model IDs with Gemini defaults", () => {
			const testHandler = new VertexHandler({
				apiModelId: "gemini-new-preview-model",
				vertexProjectId: "test-project",
				vertexRegion: "global",
			})

			const modelInfo = testHandler.getModel()

			expect(modelInfo.id).toBe("gemini-new-preview-model")
			expect(modelInfo.info.maxTokens).toBeDefined()
		})
	})

	describe("gateway auth", () => {
		it("should parse raw Helix stdout as the bearer token", async () => {
			mockExecFile.mockImplementation((file, args, options, callback) => {
				expect(file).toBe("helix")
				expect(args).toEqual(["auth", "access-token", "print", "-a"])
				expect(options).toEqual(
					expect.objectContaining({
						encoding: "utf8",
						windowsHide: true,
					}),
				)
				callback(null, "  access-token-123\n", "")
			})

			await expect(fetchVertexGatewayAccessToken("helix auth access-token print -a")).resolves.toBe(
				"access-token-123",
			)
		})

		it("should reject empty Helix token output", async () => {
			mockExecFile.mockImplementation((_file, _args, _options, callback) => {
				callback(null, "\n", "")
			})

			await expect(fetchVertexGatewayAccessToken("helix auth access-token print -a")).rejects.toThrow(
				"empty access token",
			)
		})

		it("should include Helix command failures in the error message", async () => {
			mockExecFile.mockImplementation((_file, _args, _options, callback) => {
				callback(new Error("not logged in"), "", "")
			})

			await expect(fetchVertexGatewayAccessToken("helix auth access-token print -a")).rejects.toThrow(
				"Vertex gateway Helix command failed: not logged in",
			)
		})

		it("should reject shell operators in the Helix command", async () => {
			await expect(fetchVertexGatewayAccessToken("helix auth access-token print -a && echo bad")).rejects.toThrow(
				"shell operators",
			)
			expect(mockExecFile).not.toHaveBeenCalled()
		})

		it("should set token expiry from the configured refresh interval", async () => {
			const nowSpy = vitest.spyOn(Date, "now").mockReturnValue(1_000)
			mockExecFile.mockImplementation((_file, _args, _options, callback) => {
				callback(null, "access-token-123", "")
			})

			const refreshHandler = createVertexGatewayRefreshHandler({
				vertexGatewayHelixCommand: "helix auth access-token print -a",
				vertexGatewayTokenRefreshMinutes: 5,
			})

			await expect(refreshHandler()).resolves.toEqual({
				access_token: "access-token-123",
				expiry_date: 301_000,
			})

			nowSpy.mockRestore()
		})

		it("should cache Helix tokens until the configured refresh interval expires", async () => {
			const nowSpy = vitest.spyOn(Date, "now").mockReturnValue(1_000)
			mockExecFile
				.mockImplementationOnce((_file, _args, _options, callback) => {
					callback(null, "access-token-1", "")
				})
				.mockImplementationOnce((_file, _args, _options, callback) => {
					callback(null, "access-token-2", "")
				})

			const refreshHandler = createVertexGatewayRefreshHandler({
				vertexGatewayHelixCommand: "helix auth access-token print -a",
				vertexGatewayTokenRefreshMinutes: 5,
			})

			await expect(refreshHandler()).resolves.toEqual({
				access_token: "access-token-1",
				expiry_date: 301_000,
			})

			nowSpy.mockReturnValue(300_999)
			await expect(refreshHandler()).resolves.toEqual({
				access_token: "access-token-1",
				expiry_date: 301_000,
			})

			nowSpy.mockReturnValue(301_000)
			await expect(refreshHandler()).resolves.toEqual({
				access_token: "access-token-2",
				expiry_date: 601_000,
			})

			expect(mockExecFile).toHaveBeenCalledTimes(2)
			nowSpy.mockRestore()
		})
	})
})

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name]
		return
	}

	process.env[name] = value
}
