import { describe, expect, it } from "vitest"

import { isApiStreamSemanticChunk } from "../../../api/transform/stream"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { createAgentResponse } from "../../agent/AgentResponse"
import { lifecycleResponseItems } from "../../agent/lifecycle/responseItems"
import {
	buildCanonicalAssistantHistoryContent,
	buildCanonicalAnthropicAssistantHistoryContent,
} from "../canonicalAssistantHistory"
import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"

function responseState() {
	return {
		modelId: "gemini-4-argon",
		parts: [
			{ text: "Checking.", thoughtSignature: "text-signature" },
			{ text: "Private summary.", thought: true, thoughtSignature: "thought-signature" },
			{
				functionCall: { id: "call-1", name: "read_file", args: { path: "a.ts" } },
				thoughtSignature: "call-signature",
			},
		],
	}
}

describe("Gemini canonical response state", () => {
	it("retains response parts and signatures independently of display text and mutable source objects", async () => {
		const accumulator = new AgentResponseAccumulator()
		const geminiResponse = responseState()
		const expected = structuredClone(geminiResponse)
		await accumulator.add({ type: "text", text: "Checking." })
		await accumulator.add({ type: "reasoning", text: "Private summary." })
		await accumulator.add({ type: "tool_call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' })
		const chunk = { type: "reasoning" as const, text: "", geminiResponse }
		await accumulator.add(chunk)
		geminiResponse.parts[0].thoughtSignature = "externally modified"
		const response = await accumulator.finish()
		const content = buildCanonicalAssistantHistoryContent(response)
		expect(response.text).toBe("Checking.")
		expect(response.reasoning).toBe("Private summary.")
		expect(response.items.at(-1)).toEqual({ type: "reasoning", text: "", geminiResponse: expected })
		expect(JSON.parse(JSON.stringify(content))).toEqual([
			{ type: "text", text: "Checking." },
			{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
			{ type: "gemini_response", geminiResponse: expected },
		])
		expect(invalidPersistedApiMessages([{ role: "assistant", content }])).toBeUndefined()
	})

	it("does not count replay-only metadata as semantic output", () => {
		const chunk = { type: "reasoning" as const, text: "", geminiResponse: responseState() }
		expect(isApiStreamSemanticChunk(chunk)).toBe(false)
		expect(isApiStreamSemanticChunk({ ...chunk, text: "Visible summary." })).toBe(true)
	})

	it("retains completed provider state as evidence after cancellation without changing the outcome", async () => {
		const accumulator = new AgentResponseAccumulator()
		const geminiResponse = responseState()
		const chunk = { type: "reasoning" as const, text: "", geminiResponse }
		await accumulator.add(chunk)
		await accumulator.add({ type: "outcome", status: "cancelled", terminal: true, semanticOutputObserved: false })
		const response = await accumulator.finish()
		expect(response.outcome?.status).toBe("cancelled")
		expect(response.text).toBe("")
		expect(response.reasoning).toBe("")
		expect(buildCanonicalAssistantHistoryContent(response)).toEqual([{ type: "gemini_response", geminiResponse }])
	})

	it.each(["complete", "streamed"])(
		"seals signed state with a complete accepted tool and retains only that prefix on cancellation (%s)",
		async (variant) => {
			const accumulator = new AgentResponseAccumulator()
			const geminiResponse = responseState()
			if (variant === "complete") {
				await accumulator.add({
					type: "tool_call",
					id: "call-1",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
					geminiResponse,
				})
			} else {
				await accumulator.add({
					type: "tool_call_partial",
					index: 0,
					id: "call-1",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				})
				await accumulator.add({ type: "tool_call_end", id: "call-1", geminiResponse })
			}
			await accumulator.add({
				type: "tool_call_partial",
				index: 1,
				id: "unfinished-call",
				name: "read_file",
				arguments: '{"path":"b.ts"}',
			})
			const response = await accumulator.finish(undefined, { status: "cancelled" })
			expect(response.toolCalls).toEqual([
				{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			])
			expect(buildCanonicalAssistantHistoryContent(response)).toEqual([
				{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
				{ type: "gemini_response", geminiResponse },
			])
		},
	)

	it("updates one canonical replay unit as accepted parts and final metadata arrive", async () => {
		const accumulator = new AgentResponseAccumulator()
		const geminiResponse = responseState()
		await accumulator.add({
			type: "tool_call",
			id: "call-1",
			name: "read_file",
			arguments: '{"path":"a.ts"}',
			geminiResponse,
		})
		const completed = { ...geminiResponse, parts: [...geminiResponse.parts, { text: "Final commentary." }] }
		await accumulator.add({ type: "reasoning", text: "", geminiResponse: completed })
		await accumulator.add({ type: "reasoning", text: "", geminiResponse: completed })
		const expected = structuredClone(completed)
		completed.parts[0] = { ...completed.parts[0], thoughtSignature: "changed externally" }
		const response = await accumulator.finish()
		expect(response.items.filter((item) => item.type === "reasoning")).toEqual([
			{ type: "reasoning", text: "", geminiResponse: expected },
		])
	})

	it("rejects invalid or changing provider replay identity without interpreting opaque content", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "reasoning", text: "", geminiResponse: responseState() })
		await expect(
			accumulator.add({
				type: "reasoning",
				text: "",
				geminiResponse: { ...responseState(), modelId: "gemini-other" },
			}),
		).rejects.toThrow("Gemini model identity changed within one response.")
	})

	it("keeps replay state separate from lifecycle display fragments and Anthropic wire history", () => {
		const state = { type: "reasoning" as const, text: "", geminiResponse: responseState() }
		const items = [
			{ type: "reasoning" as const, text: "Before." },
			state,
			{ type: "reasoning" as const, text: "After." },
		]
		expect([...lifecycleResponseItems(items, "step")].map(({ responseItem }) => responseItem)).toEqual(items)
		expect(buildCanonicalAnthropicAssistantHistoryContent(createAgentResponse([state]))).toBeUndefined()
	})

	it.each([
		undefined,
		{},
		{ modelId: "gemini-4-argon", parts: "invalid" },
		{ modelId: "gemini-4-argon", parts: [{ thoughtSignature: 7, text: "text" }] },
		{ modelId: "", parts: [{ text: "text" }] },
	])("rejects malformed Gemini replay state at the persisted boundary (%j)", (geminiResponse) => {
		expect(
			invalidPersistedApiMessages([
				{ role: "assistant", content: [{ type: "gemini_response", geminiResponse }] },
			]),
		).toContain("invalid Gemini response")
	})
})
