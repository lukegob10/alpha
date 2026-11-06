import type { Anthropic } from "@anthropic-ai/sdk"

import { buildOpenAiResponsesInput } from "../../providers/openai-responses"
import { convertToOpenAiMessages } from "../openai-format"
import { filterNonAnthropicBlocks } from "../anthropic-filter"
import { convertAnthropicMessagesToGemini } from "../gemini-format"
import { convertToVsCodeLmMessages } from "../vscode-lm-format"

vi.mock("vscode", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscode")>()),
	LanguageModelTextPart: class {
		constructor(readonly value: string) {}
	},
	LanguageModelChatMessage: {
		User: (content: unknown) => ({ role: "user", content }),
		Assistant: (content: unknown) => ({ role: "assistant", content }),
	},
}))

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

const fallbackConverters = {
	Anthropic: (history: Anthropic.Messages.MessageParam[]) => filterNonAnthropicBlocks(history),
	Gemini: (history: Anthropic.Messages.MessageParam[]) => convertAnthropicMessagesToGemini(history),
	"VS Code LM": (history: Anthropic.Messages.MessageParam[]) => convertToVsCodeLmMessages(history),
}

describe.each(Object.entries(fallbackConverters))("%s lifecycle context fallback", (_name, convert) => {
	it("retains the developer origin at its original position without changing saved history", () => {
		const history = [
			{ role: "user", content: "Original input" },
			{ role: "assistant", content: "Before hook" },
			hookMessage(),
			{ role: "assistant", content: "After hook" },
		]
		const original = structuredClone(history)
		const result = convert(history as Anthropic.Messages.MessageParam[])
		expect(result).toHaveLength(4)
		expect(JSON.stringify(result[2])).toContain(
			'<developer_context source=\\"lifecycle_hook\\" event=\\"PostToolUse\\">',
		)
		expect(JSON.stringify(result[2])).toContain("First hook\\n\\nSecond hook")
		expect(JSON.stringify(result[3])).toContain("After hook")
		expect(history).toEqual(original)
	})

	it.each([
		["human input", { input_origin: "human" }],
		["unrecorded output", { content: "Different contents" }],
		["Stop continuation", { hook_prompt: { ...hookMessage().hook_prompt, event: "Stop" } }],
		["SubagentStop continuation", { hook_prompt: { ...hookMessage().hook_prompt, event: "SubagentStop" } }],
	])("does not label %s as developer context", (_case, fields) => {
		const result = convert([{ ...hookMessage(), ...fields }] as Anthropic.Messages.MessageParam[])
		expect(JSON.stringify(result)).not.toContain("<developer_context")
	})
})

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
