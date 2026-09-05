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
	it("keeps merged display values bounded without losing text", () => {
		const items: AgentResponseItem[] = Array.from({ length: 30 }, () => ({ type: "text", text: "x".repeat(1000) }))
		const projected = [...lifecycleResponseItems(items, "step")].map(({ responseItem }) => responseItem)
		expect(projected).toHaveLength(8)
		expect(projected.map((item) => (item.type === "text" ? item.text : "")).join("")).toBe("x".repeat(30_000))
	})
})
