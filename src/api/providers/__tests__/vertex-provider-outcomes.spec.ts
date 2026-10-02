import type { Anthropic } from "@anthropic-ai/sdk"

import { collectAgentResponse } from "../../../core/agent/AgentResponseAccumulator"
import type { ApiStream, ApiStreamChunk } from "../../transform/stream"
import { AnthropicVertexHandler } from "../anthropic-vertex"
import { VertexHandler } from "../vertex"

const { geminiStream, geminiResponse, claudeCreate } = vi.hoisted(() => ({
	geminiStream: vi.fn(),
	geminiResponse: vi.fn(),
	claudeCreate: vi.fn(),
}))

vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@google/genai")>()),
	GoogleGenAI: vi.fn(() => ({
		models: { generateContentStream: geminiStream, generateContent: geminiResponse },
	})),
}))
vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(() => ({ messages: { create: claudeCreate } })),
}))

const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Inspect the project" }]
const metadata = { taskId: "terminal-fixture", requestId: "request-fixture", attemptId: "attempt-fixture" }

async function* fixtureStream<T>(chunks: readonly T[]) {
	yield* chunks
}

async function collect(stream: ApiStream) {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return { chunks, response: await collectAgentResponse(fixtureStream(chunks)) }
}

function gemini(streaming = true) {
	return new VertexHandler({
		apiModelId: "gemini-3.5-flash",
		vertexProjectId: "fixture-project",
		vertexRegion: "global",
		vertexStreamingEnabled: streaming,
	})
}

function claude(streaming = true) {
	return new AnthropicVertexHandler({
		apiModelId: "claude-sonnet-4-6",
		vertexProjectId: "fixture-project",
		vertexRegion: "global",
		vertexStreamingEnabled: streaming,
	})
}

describe("Vertex provider terminal outcomes", () => {
	beforeEach(() => {
		geminiStream.mockReset()
		geminiResponse.mockReset()
		claudeCreate.mockReset()
	})

	// Codex CLI cb6da58876afed3ede0ab11084f67dd5394ecb48 rejects EOF without
	// response.completed in codex-api/src/sse/responses.rs and stream_no_completed.rs.
	it.each([
		{ label: "text", parts: [{ text: "A partial answer" }], semantic: true },
		{ label: "reasoning", parts: [{ thought: true, text: "Still investigating" }], semantic: true },
		{ label: "no output", parts: [], semantic: false },
	])("Gemini reports $label EOF without a finish reason as incomplete", async ({ parts, semantic }) => {
		geminiStream.mockResolvedValue(fixtureStream([{ candidates: [{ content: { parts } }] }]))
		const { chunks, response } = await collect(gemini().createMessage("System", messages, metadata))

		expect(response.outcome?.status).toBe("incomplete")
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({
				status: "incomplete",
				terminal: false,
				semanticOutputObserved: semantic,
				requestId: metadata.requestId,
				attemptId: metadata.attemptId,
			}),
		])
		expect(geminiStream).toHaveBeenCalledOnce()
	})

	it.each([true, false])("Gemini preserves token-limit incompletion with streaming=%s", async (streaming) => {
		const result = {
			candidates: [{ content: { parts: [{ text: "The answer was cut off" }] }, finishReason: "MAX_TOKENS" }],
			usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 17, thoughtsTokenCount: 3 },
		}
		geminiStream.mockResolvedValue(fixtureStream([result]))
		geminiResponse.mockResolvedValue(result)
		const { chunks, response } = await collect(gemini(streaming).createMessage("System", messages, metadata))

		expect(response.text).toBe("The answer was cut off")
		expect(response.outcome).toMatchObject({ status: "incomplete", reason: expect.stringMatching(/token limit/i) })
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "usage", inputTokens: 11, outputTokens: 17, reasoningTokens: 3 }),
		)
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toHaveLength(1)
	})

	it.each([
		{ label: "text", block: { type: "text", text: "A partial answer" }, semantic: true },
		{
			label: "reasoning",
			block: { type: "thinking", thinking: "Still investigating", signature: "sig" },
			semantic: true,
		},
		{ label: "no output", block: undefined, semantic: false },
	])("Anthropic reports $label EOF without message_stop as incomplete", async ({ block, semantic }) => {
		claudeCreate.mockResolvedValue(
			fixtureStream([
				...(block ? [{ type: "content_block_start", index: 0, content_block: block }] : []),
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
			]),
		)
		const { chunks, response } = await collect(claude().createMessage("System", messages, metadata))

		expect(response.outcome?.status).toBe("incomplete")
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({
				status: "incomplete",
				terminal: false,
				semanticOutputObserved: semantic,
				requestId: metadata.requestId,
				attemptId: metadata.attemptId,
			}),
		])
		expect(claudeCreate).toHaveBeenCalledOnce()
	})

	it.each([true, false])("Anthropic preserves token-limit incompletion with streaming=%s", async (streaming) => {
		claudeCreate.mockResolvedValue(
			streaming
				? fixtureStream([
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Cut off" } },
						{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 17 } },
						{ type: "message_stop" },
					])
				: {
						content: [{ type: "text", text: "Cut off" }],
						stop_reason: "max_tokens",
						usage: { input_tokens: 11, output_tokens: 17 },
					},
		)
		const { chunks, response } = await collect(claude(streaming).createMessage("System", messages, metadata))

		expect(response.text).toBe("Cut off")
		expect(response.outcome).toMatchObject({ status: "incomplete", reason: expect.stringMatching(/token limit/i) })
		expect(chunks).toContainEqual(expect.objectContaining({ type: "usage", outputTokens: 17 }))
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toHaveLength(1)
	})

	it.each(["SAFETY", "MALFORMED_FUNCTION_CALL", "OTHER", "NEW_PROVIDER_REASON"])(
		"Gemini does not report %s as successful completion",
		async (finishReason) => {
			geminiStream.mockResolvedValue(
				fixtureStream([{ candidates: [{ content: { parts: [{ text: "Partial output" }] }, finishReason }] }]),
			)
			const { chunks, response } = await collect(gemini().createMessage("System", messages, metadata))
			expect(response.outcome).toMatchObject({ status: "incomplete", retryable: false })
			expect(chunks).toContainEqual(
				expect.objectContaining({ type: "outcome", terminal: true, semanticOutputObserved: true }),
			)
		},
	)

	it.each(["STOP", "FINISH_REASON_STOP"])(
		"Gemini preserves tool, signature, response ID, and usage for %s",
		async (finishReason) => {
			geminiStream.mockResolvedValue(
				fixtureStream([
					{
						candidates: [
							{
								content: {
									parts: [
										{
											thought: true,
											text: "Read the source",
											thoughtSignature: "signature-fixture",
										},
										{
											functionCall: {
												id: "gemini-call-fixture",
												name: "read_file",
												args: { path: "src/index.ts" },
											},
										},
									],
								},
								finishReason,
							},
						],
						responseId: "gemini-response-fixture",
						usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 17, thoughtsTokenCount: 3 },
					},
				]),
			)
			const handler = gemini()
			const { chunks, response } = await collect(
				handler.createMessage("System", messages, {
					...metadata,
					tools: [
						{
							type: "function",
							function: { name: "read_file", parameters: { type: "object", properties: {} } },
						},
					],
				}),
			)
			expect(response.outcome?.status).toBe("completed")
			expect(response.toolCalls).toEqual([
				{
					type: "tool_call",
					id: "gemini-call-fixture",
					name: "read_file",
					arguments: { path: "src/index.ts" },
				},
			])
			expect(response.reasoning).toBe("Read the source")
			expect(handler.getThoughtSignature()).toBe("signature-fixture")
			expect(handler.getResponseId()).toBe("gemini-response-fixture")
			expect(chunks.filter((chunk) => chunk.type === "outcome")).toHaveLength(1)
		},
	)

	it.each(["end_turn", "stop_sequence", "tool_use", "refusal", "pause_turn"])(
		"Anthropic distinguishes successful response ending %s from turn continuation",
		async (stopReason) => {
			claudeCreate.mockResolvedValue(
				fixtureStream([
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Observed output" } },
					{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 17 } },
					{ type: "message_stop" },
				]),
			)
			const { chunks, response } = await collect(claude().createMessage("System", messages, metadata))
			expect(response.outcome?.status).toBe("completed")
			expect(response.outcome?.requiresContinuation).toBe(stopReason === "pause_turn" ? true : undefined)
			expect(chunks.filter((chunk) => chunk.type === "outcome")).toHaveLength(1)
		},
	)

	it.each([undefined, "NEW_PROVIDER_REASON", "model_context_window_exceeded"])(
		"Anthropic does not complete a stopped response with stop_reason=%s",
		async (stopReason) => {
			claudeCreate.mockResolvedValue(
				fixtureStream([
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Partial output" } },
					{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 17 } },
					{ type: "message_stop" },
				]),
			)
			const { chunks, response } = await collect(claude().createMessage("System", messages, metadata))
			expect(response.outcome).toMatchObject({ status: "incomplete", retryable: false })
			expect(chunks).toContainEqual(expect.objectContaining({ type: "outcome", terminal: true }))
		},
	)

	it("Anthropic preserves a closed tool call and signature and releases the iterator at message_stop", async () => {
		const released = vi.fn()
		claudeCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				try {
					yield* [
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "thinking", thinking: "Read the source", signature: "" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "signature_delta", signature: "signature-fixture" },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "content_block_start",
							index: 1,
							content_block: {
								type: "tool_use",
								id: "claude-call-fixture",
								name: "read_file",
								input: { path: "src/index.ts" },
							},
						},
						{ type: "content_block_stop", index: 1 },
						{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } },
						{ type: "message_stop" },
					]
					throw new Error("The adapter read past message_stop")
				} finally {
					released()
				}
			},
		})
		const handler = claude()
		const { chunks, response } = await collect(handler.createMessage("System", messages, metadata))
		expect(response.outcome?.status).toBe("completed")
		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "claude-call-fixture", name: "read_file", arguments: { path: "src/index.ts" } },
		])
		expect(handler.getThoughtSignature()).toBe("signature-fixture")
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toHaveLength(1)
		expect(released).toHaveBeenCalledOnce()
	})

	it("Anthropic cannot turn an unfinished tool block into a completed response", async () => {
		claudeCreate.mockResolvedValue(
			fixtureStream([
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "partial-call", name: "read_file", input: {} },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"path":' },
				},
				{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } },
				{ type: "message_stop" },
			]),
		)
		const { chunks, response } = await collect(claude().createMessage("System", messages, metadata))
		expect(response.outcome?.status).not.toBe("completed")
		expect(response.toolCalls).toEqual([])
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "outcome", status: "incomplete", terminal: true, retryable: false }),
		)
		expect(chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([])
	})

	it.each(["Gemini", "Anthropic"])("%s requires a stop reason in non-streaming responses", async (provider) => {
		geminiResponse.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "Partial output" }] } }] })
		claudeCreate.mockResolvedValue({ content: [{ type: "text", text: "Partial output" }] })
		const handler = provider === "Gemini" ? gemini(false) : claude(false)
		const { response } = await collect(handler.createMessage("System", messages, metadata))
		expect(response.text).toBe("Partial output")
		expect(response.outcome?.status).toBe("incomplete")
	})

	it.each(["Gemini", "Anthropic"])("%s keeps a reasoning-only token limit incomplete", async (provider) => {
		geminiStream.mockResolvedValue(
			fixtureStream([
				{
					candidates: [
						{
							content: { parts: [{ thought: true, text: "Still investigating" }] },
							finishReason: "MAX_TOKENS",
						},
					],
					usageMetadata: { promptTokenCount: 11, thoughtsTokenCount: 17 },
				},
			]),
		)
		claudeCreate.mockResolvedValue(
			fixtureStream([
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "Still investigating", signature: "sig" },
				},
				{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 17 } },
				{ type: "message_stop" },
			]),
		)
		const handler = provider === "Gemini" ? gemini() : claude()
		const { chunks, response } = await collect(handler.createMessage("System", messages, metadata))
		expect(response.reasoning).toBe("Still investigating")
		expect(response.outcome).toMatchObject({ status: "incomplete", retryable: false })
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "outcome", terminal: true, semanticOutputObserved: true }),
		)
	})
})
