import { describe, expect, it } from "vitest"

import { createAgentResponse } from "../../agent/AgentResponse"
import {
	buildCanonicalAnthropicAssistantHistoryContent,
	buildCanonicalAssistantHistoryContent,
	buildCanonicalAssistantHistoryItems,
} from "../canonicalAssistantHistory"

describe("buildCanonicalAssistantHistoryContent", () => {
	it("preserves reasoning positions and signatures in the canonical history projection", () => {
		const response = createAgentResponse([
			{ type: "text", text: "Before. " },
			{ type: "reasoning", text: "First reasoning.", signature: "signature-1" },
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "reasoning", text: "Second reasoning.", signature: "signature-2" },
			{ type: "text", text: "After." },
		])

		expect(buildCanonicalAssistantHistoryItems(response)).toEqual([
			{ type: "text", text: "Before. " },
			{ type: "reasoning", text: "First reasoning.", signature: "signature-1" },
			{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
			{ type: "reasoning", text: "Second reasoning.", signature: "signature-2" },
			{ type: "text", text: "After." },
		])
	})

	it("preserves text and tool call order across the provider history boundary", () => {
		const response = createAgentResponse([
			{ type: "text", text: "Checking " },
			{ type: "text", text: "the file. " },
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "reasoning", text: "Private reasoning", signature: "provider-signature" },
			{ type: "text", text: "Then checking another. " },
			{ type: "tool_call", id: "call-2", name: "read_file", arguments: { path: "b.ts" } },
		])
		response.text = "Stale UI projection"
		response.toolCalls = []

		expect(buildCanonicalAssistantHistoryContent(response)).toEqual([
			{ type: "text", text: "Checking the file. " },
			{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
			{ type: "text", text: "Then checking another. " },
			{ type: "tool_use", id: "call-2", name: "read_file", input: { path: "b.ts" } },
		])
	})

	it("groups contiguous reasoning chunks and carries the final signature", () => {
		const response = createAgentResponse([
			{ type: "text", text: "Before." },
			{ type: "reasoning", text: "Thinking " },
			{ type: "reasoning", text: "through it.", signature: "final-signature" },
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "reasoning", text: "After the tool.", signature: "second-signature" },
		])

		expect(buildCanonicalAssistantHistoryItems(response)).toEqual([
			{ type: "text", text: "Before." },
			{ type: "reasoning", text: "Thinking through it.", signature: "final-signature" },
			{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
			{ type: "reasoning", text: "After the tool.", signature: "second-signature" },
		])
	})

	it("projects signed Anthropic thinking blocks in response order and rejects incomplete signatures", () => {
		const response = createAgentResponse([
			{ type: "text", text: "Before." },
			{ type: "reasoning", text: "Thinking " },
			{ type: "reasoning", text: "through it.", signature: "final-signature" },
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "reasoning", text: "After the tool.", signature: "second-signature" },
		])

		expect(buildCanonicalAnthropicAssistantHistoryContent(response)).toEqual([
			{ type: "text", text: "Before." },
			{ type: "thinking", thinking: "Thinking through it.", signature: "final-signature" },
			{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
			{ type: "thinking", thinking: "After the tool.", signature: "second-signature" },
		])

		const incomplete = createAgentResponse([
			{ type: "reasoning", text: "Unsigned reasoning" },
			{ type: "text", text: "Answer." },
		])
		expect(buildCanonicalAnthropicAssistantHistoryContent(incomplete)).toBeUndefined()
	})

	it("retains adjacent signed reasoning blocks as separate provider items", () => {
		const response = createAgentResponse([
			{ type: "reasoning", text: "First block.", signature: "first-signature" },
			{ type: "reasoning", text: "Second " },
			{ type: "reasoning", text: "block.", signature: "second-signature" },
			{ type: "text", text: "Answer." },
		])

		expect(buildCanonicalAnthropicAssistantHistoryContent(response)).toEqual([
			{ type: "thinking", thinking: "First block.", signature: "first-signature" },
			{ type: "thinking", thinking: "Second block.", signature: "second-signature" },
			{ type: "text", text: "Answer." },
		])
	})

	it("does not apply an earlier signature to a following unsigned reasoning block", () => {
		const response = createAgentResponse([
			{ type: "reasoning", text: "Signed block.", signature: "first-signature" },
			{ type: "reasoning", text: "Incomplete block." },
			{ type: "text", text: "Answer." },
		])

		expect(buildCanonicalAnthropicAssistantHistoryContent(response)).toBeUndefined()
		expect(buildCanonicalAssistantHistoryItems(response)).toEqual(response.items)
	})

	it("deduplicates tool calls by persisted ID without losing adjacent text", () => {
		const response = createAgentResponse([
			{ type: "tool_call", id: "call 1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "text", text: "Next." },
			{ type: "tool_call", id: "call_1", name: "read_file", arguments: { path: "b.ts" } },
		])

		expect(buildCanonicalAssistantHistoryContent(response)).toEqual([
			{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
			{ type: "text", text: "Next." },
		])
	})
})
