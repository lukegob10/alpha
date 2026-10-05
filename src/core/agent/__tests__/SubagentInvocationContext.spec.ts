import { describe, expect, it } from "vitest"

import type { ApiInstructionFragment } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { captureInheritedStepInstructions, getFinalAssistantMessageIndexes } from "../SubagentInvocationContext"

function assistant(
	metadata: Record<string, unknown> = {},
	content: ApiMessage["content"] = "Visible answer",
): ApiMessage {
	return Object.assign({ role: "assistant" as const, content }, metadata)
}

function canonicalAssistant(items: unknown, outcome?: unknown): ApiMessage {
	return assistant({ agentResponseItems: items, ...(outcome === undefined ? {} : { agentResponseOutcome: outcome }) })
}

const finalText = [{ type: "text", text: "Final answer" }]

describe("getFinalAssistantMessageIndexes", () => {
	it("selects canonical tool-free visible responses in history order", () => {
		const history: ApiMessage[] = [
			{ role: "user", content: "Request" },
			assistant(),
			canonicalAssistant(finalText),
			canonicalAssistant(
				[
					{ type: "reasoning", text: "Private reasoning", signature: "signature" },
					{ type: "text", text: " " },
					{ type: "text", text: "Final answer" },
					{ type: "usage", inputTokens: 20, outputTokens: 10 },
					{ type: "grounding", sources: [{ title: "Reference", url: "https://example.com" }] },
				],
				{ status: "completed", requiresContinuation: false },
			),
		]
		const original = structuredClone(history)

		expect(getFinalAssistantMessageIndexes(history)).toEqual([2, 3])
		expect(history).toEqual(original)
	})

	it("does not infer finality from the provider role, content, or a legacy phase", () => {
		const history = [
			assistant(),
			assistant({ phase: "final_answer" }),
			Object.assign({ role: "user" as const, content: "Request" }, { agentResponseItems: finalText }),
			assistant({ type: "reasoning", agentResponseItems: finalText }),
		]

		expect(getFinalAssistantMessageIndexes(history)).toEqual([])
	})

	it.each([
		["incomplete", { status: "incomplete" }],
		["failed", { status: "failed" }],
		["cancelled", { status: "cancelled" }],
		["commentary requiring another response", { status: "completed", requiresContinuation: true }],
	])("excludes %s responses even when canonical visible text arrived", (_label, outcome) => {
		expect(getFinalAssistantMessageIndexes([canonicalAssistant(finalText, outcome)])).toEqual([])
	})

	it.each([
		["no output", []],
		["blank text", [{ type: "text", text: " \n\t" }]],
		["reasoning only", [{ type: "reasoning", text: "Thinking" }]],
		["tool commentary", [...finalText, { type: "tool_call", id: "read", name: "read_file", arguments: {} }]],
		["provider error", [...finalText, { type: "error", message: "Stream failed" }]],
	])("excludes %s from inherited final answers", (_label, items) => {
		expect(getFinalAssistantMessageIndexes([canonicalAssistant(items, { status: "completed" })])).toEqual([])
	})

	it("does not promote an attempt_completion call from its staged empty result", () => {
		const history: ApiMessage[] = [
			assistant(
				{
					agentResponseItems: [
						{ type: "tool_call", id: "finish", name: "attempt_completion", arguments: { result: "Done" } },
					],
					agentResponseOutcome: { status: "completed" },
				},
				[{ type: "tool_use", id: "finish", name: "attempt_completion", input: { result: "Done" } }],
			),
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "finish", content: "(tool did not return anything)" }],
			},
		]

		expect(getFinalAssistantMessageIndexes(history)).toEqual([])
	})

	it.each([
		["missing metadata", undefined],
		["null metadata", null],
		["scalar metadata", "Final answer"],
		["object metadata", { type: "text", text: "Final answer" }],
		["null item", [...finalText, null]],
		["scalar item", [...finalText, "text"]],
		["array item", [...finalText, [{ type: "text", text: "Extra" }]]],
		["missing item type", [...finalText, { text: "Extra" }]],
		["unknown item type", [...finalText, { type: "future_tool" }]],
		["missing text", [{ type: "text" }]],
		["non-string text", [{ type: "text", text: 123 }]],
		["malformed reasoning", [...finalText, { type: "reasoning", text: null }]],
		["malformed usage", [...finalText, { type: "usage", inputTokens: "20", outputTokens: 10 }]],
		["malformed grounding", [...finalText, { type: "grounding", sources: [null] }]],
	])("safely ignores %s in persisted canonical items", (_label, items) => {
		expect(getFinalAssistantMessageIndexes([canonicalAssistant(items)])).toEqual([])
	})

	it.each([
		["null outcome", null],
		["scalar outcome", true],
		["array outcome", []],
		["missing status", {}],
		["unknown status", { status: "success" }],
		["invalid continuation", { status: "completed", requiresContinuation: "false" }],
		["invalid reason", { status: "completed", reason: 123 }],
		["invalid retry flag", { status: "completed", retryable: "false" }],
	])("safely ignores %s in persisted canonical outcomes", (_label, outcome) => {
		expect(getFinalAssistantMessageIndexes([canonicalAssistant(finalText, outcome)])).toEqual([])
	})
})

describe("captureInheritedStepInstructions", () => {
	it("captures invoking-step user guidance with stable host-owned source references", () => {
		const fragments: ApiInstructionFragment[] = [
			{ role: "system", origin: "base-instructions", content: "Model base" },
			{ role: "developer", origin: "agent-rules", content: "Developer fragment" },
			{ role: "user", origin: "agent-rules", content: "Repository rules" },
			{ role: "user", origin: "global-custom-instructions", content: "User guidance" },
			{ role: "user", origin: "tool-instructions", content: "Parent tools" },
			{ role: "user", content: "Unclassified fragment" },
		]
		const capture = captureInheritedStepInstructions("parent", "step-7", fragments)
		fragments[2].content = "Later repository rules"
		fragments.push({ role: "user", origin: "generic-rules", content: "Later guidance" })

		expect(capture).toEqual({
			effectiveText: "Repository rules\n\nUser guidance",
			sources: [
				{ kind: "agent-rules", ref: "task:parent:step:step-7:instruction:0", text: "Repository rules" },
				{
					kind: "global-custom-instructions",
					ref: "task:parent:step:step-7:instruction:1",
					text: "User guidance",
				},
			],
		})
	})
})
