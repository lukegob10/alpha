import { describe, expect, it } from "vitest"

import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"

describe("persisted tool ID alias compatibility", () => {
	it.each([
		{ type: "tool_use", id: "private-first-id", tool_call_id: "private-other-id", name: "read_file", input: {} },
		{
			type: "tool_call",
			id: "private-first-id",
			tool_call_id: "private-other-id",
			name: "read_file",
			arguments: {},
		},
		{
			type: "tool_result",
			tool_use_id: "private-first-id",
			tool_call_id: "private-other-id",
			content: "private-result",
		},
	])("rejects conflicting aliases without exposing history IDs or contents (%j)", (block) => {
		const history = [{ role: "user", content: [block] }]
		const before = structuredClone(history)
		expect(invalidPersistedApiMessages(history)).toBe("message 0 block 0 has conflicting tool IDs")
		expect(history).toEqual(before)
	})

	it("accepts empty alias fallback and equal IDs without normalizing persisted bytes", () => {
		const history = [
			{
				role: "assistant",
				content: [{ type: "tool_call", id: "", tool_call_id: "call-1", name: "read_file", arguments: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-1",
						tool_call_id: "call-1",
						content: null,
						is_error: true,
					},
				],
			},
		]
		const before = structuredClone(history)
		expect(invalidPersistedApiMessages(history)).toBeUndefined()
		expect(history).toEqual(before)
	})
})

describe("invalidPersistedApiMessages reasoning continuity", () => {
	it.each([
		["missing reasoning payload", { type: "reasoning" }],
		["non-string reasoning text", { type: "reasoning", text: 7 }],
		["non-string encrypted reasoning", { type: "reasoning", encrypted_content: 7 }],
		["empty encrypted reasoning", { type: "reasoning", encrypted_content: "" }],
		["invalid reasoning ID", { type: "reasoning", encrypted_content: "opaque", id: 7 }],
		["invalid reasoning summary", { type: "reasoning", encrypted_content: "opaque", summary: {} }],
		["invalid reasoning signature", { type: "reasoning", text: "reason", signature: 7 }],
		["missing thinking text", { type: "thinking", signature: "signature" }],
		["invalid thinking text", { type: "thinking", thinking: {}, signature: "signature" }],
		["missing thinking signature", { type: "thinking", thinking: "reason" }],
		["invalid thinking signature", { type: "thinking", thinking: "reason", signature: 7 }],
		["empty thinking signature", { type: "thinking", thinking: "reason", signature: "" }],
		["invalid redacted thinking", { type: "redacted_thinking", data: 7 }],
		["missing thought signature", { type: "thoughtSignature" }],
		["invalid thought signature", { type: "thoughtSignature", thoughtSignature: { opaque: true } }],
		["empty thought signature", { type: "thoughtSignature", thoughtSignature: "" }],
	])("rejects %s at the persisted block boundary", (_case, block) => {
		expect(invalidPersistedApiMessages([{ role: "assistant", content: [block] }])).toMatch(/^message 0 block 0 /)
	})

	it.each([
		{ field: "reasoning details", metadata: { reasoning_details: {} } },
		{ field: "reasoning content", metadata: { reasoning_content: [] } },
	])("rejects malformed top-level $field even with string content", ({ metadata }) => {
		expect(invalidPersistedApiMessages([{ role: "assistant", content: "answer", ...metadata }])).toMatch(
			/^message 0 /,
		)
	})

	it("validates a top-level encrypted reasoning item even when a legacy record also has a role", () => {
		expect(
			invalidPersistedApiMessages([{ role: "assistant", content: [], type: "reasoning", encrypted_content: 7 }]),
		).toMatch(/^message 0 /)
		expect(
			invalidPersistedApiMessages([
				{
					role: "assistant",
					content: [],
					type: "reasoning",
					encrypted_content: "legacy-encrypted",
					summary: [],
				},
			]),
		).toBeUndefined()
	})

	it("accepts legacy plaintext, signed blocks, encrypted items, and open provider metadata without rewriting them", () => {
		const history = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "", signature: "", summary: [] },
					{
						type: "reasoning",
						encrypted_content: "opaque",
						id: "rs-1",
						summary: [{ type: "future_summary" }],
					},
					{ type: "thinking", thinking: "", signature: "signed-empty-block" },
					{ type: "redacted_thinking", data: "opaque-redacted" },
					{ type: "thoughtSignature", thoughtSignature: "gemini-signature" },
					{ type: "future_provider_block", opaque: { state: [1, 2] } },
				],
				reasoning_details: [{ type: "future_provider_reasoning", opaque: { state: [1, 2] } }],
				reasoning_content: "interleaved reasoning",
				provider_state: { opaque: [1, 2] },
			},
			{ type: "reasoning", encrypted_content: "opaque-standalone", summary: [], id: "rs-2" },
		]
		const before = structuredClone(history)

		expect(invalidPersistedApiMessages(history)).toBeUndefined()
		expect(history).toEqual(before)
	})
})
