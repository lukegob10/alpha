import { describe, expect, it } from "vitest"
import { lifecycleResponseItems } from "../responseItems"
import type { AgentResponseItem } from "../../AgentResponse"

describe("lifecycle response projection", () => {
	const fragments: AgentResponseItem[] = Array.from({ length: 5 }, (_, index) => ({
		type: "text",
		text: String(index),
	}))
	it("resumes partially published legacy and grouped items without duplicates", () => {
		const remaining = [...lifecycleResponseItems(fragments, "step", new Set(["step:item-0", "step:items-1-2"]))]
		expect(remaining).toEqual([{ itemId: "step:items-3-4", responseItem: { type: "text", text: "34" } }])
		expect([...lifecycleResponseItems(fragments, "step", new Set(["step:items-0-4"]))]).toEqual([])
	})
	it.each([
		[
			{ id: "progress", phase: "commentary" },
			{ id: "answer", phase: "final_answer" },
		],
		[
			{ id: "first", phase: "commentary" },
			{ id: "second", phase: "commentary" },
		],
		[{ id: "first" }, { id: "second" }],
		[{ outputIndex: 0 }, { outputIndex: 1 }],
		[{ phase: "partial_answer" }, { phase: "final_answer" }],
		[{ phase: "commentary" }, { phase: "commentary" }],
	] as const)("preserves assistant source boundaries %j and %j", (first, second) => {
		const items: AgentResponseItem[] = [
			{ type: "text", text: "Checking.", ...first },
			{ type: "text", text: "Done.", ...second },
		]
		expect([...lifecycleResponseItems(items, "step")].map(({ responseItem }) => responseItem)).toEqual(items)
	})
	it("groups fragments only within their original assistant message", () => {
		const items: AgentResponseItem[] = [
			{ type: "text", text: "First ", id: "message", phase: "partial_answer", outputIndex: 0 },
			{ type: "text", text: "answer.", id: "message", phase: "partial_answer", outputIndex: 0 },
			{ type: "text", text: "More.", id: "next", phase: "partial_answer", outputIndex: 1 },
		]
		expect([...lifecycleResponseItems(items, "step")]).toEqual([
			{
				itemId: "step:items-0-1",
				responseItem: { ...items[0], text: "First answer." },
			},
			{ itemId: "step:item-2", responseItem: items[2] },
		])
		expect([...lifecycleResponseItems(items, "step", new Set(["step:items-0-1"]))]).toEqual([
			{ itemId: "step:item-2", responseItem: items[2] },
		])
	})
	it("preserves tool, usage, grounding and reasoning signature boundaries", () => {
		const items: AgentResponseItem[] = [
			{ type: "reasoning", text: "a", signature: "first" },
			{ type: "reasoning", text: "b", signature: "second" },
			{ type: "tool_call", id: "tool", name: "read_file", arguments: { path: "file" } },
			{ type: "text", text: "c" },
			{ type: "grounding", sources: [] },
			{ type: "text", text: "d" },
			{ type: "usage", inputTokens: 1, outputTokens: 2 },
		]
		expect([...lifecycleResponseItems(items, "step")].map((item) => item.responseItem)).toEqual(items)
	})
	it.each([
		[{ id: "first" }, { id: "second" }],
		[{ outputIndex: 0 }, { outputIndex: 1 }],
		[{ encryptedContent: "first" }, { encryptedContent: "second" }],
		[{ redactedData: "first" }, { redactedData: "second" }],
		[{ summary: [{ text: "First." }] }, { summary: [{ text: "Second." }] }],
		[{ vscodeLmThinking: { value: "First." } }, { vscodeLmThinking: { value: "Second." } }],
	])("preserves reasoning source boundaries %j and %j", (first, second) => {
		const items: AgentResponseItem[] = [
			{ type: "reasoning", text: "First.", ...structuredClone(first) },
			{ type: "reasoning", text: "Second.", ...structuredClone(second) },
		]
		expect([...lifecycleResponseItems(items, "step")].map(({ responseItem }) => responseItem)).toEqual(items)
	})
	it("groups compatible plaintext reasoning fragments from the same source", () => {
		const items: AgentResponseItem[] = [
			{ type: "reasoning", text: "First ", id: "reasoning", outputIndex: 0, signature: "signature" },
			{ type: "reasoning", text: "thought.", id: "reasoning", outputIndex: 0, signature: "signature" },
		]
		expect([...lifecycleResponseItems(items, "step")]).toEqual([
			{ itemId: "step:items-0-1", responseItem: { ...items[0], text: "First thought." } },
		])
	})
	it("keeps merged display values bounded without losing text", () => {
		const items: AgentResponseItem[] = Array.from({ length: 30 }, () => ({ type: "text", text: "x".repeat(1000) }))
		const projected = [...lifecycleResponseItems(items, "step")].map(({ responseItem }) => responseItem)
		expect(projected).toHaveLength(8)
		expect(projected.map((item) => (item.type === "text" ? item.text : "")).join("")).toBe("x".repeat(30_000))
	})
})
