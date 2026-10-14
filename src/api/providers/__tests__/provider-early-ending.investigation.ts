import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiStreamChunk } from "../../transform/stream"
import { AgentTurnEngine, collectAgentResponse } from "../../../core/agent/AgentTurnEngine"

const { googleClient, anthropicCreate } = vi.hoisted(() => ({
	googleClient: { models: { generateContentStream: vi.fn(), generateContent: vi.fn() } },
	anthropicCreate: vi.fn(),
}))

vi.mock("vscode", () => ({
	workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn(() => 600) })) },
}))
vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@google/genai")>()),
	GoogleGenAI: vi.fn(() => googleClient),
}))
vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(() => ({ messages: { create: anthropicCreate } })),
}))

import { VertexHandler } from "../vertex"
import { AnthropicVertexHandler } from "../anthropic-vertex"

// Isolated desired-behavior probes. The production adapter, accumulator, and
// turn engine run unchanged; only SDK response transport is deterministic.
async function observeTurn(stream: AsyncGenerator<ApiStreamChunk>) {
	const response = await collectAgentResponse(stream)
	const result = await new AgentTurnEngine<string>({
		shouldAbort: () => false,
		runStep: async () => ({ response, nextInput: "complete" as const }),
	}).run("initial")
	return { response, result }
}

const userInput = [{ role: "user" as const, content: "Implement all 100 requirements in the attached specification." }]

describe("provider premature-ending investigation", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each([true, false])("Gemini output limit cannot complete partial scope (streaming=%s)", async (streaming) => {
		const packet = {
			candidates: [
				{
					content: { parts: [{ text: "Implemented requirements 1 through 10." }] },
					finishReason: "MAX_TOKENS",
				},
			],
		}
		googleClient.models.generateContent.mockResolvedValue(packet)
		googleClient.models.generateContentStream.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield packet
			},
		})
		const handler = new VertexHandler({
			apiModelId: "gemini-3.5-flash",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
			vertexStreamingEnabled: streaming,
		})
		const { response, result } = await observeTurn(handler.createMessage("Finish the complete scope.", userInput))
		expect(response.text).toContain("requirements 1 through 10")
		expect(result.status).toBe("incomplete")
	})

	it.each([true, false])("Anthropic output limit cannot complete partial scope (streaming=%s)", async (streaming) => {
		anthropicCreate.mockResolvedValue(
			streaming
				? {
						async *[Symbol.asyncIterator]() {
							yield {
								type: "content_block_start",
								index: 0,
								content_block: { type: "text", text: "Implemented requirements 1 through 10." },
							}
							yield {
								type: "message_delta",
								delta: { stop_reason: "max_tokens" },
								usage: { output_tokens: 8192 },
							}
							yield { type: "message_stop" }
						},
					}
				: {
						content: [{ type: "text", text: "Implemented requirements 1 through 10." }],
						stop_reason: "max_tokens",
						usage: { input_tokens: 20, output_tokens: 8192 },
					},
		)
		const handler = new AnthropicVertexHandler({
			apiModelId: "claude-sonnet-4-6",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
			vertexStreamingEnabled: streaming,
		})
		const { response, result } = await observeTurn(handler.createMessage("Finish the complete scope.", userInput))
		expect(response.text).toContain("requirements 1 through 10")
		expect(result.status).toBe("incomplete")
	})

	it("Gemini EOF after partial text cannot stand in for a terminal response", async () => {
		googleClient.models.generateContentStream.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { candidates: [{ content: { parts: [{ text: "Partial implementation." }] } }] }
			},
		})
		const handler = new VertexHandler({
			apiModelId: "gemini-3.5-flash",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
		})
		const { result } = await observeTurn(handler.createMessage("Finish the complete scope.", userInput))
		expect(result.status).toBe("incomplete")
	})

	it("Anthropic EOF after partial text cannot stand in for message_stop", async () => {
		anthropicCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "Partial implementation." },
				}
			},
		})
		const handler = new AnthropicVertexHandler({
			apiModelId: "claude-sonnet-4-6",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
		})
		const { result } = await observeTurn(handler.createMessage("Finish the complete scope.", userInput))
		expect(result.status).toBe("incomplete")
	})

	it.each([true, false])(
		"Gemini empty safety response cannot become a successful assistant turn (streaming=%s)",
		async (streaming) => {
			const packet = { candidates: [{ finishReason: "SAFETY" }] }
			googleClient.models.generateContent.mockResolvedValue(packet)
			googleClient.models.generateContentStream.mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield packet
				},
			})
			const handler = new VertexHandler({
				apiModelId: "gemini-3.5-flash",
				vertexProjectId: "test-project",
				vertexRegion: "us-central1",
				vertexStreamingEnabled: streaming,
			})
			const { result } = await observeTurn(handler.createMessage("Finish the complete scope.", userInput))
			expect(result.status).not.toBe("completed")
		},
	)

	it.each(["gemini", "anthropic"])("ordinary terminal assistant text can still complete (%s)", async (provider) => {
		googleClient.models.generateContentStream.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield {
					candidates: [
						{ content: { parts: [{ text: "All requirements implemented." }] }, finishReason: "STOP" },
					],
				}
			},
		})
		anthropicCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "All requirements implemented." },
				}
				yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }
				yield { type: "message_stop" }
			},
		})
		const handler =
			provider === "gemini"
				? new VertexHandler({
						apiModelId: "gemini-3.5-flash",
						vertexProjectId: "test-project",
						vertexRegion: "us-central1",
					})
				: new AnthropicVertexHandler({
						apiModelId: "claude-sonnet-4-6",
						vertexProjectId: "test-project",
						vertexRegion: "us-central1",
					})
		const { result } = await observeTurn(handler.createMessage("Finish the complete scope.", userInput))
		expect(result.status).toBe("completed")
	})
})
