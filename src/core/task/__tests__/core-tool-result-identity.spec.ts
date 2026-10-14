import type { Anthropic } from "@anthropic-ai/sdk"

import { validateAndFixToolResultIds } from "../validateToolResultIds"

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: { hasInstance: () => false },
}))

function repair(ids: string[], results: Anthropic.ToolResultBlockParam[]) {
	const assistant: Anthropic.MessageParam = {
		role: "assistant",
		content: ids.map((id) => ({ type: "tool_use", id, name: "read_file", input: {} })),
	}
	const message: Anthropic.MessageParam = { role: "user", content: results }
	return validateAndFixToolResultIds(message, [assistant]).content
}

it("preserves the identified result when an orphan precedes it", () => {
	const known: Anthropic.ToolResultBlockParam = {
		type: "tool_result",
		tool_use_id: "current",
		content: "Current command failed",
		is_error: true,
	}
	expect(
		repair(["current"], [{ type: "tool_result", tool_use_id: "stale", content: "Old command succeeded" }, known]),
	).toEqual([known])
})

it("reserves all identified results before applying legacy positional repair", () => {
	const known: Anthropic.ToolResultBlockParam = {
		type: "tool_result",
		tool_use_id: "first",
		content: "First result",
	}
	expect(
		repair(
			["first", "second"],
			[{ type: "tool_result", tool_use_id: "unknown", content: "Unidentified output" }, known],
		),
	).toEqual([
		{
			type: "tool_result",
			tool_use_id: "second",
			content: "Tool execution was interrupted before completion.",
			is_error: true,
		},
		known,
	])
})

it("keeps out-of-order identified results and their statuses", () => {
	const results: Anthropic.ToolResultBlockParam[] = [
		{ type: "tool_result", tool_use_id: "second", content: "Failed", is_error: true },
		{ type: "tool_result", tool_use_id: "first", content: "Succeeded" },
	]
	expect(repair(["first", "second"], results)).toEqual(results)
})

it("preserves reversed accepted legacy receipts, empty-field fallback and failure status", () => {
	const rawResults = [
		{ type: "tool_result", tool_call_id: "second", content: "Failed", is_error: true },
		{ type: "tool_result", tool_use_id: "", tool_call_id: "first", content: "Succeeded", opaque: { kept: true } },
	]
	const original = structuredClone(rawResults)
	expect(repair(["first", "second"], rawResults as unknown as Anthropic.ToolResultBlockParam[])).toEqual(original)
	expect(rawResults).toEqual(original)
})

it("pairs accepted legacy calls with their existing receipts without fabricating interruption", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "tool_call", tool_call_id: "retained", name: "read_file", arguments: { path: "a.ts" } }],
	} as unknown as Anthropic.MessageParam
	const user = {
		role: "user",
		content: [{ type: "tool_result", tool_call_id: "retained", content: "Actual failure", is_error: true }],
	} as unknown as Anthropic.MessageParam
	const original = structuredClone(user)
	expect(validateAndFixToolResultIds(user, [assistant])).toEqual(original)
	expect(user).toEqual(original)
})

it("rejects conflicting aliases instead of guessing a receipt identity", () => {
	const results = [
		{ type: "tool_result", tool_use_id: "first", tool_call_id: "second", content: "Sensitive output" },
	] as unknown as Anthropic.ToolResultBlockParam[]
	expect(() => repair(["first", "second"], results)).toThrow("conflicting_tool_result_ids")
})
