import type { Anthropic } from "@anthropic-ai/sdk"

import { buildOpenAiResponsesInput } from "../../providers/openai-responses"
import { invalidPersistedApiMessages } from "../../../core/task-persistence/validatePersistedApiMessages"
import { ToolHistoryError } from "../../../utils/tool-id"
import { filterNonAnthropicBlocks } from "../anthropic-filter"
import { convertAnthropicMessagesToGemini } from "../gemini-format"
import { convertToOpenAiMessages } from "../openai-format"
import { convertToR1Format } from "../r1-format"
import { normalizeToolHistory } from "../tool-history"

function providerHistory(history: unknown): Anthropic.Messages.MessageParam[] {
	// Persisted compatibility shapes intentionally extend the SDK's current wire types.
	expect(invalidPersistedApiMessages(history)).toBeUndefined()
	return history as Anthropic.Messages.MessageParam[]
}

const patch = '*** Begin Patch\r\n*** Add File: file.txt\r\n+const path = "C:\\work\\file.txt"\r\n*** End Patch\n'

function patchHistory() {
	return providerHistory([
		{ role: "assistant", content: [{ type: "tool_use", id: "patch-call", name: "apply_patch", input: patch }] },
		{
			role: "user",
			content: [{ type: "tool_result", tool_call_id: "patch-call", content: "Error: cancelled", is_error: true }],
		},
	])
}

describe("accepted tool history request projection", () => {
	it.each([
		{ tool_use_id: "call-1" },
		{ tool_call_id: "call-1" },
		{ tool_use_id: "", tool_call_id: "call-1" },
		{ tool_use_id: "call-1", tool_call_id: "" },
		{ tool_use_id: "call-1", tool_call_id: "call-1" },
	])("resolves result aliases without changing failed receipts or stored metadata (%j)", (ids) => {
		const state = { opaque: [1, 2] }
		const reasoning = { type: "reasoning", text: "", encrypted_content: "synthetic-encrypted" }
		const history = [
			{
				role: "assistant",
				content: [reasoning, { type: "tool_use", id: "call-1", name: "read_file", input: {} }],
				provider_state: state,
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						...ids,
						content: null,
						is_error: true,
						status: "cancelled",
						provider_state: state,
					},
				],
			},
		]
		const before = structuredClone(history)
		const normalized = normalizeToolHistory(history)
		expect(normalized[0]).toBe(history[0])
		expect(normalized[0].content[0]).toBe(reasoning)
		expect(normalized[1].content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "call-1",
			content: null,
			is_error: true,
			status: "cancelled",
			provider_state: state,
		})
		expect(history).toEqual(before)
		expect(normalizeToolHistory(normalized)).toEqual(normalized)
	})

	it("projects a legacy function call and terminal result using the original IDs and arguments", () => {
		const history = providerHistory([
			{
				role: "assistant",
				content: [
					{
						type: "tool_call",
						id: "",
						tool_call_id: "legacy-call",
						function: { name: "read_file", arguments: '{"path":"file.txt"}' },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_call_id: "legacy-call", content: "Error: denied", is_error: true },
				],
			},
		])
		const before = structuredClone(history)
		expect(convertToOpenAiMessages(history)).toEqual([
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "legacy-call",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"file.txt"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "legacy-call", content: "Error: denied" },
		])
		expect(history).toEqual(before)
	})

	it("collapses identical terminal receipts only within their matching call occurrence", () => {
		const receipt = {
			type: "tool_result",
			tool_use_id: "reused-call",
			content: "Error: denied",
			is_error: true,
			status: "denied",
		}
		const history = providerHistory([
			{ role: "assistant", content: [{ type: "tool_use", id: "reused-call", name: "read_file", input: {} }] },
			{ role: "user", content: [receipt] },
			{
				role: "user",
				content: [
					{ ...receipt, tool_use_id: "", tool_call_id: "reused-call" },
					{ type: "text", text: "Preserve this note." },
				],
			},
			{ role: "assistant", content: [{ type: "tool_use", id: "reused-call", name: "list_files", input: {} }] },
			{ role: "user", content: [receipt] },
		])
		const before = structuredClone(history)
		const normalized = normalizeToolHistory(history)
		expect(normalized[2].content).toEqual([{ type: "text", text: "Preserve this note." }])
		expect(normalized[4].content).toEqual([receipt])
		expect(convertToOpenAiMessages(history).filter((message) => message.role === "tool")).toEqual([
			{ role: "tool", tool_call_id: "reused-call", content: "Error: denied" },
			{ role: "tool", tool_call_id: "reused-call", content: "Error: denied" },
		])
		expect(history).toEqual(before)
	})

	it.each([
		{ name: "read_file", arguments: { path: "file.txt" } },
		{ name: "read_file", arguments: '{"path":"file.txt"}' },
		{ function: { name: "read_file", arguments: { path: "file.txt" } } },
	])("replays accepted direct and nested legacy function arguments (%j)", (definition) => {
		const history = providerHistory([
			{ role: "assistant", content: [{ type: "tool_call", tool_call_id: "legacy-call", ...definition }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_call_id: "legacy-call", content: "Error: cancelled" }],
			},
		])
		expect(buildOpenAiResponsesInput("", [], history, false)).toEqual([
			{ type: "function_call", call_id: "legacy-call", name: "read_file", arguments: '{"path":"file.txt"}' },
			{ type: "function_call_output", call_id: "legacy-call", output: "Error: cancelled" },
		])
	})

	it("retains raw legacy patch arguments and leaves unrelated scalar tool input unchanged", () => {
		const history = providerHistory([
			{
				role: "assistant",
				content: [{ type: "tool_call", tool_call_id: "legacy-call", name: "apply_patch", arguments: patch }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_call_id: "legacy-call", content: "Error: denied" }] },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "scalar-call", name: "legacy_custom_tool", input: "raw scalar" }],
			},
		])
		expect(buildOpenAiResponsesInput("", [], history, false)).toEqual([
			{ type: "custom_tool_call", call_id: "legacy-call", name: "apply_patch", input: patch },
			{ type: "custom_tool_call_output", call_id: "legacy-call", output: "Error: denied" },
			{ type: "function_call", call_id: "scalar-call", name: "legacy_custom_tool", arguments: '"raw scalar"' },
		])
	})

	it.each([
		{ content: "another terminal payload" },
		{ is_error: false },
		{ status: "success" },
		{ provider_state: { opaque: "other" } },
	])("rejects conflicting terminal receipts instead of selecting a successful replacement (%j)", (change) => {
		const result = {
			type: "tool_result",
			tool_use_id: "private-call-id",
			content: "private-payload",
			is_error: true,
			status: "cancelled",
			provider_state: { opaque: "original" },
		}
		const history = [
			{ role: "assistant", content: [{ type: "tool_use", id: "private-call-id", name: "read_file", input: {} }] },
			{ role: "user", content: [result, { ...result, ...change }] },
		]
		expect(() => normalizeToolHistory(history)).toThrow(new ToolHistoryError("conflicting_tool_results"))
		expect(() => normalizeToolHistory(history)).not.toThrow(/private-call-id|private-payload/)
	})

	it.each([
		{ type: "tool_use", id: "first-private-id", tool_call_id: "second-private-id", name: "read_file", input: {} },
		{
			type: "tool_call",
			id: "first-private-id",
			tool_call_id: "second-private-id",
			function: { name: "read_file", arguments: "{}" },
		},
		{
			type: "tool_result",
			tool_use_id: "first-private-id",
			tool_call_id: "second-private-id",
			content: "private-output",
		},
	])("rejects conflicting nonempty aliases before projecting ambiguous history (%j)", (block) => {
		expect(() => normalizeToolHistory([{ role: "user", content: [block] }])).toThrow(ToolHistoryError)
		expect(() => normalizeToolHistory([{ role: "user", content: [block] }])).not.toThrow(
			/private-id|private-output/,
		)
	})

	it("rejects two open calls with the same ID but does not invent missing calls or outputs", () => {
		const call = { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] }
		const orphan = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "orphan", content: "Error: cancelled", is_error: true }],
		}
		expect(() => normalizeToolHistory([call, call])).toThrow(new ToolHistoryError("duplicate_open_tool_call"))
		expect(normalizeToolHistory([call, orphan])).toEqual([call, orphan])
	})

	it.each([{}, { tool_use_id: "", tool_call_id: "" }])("rejects an unidentifiable terminal result (%j)", (ids) => {
		expect(() =>
			normalizeToolHistory([
				{ role: "user", content: [{ type: "tool_result", ...ids, content: "Error: cancelled" }] },
			]),
		).toThrow(new ToolHistoryError("invalid_tool_result_id"))
	})
})

describe("native provider projections of accepted freeform history", () => {
	it.each([
		["Chat", convertToOpenAiMessages],
		["R1", convertToR1Format],
	] as const)("%s wraps only raw apply_patch bytes for its JSON function schema", (_name, convert) => {
		const history = patchHistory()
		const before = structuredClone(history)
		expect(convert(history)).toEqual([
			{
				role: "assistant",
				content: _name === "R1" ? null : "",
				tool_calls: [
					{
						id: "patch-call",
						type: "function",
						function: { name: "apply_patch", arguments: JSON.stringify({ patch }) },
					},
				],
			},
			{ role: "tool", tool_call_id: "patch-call", content: "Error: cancelled" },
		])
		expect(history).toEqual(before)
	})

	it("Responses preserves exact freeform bytes and projects JSON fallback through the function schema", () => {
		const history = patchHistory()
		expect(buildOpenAiResponsesInput("", [], history, false)).toEqual([
			{ type: "custom_tool_call", call_id: "patch-call", name: "apply_patch", input: patch },
			{ type: "custom_tool_call_output", call_id: "patch-call", output: "Error: cancelled" },
		])
		expect(buildOpenAiResponsesInput("", [], history, false, false)).toEqual([
			{ type: "function_call", call_id: "patch-call", name: "apply_patch", arguments: JSON.stringify({ patch }) },
			{ type: "function_call_output", call_id: "patch-call", output: "Error: cancelled" },
		])
	})

	it("Anthropic retains signed reasoning and failed terminal metadata while projecting legacy calls", () => {
		const thinking = { type: "thinking", thinking: "", signature: "synthetic-signature" }
		const history = providerHistory([
			{
				role: "assistant",
				content: [
					thinking,
					{ type: "tool_call", tool_call_id: "patch-call", name: "apply_patch", input: patch },
				],
				provider_state: { opaque: true },
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_call_id: "patch-call", content: "Error: cancelled", is_error: true },
				],
			},
		])
		const before = structuredClone(history)
		expect(filterNonAnthropicBlocks(history)).toEqual([
			{
				role: "assistant",
				content: [thinking, { type: "tool_use", id: "patch-call", name: "apply_patch", input: { patch } }],
				provider_state: { opaque: true },
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "patch-call", content: "Error: cancelled", is_error: true },
				],
			},
		])
		expect(history).toEqual(before)
	})

	it("Gemini uses the tool name at each completed reused-ID occurrence and retains its signature", () => {
		const history = providerHistory([
			{
				role: "assistant",
				content: [
					{ type: "thoughtSignature", thoughtSignature: "synthetic-first-signature" },
					{ type: "tool_use", id: "reused", name: "apply_patch", input: patch },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_call_id: "reused", content: "Error: denied", is_error: true }],
			},
			{
				role: "assistant",
				content: [
					{ type: "thoughtSignature", thoughtSignature: "synthetic-second-signature" },
					{ type: "tool_use", id: "reused", name: "read_file", input: { path: "file.txt" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_call_id: "reused", content: null, is_error: true }] },
		])
		const before = structuredClone(history)
		expect(convertAnthropicMessagesToGemini(history)).toEqual([
			{
				role: "model",
				parts: [
					{
						functionCall: { id: "reused", name: "apply_patch", args: { patch } },
						thoughtSignature: "synthetic-first-signature",
					},
				],
			},
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: "reused",
							name: "apply_patch",
							response: { name: "apply_patch", content: "Error: denied" },
						},
					},
				],
			},
			{
				role: "model",
				parts: [
					{
						functionCall: { id: "reused", name: "read_file", args: { path: "file.txt" } },
						thoughtSignature: "synthetic-second-signature",
					},
				],
			},
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: "reused",
							name: "read_file",
							response: { name: "read_file", content: "" },
						},
					},
				],
			},
		])
		expect(history).toEqual(before)
	})
})
