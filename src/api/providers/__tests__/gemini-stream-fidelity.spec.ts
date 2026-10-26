import type { Anthropic } from "@anthropic-ai/sdk"
import type { ApiHandler } from "../../index"
import type { ApiStreamChunk } from "../../transform/stream"
import { convertAnthropicMessagesToGemini } from "../../transform/gemini-format"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"
import { GeminiHandler } from "../gemini-native"
import { VertexHandler } from "../vertex"
import i18next from "../../../i18n"
import commonTranslations from "../../../i18n/locales/en/common.json"

const { generateContent, generateContentStream } = vi.hoisted(() => ({
	generateContent: vi.fn(),
	generateContentStream: vi.fn(),
}))

vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@google/genai")>()),
	GoogleGenAI: vi.fn(function () {
		return { models: { generateContent, generateContentStream } }
	}),
}))

const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Inspect the project" }]
const routes: Array<{ name: string; create(): ApiHandler }> = [
	{ name: "native", create: () => new GeminiHandler({ geminiApiKey: "fixture-key" }) },
	{
		name: "Vertex",
		create: () =>
			new VertexHandler({
				apiModelId: "gemini-3.7-flash",
				vertexProjectId: "fixture-project",
				vertexRegion: "global",
			}),
	},
]

describe("Gemini stream fidelity", () => {
	beforeAll(() => {
		i18next.addResourceBundle("en", "common", commonTranslations, true, true)
	})

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => vi.restoreAllMocks())

	it.each(routes.flatMap((route) => ["completed", "failed", "cancelled"].map((ending) => ({ ...route, ending }))))(
		"retains received usage once when $name ends as $ending",
		async ({ create, ending }) => {
			const controller = new AbortController()
			generateContentStream.mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield {
						candidates: [{ content: { parts: [{ text: "Partial" }] } }],
						usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
					}
					if (ending === "failed") throw new Error("Fixture disconnected")
					yield {
						candidates: [{ content: { parts: [{ text: " answer" }] }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 7, thoughtsTokenCount: 4 },
					}
				},
			})
			const chunks: ApiStreamChunk[] = []
			const consuming = async () => {
				for await (const chunk of create().createMessage("System", messages, {
					taskId: "usage-fixture",
					signal: controller.signal,
				})) {
					chunks.push(chunk)
					if (ending === "cancelled" && chunk.type === "text") controller.abort()
				}
			}

			if (ending === "completed") await consuming()
			else if (ending === "cancelled") await expect(consuming()).rejects.toMatchObject({ name: "AbortError" })
			else await expect(consuming()).rejects.toThrow("Fixture disconnected")

			expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
				expect.objectContaining({
					inputTokens: 17,
					outputTokens: ending === "completed" ? 11 : 8,
					reasoningTokens: ending === "completed" ? 4 : 3,
				}),
			])
		},
	)

	it.each(routes)("does not emit usage from $name after the consumer closes the generator", async ({ create }) => {
		const closed = vi.fn()
		generateContentStream.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				try {
					yield {
						candidates: [{ content: { parts: [{ text: "Partial" }] } }],
						usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 5 },
					}
				} finally {
					closed()
				}
			},
		})
		const stream = create().createMessage("System", messages)
		expect((await stream.next()).value).toEqual({ type: "text", text: "Partial" })

		await expect(stream.return(undefined)).resolves.toEqual({ done: true, value: undefined })
		expect(closed).toHaveBeenCalledOnce()
	})

	it.each(routes)("does not duplicate usage if $name is cancelled after usage delivery", async ({ create }) => {
		generateContentStream.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield {
					candidates: [{ content: { parts: [{ text: "Answer" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 5 },
				}
			},
		})
		const controller = new AbortController()
		const chunks: ApiStreamChunk[] = []
		const consuming = async () => {
			for await (const chunk of create().createMessage("System", messages, {
				taskId: "usage-cancel",
				signal: controller.signal,
			})) {
				chunks.push(chunk)
				if (chunk.type === "usage") controller.abort()
			}
		}

		await expect(consuming()).rejects.toMatchObject({ name: "AbortError" })
		expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
		expect(chunks.some((chunk) => chunk.type === "outcome")).toBe(false)
	})

	it.each([false, true])(
		"replays every Vertex part and signature without relocating or merging them (streaming=%s)",
		async (streaming) => {
			const parts = [
				{ thought: true, text: "Inspecting", thoughtSignature: "thought-signature" },
				{ text: "Checking" },
				{
					functionCall: { id: "call-fixture", name: "read_file", args: { path: "main.ts" } },
					thoughtSignature: "call-signature",
				},
				{ text: "", thoughtSignature: "trailing-signature" },
			]
			const result = { candidates: [{ content: { parts }, finishReason: "STOP" }] }
			generateContent.mockResolvedValue(result)
			generateContentStream.mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield result
				},
			})
			const handler = new VertexHandler({
				apiModelId: "gemini-3.7-flash",
				vertexProjectId: "fixture-project",
				vertexRegion: "global",
				vertexStreamingEnabled: streaming,
			})
			const accumulator = new AgentResponseAccumulator()
			for await (const chunk of handler.createMessage("System", messages)) await accumulator.add(chunk)
			const response = await accumulator.finish()
			const content = buildCanonicalAssistantHistoryContent(response)

			expect(
				convertAnthropicMessagesToGemini([{ role: "assistant", content }], { modelId: handler.getModel().id }),
			).toEqual([{ role: "model", parts }])
			expect(response.toolCalls).toEqual([
				{ type: "tool_call", id: "call-fixture", name: "read_file", arguments: { path: "main.ts" } },
			])
		},
	)

	it("preserves unsigned function parts from an older Vertex model without inventing a signature", async () => {
		const parts = [{ functionCall: { name: "list_tools" } }]
		generateContentStream.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { candidates: [{ content: { parts }, finishReason: "STOP" }] }
			},
		})
		const handler = new VertexHandler({
			apiModelId: "gemini-2.5-flash",
			vertexProjectId: "fixture-project",
			vertexRegion: "global",
		})
		const accumulator = new AgentResponseAccumulator()
		for await (const chunk of handler.createMessage("System", messages)) await accumulator.add(chunk)
		const content = buildCanonicalAssistantHistoryContent(await accumulator.finish())

		expect(
			convertAnthropicMessagesToGemini([{ role: "assistant", content }], { modelId: handler.getModel().id }),
		).toEqual([{ role: "model", parts }])
	})

	it("retains nonstreaming Vertex usage if cancellation interrupts delivery of an accepted tool", async () => {
		const part = { functionCall: { name: "list_tools" }, thoughtSignature: "fixture-signature" }
		generateContent.mockResolvedValue({
			candidates: [{ content: { parts: [part] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 5 },
		})
		const handler = new VertexHandler({
			apiModelId: "gemini-3.7-flash",
			vertexProjectId: "fixture-project",
			vertexRegion: "global",
			vertexStreamingEnabled: false,
		})
		const controller = new AbortController()
		const chunks: ApiStreamChunk[] = []
		const consuming = async () => {
			for await (const chunk of handler.createMessage("System", messages, {
				taskId: "usage-tool-cancel",
				signal: controller.signal,
			})) {
				chunks.push(chunk)
				if (chunk.type === "tool_call_end") controller.abort()
			}
		}

		await expect(consuming()).rejects.toMatchObject({ name: "AbortError" })
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			expect.objectContaining({ inputTokens: 17, outputTokens: 5 }),
		])
		expect(chunks.some((chunk) => chunk.type === "outcome")).toBe(false)
	})
})
