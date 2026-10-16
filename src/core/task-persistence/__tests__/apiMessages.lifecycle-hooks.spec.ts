import { describe, expect, it } from "vitest"
import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"

describe("persisted lifecycle hook input provenance", () => {
	it.each([
		"Stop",
		"SubagentStop",
		"SessionStart",
		"SubagentStart",
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"PermissionRequest",
		"PreCompact",
		"PostCompact",
		"Interrupt",
		"SessionEnd",
	])("accepts %s hook context without normalizing historical or provider metadata", (event) => {
		const history = [
			{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "Result" }] },
			{
				role: "user",
				input_origin: "agent",
				content: [{ type: "text", text: "Hook context" }],
				hook_prompt: { event, fragments: [{ hook_run_id: "hook-run-1", text: "Hook context" }] },
				provider_state: { opaque: ["retained"] },
			},
		]
		const before = structuredClone(history)

		expect(invalidPersistedApiMessages(history)).toBeUndefined()
		expect(history).toEqual(before)
	})

	it.each([
		{ event: "UnknownEvent", fragments: [{ hook_run_id: "run-1", text: "private-content" }] },
		{ event: "PreToolUse", fragments: [] },
		{ event: "PreToolUse", fragments: [{ hook_run_id: "", text: "private-content" }] },
		{ event: "PostToolUse", fragments: [{ hook_run_id: "run-1", text: " " }] },
		{ event: "SessionStart", fragments: [{ hook_run_id: "run-1", text: 7 }] },
	])("rejects malformed lifecycle provenance with a bounded diagnostic: %j", (hook_prompt) => {
		expect(invalidPersistedApiMessages([{ role: "user", input_origin: "agent", content: [], hook_prompt }])).toBe(
			"message 0 has invalid hook prompt provenance",
		)
	})

	it("continues to accept old histories without any hook or input-origin metadata", () => {
		expect(invalidPersistedApiMessages([{ role: "user", content: "Historical user request" }])).toBeUndefined()
	})
})
