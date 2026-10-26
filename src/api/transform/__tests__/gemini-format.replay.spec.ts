import type { Anthropic } from "@anthropic-ai/sdk"
import { convertAnthropicMessageToGemini, convertAnthropicMessagesToGemini } from "../gemini-format"

const modelId = "gemini-4-argon"

function history(parts: unknown[], calls: Anthropic.ToolUseBlockParam[] = []): Anthropic.MessageParam {
	// Exercise the same untrusted JSON boundary used by persisted transcripts.
	return JSON.parse(
		JSON.stringify({
			role: "assistant",
			content: [
				{ type: "text", text: "Visible projection" },
				...calls,
				{ type: "gemini_response", geminiResponse: { modelId, parts } },
			],
		}),
	)
}

describe("Gemini canonical response replay", () => {
	it("preserves signed text and thought boundaries, empty signature parts and opaque metadata", () => {
		const parts = [
			{ thought: true, text: "Think", thoughtSignature: "thought-signature", providerMetadata: { version: 1 } },
			{ text: "First" },
			{ text: "Second", thoughtSignature: "text-signature" },
			{ text: "", thoughtSignature: "empty-signature" },
		]
		const message = history(parts)
		const result = convertAnthropicMessageToGemini(message, { modelId })
		expect(result).toEqual([{ role: "model", parts }])
		result[0]!.parts![0]!.text = "Changed"
		expect(convertAnthropicMessageToGemini(message, { modelId })).toEqual([{ role: "model", parts }])
	})

	it("preserves parallel function signatures and restores original IDs for results", () => {
		const parts = [
			{ text: "Inspecting" },
			{
				functionCall: { id: "call.one", name: "read_file", args: { path: "one.ts" } },
				thoughtSignature: "signature",
			},
			{ functionCall: { id: "call.two", name: "read_file", args: { path: "two.ts" } } },
		]
		const message = history(parts, [
			{ type: "tool_use", id: "call_one", name: "read_file", input: { path: "one.ts" } },
			{ type: "tool_use", id: "call_two", name: "read_file", input: { path: "two.ts" } },
		])
		const result = convertAnthropicMessagesToGemini(
			[
				message,
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_one", content: "one" },
						{ type: "tool_result", tool_use_id: "call_two", content: "two" },
					],
				},
			],
			{ modelId },
		)
		expect(result[0]).toEqual({ role: "model", parts })
		expect(result[1]!.parts).toEqual([
			{
				functionResponse: {
					id: "call.one",
					name: "read_file",
					response: { name: "read_file", content: "one" },
				},
			},
			{
				functionResponse: {
					id: "call.two",
					name: "read_file",
					response: { name: "read_file", content: "two" },
				},
			},
		])
	})

	it("does not add synthetic host IDs to a provider call or its result", () => {
		const parts = [{ functionCall: { name: "list_tools" }, thoughtSignature: "signature" }]
		const message = history(parts, [{ type: "tool_use", id: "list_tools-0", name: "list_tools", input: {} }])
		const result = convertAnthropicMessagesToGemini(
			[
				message,
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "list_tools-0", content: "tools" }] },
			],
			{ modelId },
		)
		expect(result[0]).toEqual({ role: "model", parts })
		expect(result[1]!.parts?.[0]?.functionResponse).not.toHaveProperty("id")
	})

	it("falls back to canonical visible history when selecting a different model", () => {
		const message = history([{ text: "Provider original", thoughtSignature: "old-model-signature" }])
		expect(convertAnthropicMessageToGemini(message, { modelId: "gemini-3.8-flash" })).toEqual([
			{ role: "model", parts: [{ text: "Visible projection" }] },
		])
	})

	it("rejects altered canonical tool arguments before replaying signed state", () => {
		const message = history(
			[{ functionCall: { name: "read_file", args: { path: "old.ts" } }, thoughtSignature: "signature" }],
			[{ type: "tool_use", id: "read_file-0", name: "read_file", input: { path: "changed.ts" } }],
		)
		expect(() => convertAnthropicMessageToGemini(message, { modelId })).toThrow(/does not match/)
	})

	it("rejects malformed persisted replay state", () => {
		const message: Anthropic.MessageParam = JSON.parse(
			JSON.stringify({
				role: "assistant",
				content: [{ type: "gemini_response", geminiResponse: { modelId, parts: "invalid" } }],
			}),
		)
		expect(() => convertAnthropicMessageToGemini(message, { modelId })).toThrow(/Invalid Gemini response/)
	})
})
