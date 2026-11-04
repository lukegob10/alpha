import type { Anthropic } from "@anthropic-ai/sdk"

import { buildOpenAiResponsesInput } from "../../providers/openai-responses"
import { convertToOpenAiMessages } from "../openai-format"

const hookMessage = (event = "PostToolUse") => ({
	role: "user",
	input_origin: "agent",
	content: [{ type: "text", text: "First hook\n\nSecond hook" }],
	hook_prompt: {
		event,
		fragments: [
			{ hook_run_id: "run-1", text: "First hook" },
			{ hook_run_id: "run-2", text: "Second hook" },
		],
	},
})

const converters = {
	Chat: (history: unknown[]) => convertToOpenAiMessages(history as Anthropic.Messages.MessageParam[]),
	Responses: (history: unknown[]) => buildOpenAiResponsesInput("", [], history, false),
}

describe.each(Object.entries(converters))("%s lifecycle hook context", (_name, convert) => {
	it.each(["SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"])(
		"preserves %s context authority and its position after completed tool receipts",
		(event) => {
			const history = [
				{ role: "user", content: "Inspect the file" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "read", name: "read_file", input: { path: "file.ts" } }],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "File contents" }] },
				hookMessage(event),
				{ role: "assistant", content: "Done" },
			]
			const before = structuredClone(history)
			const reloaded = JSON.parse(JSON.stringify(history))
			const result = convert(reloaded)

			expect(result).toHaveLength(5)
			expect(result[3]).toEqual({ role: "developer", content: "First hook\n\nSecond hook" })
			expect(result[4]).toMatchObject({ role: "assistant" })
			expect(reloaded).toEqual(before)
		},
	)

	it("accepts string content only when it exactly matches the recorded hook fragments", () => {
		expect(convert([{ ...hookMessage(), content: "First hook\n\nSecond hook" }])).toEqual([
			{ role: "developer", content: "First hook\n\nSecond hook" },
		])
	})

	it.each(["Stop", "SubagentStop"])("keeps %s continuation as user input", (event) => {
		expect(convert([hookMessage(event)])[0]).toMatchObject({ role: "user" })
	})

	it.each([
		["human input", { input_origin: "human" }],
		["missing input provenance", { input_origin: undefined }],
		["summary", { isSummary: true }],
		["truncation marker", { isTruncationMarker: true }],
		["human queue receipt", { queued_message_ids: ["human-input"] }],
		["agent mail receipt", { agent_message_id: "agent-mail" }],
		["assistant output", { role: "assistant" }],
		["unrecorded content", { content: "Human content" }],
		["unknown event", { hook_prompt: { ...hookMessage().hook_prompt, event: "Unknown" } }],
		["missing run identity", { hook_prompt: { event: "PostToolUse", fragments: [{ text: "First hook" }] } }],
		[
			"blank run identity",
			{
				hook_prompt: { event: "PostToolUse", fragments: [{ hook_run_id: " ", text: "First hook" }] },
				content: "First hook",
			},
		],
		[
			"tool output",
			{ content: [{ type: "tool_result", tool_use_id: "read", content: "First hook\n\nSecond hook" }] },
		],
	])("does not promote %s", (_case, fields) => {
		expect(convert([{ ...hookMessage(), ...fields }])).not.toContainEqual(
			expect.objectContaining({ role: "developer" }),
		)
	})
})
