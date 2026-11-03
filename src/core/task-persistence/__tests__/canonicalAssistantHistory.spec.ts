import { describe, expect, it } from "vitest"

import { filterNonAnthropicBlocks } from "../../../api/transform/anthropic-filter"
import { createAgentResponse } from "../../agent/AgentResponse"
import {
	buildCanonicalAnthropicAssistantHistoryContent,
	buildCanonicalAssistantHistoryContent,
	buildCanonicalAssistantHistoryItems,
} from "../canonicalAssistantHistory"

describe("buildCanonicalAssistantHistoryContent", () => {
	it("retains phases, original message IDs, and boundaries in canonical and persisted history", () => {
		const response = createAgentResponse([
			{ type: "text", text: "Checking ", id: "preamble", phase: "commentary", outputIndex: 0 },
			{ type: "text", text: "the file.", id: "preamble", phase: "commentary", outputIndex: 0 },
			{ type: "text", text: "Partial.", id: "partial", phase: "partial_answer", outputIndex: 1 },
			{ type: "text", text: "Final.", id: "final", phase: "final_answer", outputIndex: 2 },
		])
		const expected = [
			{ type: "text", text: "Checking the file.", id: "preamble", phase: "commentary", outputIndex: 0 },
			{ type: "text", text: "Partial.", id: "partial", phase: "partial_answer", outputIndex: 1 },
			{ type: "text", text: "Final.", id: "final", phase: "final_answer", outputIndex: 2 },
		]

		expect(buildCanonicalAssistantHistoryItems(response)).toEqual(expected)
		expect(JSON.parse(JSON.stringify(buildCanonicalAssistantHistoryContent(response)))).toEqual(expected)
		expect(response.items).toHaveLength(4)
		expect(response.text).toBe("Checking the file.Partial.Final.")
	})

	it.each([
		[{ id: "first" }, { id: "second" }],
		[{ outputIndex: 0 }, { outputIndex: 1 }],
		[{ phase: "commentary" as const }, { phase: "final_answer" as const }],
		[{ phase: "commentary" as const }, { phase: "commentary" as const }],
	])("preserves known adjacent boundaries even without all message metadata (%j)", (first, second) => {
		const response = createAgentResponse([
			{ type: "text", text: "First.", ...first },
			{ type: "text", text: "Second.", ...second },
		])

		expect(buildCanonicalAssistantHistoryItems(response)).toEqual(response.items)
		expect(buildCanonicalAssistantHistoryContent(response)).toEqual(response.items)
	})

	it("keeps empty source messages and legacy phase-less text compatibility", () => {
		const response = createAgentResponse([
			{ type: "text", text: "" },
			{ type: "text", text: "Legacy " },
			{ type: "text", text: "answer." },
			{ type: "text", text: "", id: "empty", phase: "commentary", outputIndex: 0 },
			{ type: "text", text: "New.", id: "new", outputIndex: 1 },
		])

		expect(buildCanonicalAssistantHistoryContent(response)).toEqual([
			{ type: "text", text: "Legacy answer." },
			{ type: "text", text: "", id: "empty", phase: "commentary", outputIndex: 0 },
			{ type: "text", text: "New.", id: "new", outputIndex: 1 },
		])
	})

	it("persists source text metadata alongside signed thinking and strips it only on the Anthropic wire", () => {
		const response = createAgentResponse([
			{ type: "reasoning", text: "Thinking.", signature: "signature" },
			{ type: "text", text: "Progress.", id: "progress", phase: "commentary", outputIndex: 1 },
			{ type: "text", text: "Answer.", id: "answer", phase: "final_answer", outputIndex: 2 },
		])

		const persisted = buildCanonicalAnthropicAssistantHistoryContent(response)
		expect(JSON.parse(JSON.stringify(persisted))).toEqual([
			{ type: "thinking", thinking: "Thinking.", signature: "signature" },
			{ type: "text", text: "Progress.", id: "progress", phase: "commentary", outputIndex: 1 },
			{ type: "text", text: "Answer.", id: "answer", phase: "final_answer", outputIndex: 2 },
		])
		expect(filterNonAnthropicBlocks([{ role: "assistant", content: persisted! }])).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Thinking.", signature: "signature" },
					{ type: "text", text: "Progress." },
					{ type: "text", text: "Answer." },
				],
			},
		])
		expect(persisted?.at(-1)).toEqual(response.items.at(-1))
		expect(buildCanonicalAssistantHistoryItems(response).at(-1)).toEqual(response.items.at(-1))
	})

	it("retains each opaque reasoning item without merging bytes, summaries, or adjacent text", () => {
		const summary = [{ type: "summary_text", text: "Original summary." }]
		const response = createAgentResponse([
			{ type: "text", text: "Before." },
			{ type: "reasoning", text: "", encryptedContent: "opaque-1", id: "r1", summary },
			{ type: "reasoning", text: "", encryptedContent: "opaque-2", id: "r2", summary: [] },
			{ type: "tool_call", id: "call", name: "read_file", arguments: {} },
			{ type: "text", text: "After." },
		])
		const content = buildCanonicalAssistantHistoryContent(response)
		summary[0]!.text = "External mutation"

		expect(content).toEqual([
			{ type: "text", text: "Before." },
			{
				type: "reasoning",
				encrypted_content: "opaque-1",
				id: "r1",
				summary: [{ type: "summary_text", text: "Original summary." }],
			},
			{ type: "reasoning", encrypted_content: "opaque-2", id: "r2", summary: [] },
			{ type: "tool_use", id: "call", name: "read_file", input: {} },
			{ type: "text", text: "After." },
		])
		expect(buildCanonicalAnthropicAssistantHistoryContent(response)).toBeUndefined()
	})

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

	it("preserves signed empty and adjacent redacted thinking through serialization", () => {
		const response = createAgentResponse([
			{ type: "reasoning", text: "", signature: "empty-signature", outputIndex: 0 },
			{ type: "reasoning", text: "", redactedData: "opaque-one+/=", outputIndex: 1 },
			{ type: "reasoning", text: "", redactedData: "opaque-two+/=", outputIndex: 2 },
			{ type: "tool_call", id: "call", name: "exec_command", arguments: {} },
		])
		const reloaded = JSON.parse(JSON.stringify(response))
		expect(buildCanonicalAnthropicAssistantHistoryContent(reloaded)).toEqual([
			{ type: "thinking", thinking: "", signature: "empty-signature" },
			{ type: "redacted_thinking", data: "opaque-one+/=" },
			{ type: "redacted_thinking", data: "opaque-two+/=" },
			{ type: "tool_use", id: "call", name: "exec_command", input: {} },
		])
		expect(response.reasoning).toBe("")
	})

	it.each(["incomplete", "cancelled", "failed"] as const)(
		"never seals an earlier unsigned block with another source position's signature (%s)",
		(status) => {
			const response = createAgentResponse(
				[
					{ type: "reasoning", text: "Unfinished earlier block.", outputIndex: 0 },
					{ type: "reasoning", text: "Saved ", outputIndex: 1 },
					{ type: "reasoning", text: "reasoning.", signature: "sealed-signature", outputIndex: 1 },
					{ type: "reasoning", text: "", redactedData: "sealed-redacted+/=", outputIndex: 2 },
					{ type: "reasoning", text: "Unfinished later block.", outputIndex: 3 },
				],
				{ status },
			)
			expect(buildCanonicalAnthropicAssistantHistoryContent(response)).toEqual([
				{ type: "thinking", thinking: "Saved reasoning.", signature: "sealed-signature" },
				{ type: "redacted_thinking", data: "sealed-redacted+/=" },
			])
			expect(response.items[0]).not.toHaveProperty("signature")
			expect(response.items.at(-1)).not.toHaveProperty("signature")
		},
	)
})
