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
