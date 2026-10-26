import type { Anthropic } from "@anthropic-ai/sdk"
import { OpenRouterHandler } from "../openrouter"
import type { ApiStream, ApiStreamChunk } from "../../transform/stream"

const { create } = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return { chat: { completions: { create } }, responses: { create: vi.fn() } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})

const tool = { id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }

function provider(streaming = true): OpenRouterHandler {
	return new OpenRouterHandler({ openRouterApiKey: "test-key", openRouterStreamingEnabled: streaming })
}

async function collect(stream: ApiStream): Promise<ApiStreamChunk[]> {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

function streamDetails(groups: unknown[][], finishReason = "stop") {
	return (async function* () {
		for (const reasoning_details of groups) {
			yield { choices: [{ delta: { reasoning_details }, finish_reason: null }] }
		}
		yield {
			choices: [
				{
					delta:
						finishReason === "tool_calls" ? { tool_calls: [{ ...tool, index: 0 }] } : { content: "Done." },
					finish_reason: finishReason,
				},
			],
		}
	})()
}

describe("OpenRouter streamed reasoning reconstruction", () => {
	beforeEach(() => create.mockReset())

	it("replays one logical summary after JSON reload so the second turn accepts the reasoning block count", async () => {
		const encrypted = [
			{ type: "reasoning.encrypted", data: "encrypted-1", id: "enc-1", format: "openai-responses-v1", index: 0 },
			{ type: "reasoning.encrypted", data: "encrypted-2", id: "enc-2", format: "openai-responses-v1", index: 0 },
		]
		create.mockResolvedValueOnce(
			streamDetails(
				[
					[{ type: "reasoning.summary", summary: "Read", id: null, index: 0, extra: { opaque: "kept" } }],
					[
						{
							type: "reasoning.summary",
							summary: " the",
							id: "summary-1",
							format: "openai-responses-v1",
							index: 0,
						},
					],
					[
						{
							type: "reasoning.summary",
							summary: " file.",
							id: "summary-1",
							format: "openai-responses-v1",
							index: 0,
						},
					],
					encrypted,
				],
				"tool_calls",
			),
		)
		const first = provider()
		const visible = await collect(first.createMessage("instructions", [], { taskId: "first" }))
		const expected = [
			{
				type: "reasoning.summary",
				summary: "Read the file.",
				id: "summary-1",
				index: 0,
				format: "openai-responses-v1",
				extra: { opaque: "kept" },
			},
			...encrypted,
		]
		const history: (Anthropic.Messages.MessageParam & { reasoning_details?: unknown[] })[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } }],
				reasoning_details: first.getReasoningDetails(),
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "contents" }] },
		]
		create.mockImplementationOnce(async (request) => {
			const assistant = request.messages.find((message: { role: string }) => message.role === "assistant")
			// Model the router's invariant, reported by its official SDK regression #519.
			if (assistant.reasoning_details.length !== expected.length) {
				throw Object.assign(new Error("reasoning_details count mismatch on continuation"), { status: 400 })
			}
			expect(assistant.reasoning_details).toEqual(expected)
			return streamDetails([])
		})
		const reloaded: Anthropic.Messages.MessageParam[] = JSON.parse(JSON.stringify(history))
		const next = await collect(provider().createMessage("instructions", reloaded, { taskId: "second" }))
		expect(next.find((chunk) => chunk.type === "outcome")).toMatchObject({ status: "completed" })
		expect(
			visible
				.filter((chunk) => chunk.type === "reasoning")
				.map((chunk) => chunk.text)
				.join(""),
		).toBe("Read the file.")
	})

	it("attaches late signatures to their text and starts a new block after each signed block", async () => {
		create.mockResolvedValueOnce(
			streamDetails([
				[{ type: "reasoning.text", text: "Read", id: "thinking-1", index: 0 }],
				[{ type: "reasoning.text", text: " carefully", format: "anthropic-claude-v1", index: 0 }],
				[{ type: "reasoning.text", signature: "signed-1", id: "thinking-1", index: 0 }],
				[{ type: "reasoning.text", text: "Then", id: "thinking-2", format: "anthropic-claude-v1", index: 0 }],
				[{ type: "reasoning.text", text: " check", id: "thinking-2", index: 0 }],
				[{ type: "reasoning.text", signature: "signed-2", id: "thinking-2", index: 0 }],
			]),
		)
		const handler = provider()
		await collect(handler.createMessage("instructions", [], { taskId: "signed" }))
		expect(handler.getReasoningDetails()).toEqual([
			{
				type: "reasoning.text",
				text: "Read carefully",
				signature: "signed-1",
				id: "thinking-1",
				format: "anthropic-claude-v1",
				index: 0,
			},
			{
				type: "reasoning.text",
				text: "Then check",
				signature: "signed-2",
				id: "thinking-2",
				format: "anthropic-claude-v1",
				index: 0,
			},
		])
	})

	it("keeps encrypted and unknown state discrete even when all streamed indices are zero", async () => {
		const encrypted = { type: "reasoning.encrypted", data: "opaque", id: "enc-1", index: 0 }
		const future = { type: "reasoning.future", opaque: { nested: ["preserved"] }, index: 0 }
		create.mockResolvedValueOnce(
			streamDetails([
				[{ type: "reasoning.summary", summary: "a", index: 0 }],
				[{ type: "reasoning.summary", summary: "b", index: 0 }],
				[encrypted, { ...encrypted, data: "different-opaque" }],
				[{ type: "reasoning.summary", summary: "c", index: 0 }],
				[future, { ...future, opaque: { nested: ["also-preserved"] } }],
			]),
		)
		const handler = provider()
		await collect(handler.createMessage("instructions", [], { taskId: "boundaries" }))
		expect(handler.getReasoningDetails()).toEqual([
			{ type: "reasoning.summary", summary: "ab", index: 0 },
			encrypted,
			{ ...encrypted, data: "different-opaque" },
			{ type: "reasoning.summary", summary: "c", index: 0 },
			future,
			{ ...future, opaque: { nested: ["also-preserved"] } },
		])
	})

	it("preserves complete nonstreaming blocks without merging adjacent summaries", async () => {
		const details = [
			{ type: "reasoning.summary", summary: "first", id: "summary-1", index: 0 },
			{ type: "reasoning.summary", summary: "second", id: "summary-2", index: 1 },
		]
		create.mockResolvedValueOnce({
			choices: [{ message: { content: "Done.", reasoning_details: details }, finish_reason: "stop" }],
		})
		const handler = provider(false)
		await collect(handler.createMessage("instructions", [], { taskId: "complete-blocks" }))
		expect(handler.getReasoningDetails()).toEqual(details)
	})

	it.each(["id", "format"])(
		"preserves distinct concrete %s boundaries without overwriting either value",
		async (key) => {
			const first = { type: "reasoning.summary", summary: "first", index: 0, [key]: "first-value" }
			const second = { type: "reasoning.summary", summary: "second", index: 0, [key]: "second-value" }
			create.mockResolvedValueOnce(streamDetails([[first], [second]]))
			const handler = provider()
			await collect(handler.createMessage("instructions", [], { taskId: "identities" }))
			expect(handler.getReasoningDetails()).toEqual([first, second])
		},
	)

	it("rejects contradictory opaque metadata before tool acceptance instead of guessing replay state", async () => {
		create.mockResolvedValueOnce(
			streamDetails(
				[
					[{ type: "reasoning.summary", summary: "a", id: "summary-1", index: 0, extra: { version: 1 } }],
					[{ type: "reasoning.summary", summary: "b", id: "summary-1", index: 0, extra: { version: 2 } }],
				],
				"tool_calls",
			),
		)
		const handler = provider()
		const seen: ApiStreamChunk[] = []
		await expect(
			(async () => {
				for await (const chunk of handler.createMessage("instructions", [], { taskId: "contradictory" }))
					seen.push(chunk)
			})(),
		).rejects.toThrow("cannot be safely continued")
		expect(handler.getReasoningDetails()).toBeUndefined()
		expect(seen.some((chunk) => chunk.type === "tool_call" || chunk.type === "tool_call_end")).toBe(false)
	})

	it.each([
		{ type: "reasoning.text", text: 42, index: 0 },
		{ type: "reasoning.text", text: "text", signature: { invalid: true }, index: 0 },
	])("rejects malformed known text fragments before sealing state (%j)", async (detail) => {
		create.mockResolvedValueOnce(streamDetails([[detail]], "tool_calls"))
		const handler = provider()
		await expect(collect(handler.createMessage("instructions", [], { taskId: "malformed" }))).rejects.toThrow(
			"cannot be safely continued",
		)
		expect(handler.getReasoningDetails()).toBeUndefined()
	})

	it("clears pending reconstruction before reusing an adapter for another response", async () => {
		create.mockResolvedValueOnce(streamDetails([[{ type: "reasoning.summary", summary: "first", index: 0 }]]))
		create.mockResolvedValueOnce(streamDetails([[{ type: "reasoning.summary", summary: "second", index: 0 }]]))
		const handler = provider()
		await collect(handler.createMessage("instructions", [], { taskId: "first" }))
		await collect(handler.createMessage("instructions", [], { taskId: "second" }))
		expect(handler.getReasoningDetails()).toEqual([{ type: "reasoning.summary", summary: "second", index: 0 }])
	})
})
