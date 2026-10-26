import type { Anthropic } from "@anthropic-ai/sdk"
import { convertToOpenAiMessages } from "../openai-format"

describe("OpenRouter reasoning history conversion", () => {
	const details = [
		{ type: "reasoning.summary", summary: "Use the tool", id: "rs-1", index: 0, format: "openai-responses-v1" },
		{ type: "reasoning.encrypted", data: "opaque", id: "rs-2", index: 1, format: "openai-responses-v1" },
		{ type: "reasoning.text", text: "Check it", signature: "signed", index: 2, format: "anthropic-claude-v1" },
	]

	it.each<{ content: Anthropic.Messages.MessageParam["content"] }>([
		{ content: "a previous answer" },
		{ content: [{ type: "text", text: "a previous answer" }] },
	])("preserves every opaque field for string and block content", ({ content }) => {
		const history: (Anthropic.Messages.MessageParam & { reasoning_details: unknown[] })[] = [
			{ role: "assistant", content, reasoning_details: details },
		]
		const result = convertToOpenAiMessages(history, { preserveReasoningDetails: true })
		expect(result).toEqual([{ role: "assistant", content: "a previous answer", reasoning_details: details }])
		expect(history[0]).toHaveProperty("reasoning_details", details)
	})

	it("keeps the original sequence beside its tool call and matching result", () => {
		const history: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } }],
				reasoning_details: details,
			} as Anthropic.Messages.MessageParam,
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "contents" }] },
		]
		const converted = convertToOpenAiMessages(history, { preserveReasoningDetails: true })
		expect(converted).toEqual([
			{
				role: "assistant",
				content: "",
				reasoning_details: details,
				tool_calls: [
					{ type: "function", id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
				],
			},
			{ role: "tool", content: "contents", tool_call_id: "call-1" },
		])
	})

	it("retains compatible endpoint normalization unless explicitly opted out", () => {
		const history: (Anthropic.Messages.MessageParam & { reasoning_details: unknown[] })[] = [
			{ role: "assistant", content: "answer", reasoning_details: details },
		]
		expect(convertToOpenAiMessages(history)[0]).toMatchObject({
			reasoning_details: [
				{ type: "reasoning.summary", summary: "Use the tool", index: 0, format: "openai-responses-v1" },
				{ type: "reasoning.encrypted", data: "opaque", index: 1, format: "openai-responses-v1" },
				details[2],
			],
		})
		expect(convertToOpenAiMessages(history)[0]).not.toHaveProperty("reasoning_details.0.id")
		expect(details[0].id).toBe("rs-1")
	})
})
