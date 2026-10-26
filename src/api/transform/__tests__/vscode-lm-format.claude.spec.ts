import type { Anthropic } from "@anthropic-ai/sdk"
import type { VscodeLmThinking } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"
import { convertToVsCodeLmMessages } from "../vscode-lm-format"

const host = vi.hoisted(() => ({ supportsThinking: true }))

vi.mock("vscode", () => {
	class LanguageModelTextPart {
		constructor(public value: string) {}
	}
	class LanguageModelThinkingPart {
		constructor(
			public value: string | string[],
			public id?: string,
			public metadata?: Record<string, unknown>,
		) {}
	}
	class LanguageModelToolCallPart {
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}
	class LanguageModelToolResultPart {
		constructor(
			public callId: string,
			public content: unknown[],
		) {}
	}
	return {
		LanguageModelTextPart,
		LanguageModelToolCallPart,
		LanguageModelToolResultPart,
		LanguageModelDataPart: class {},
		get LanguageModelThinkingPart() {
			return host.supportsThinking ? LanguageModelThinkingPart : undefined
		},
		LanguageModelChatMessage: {
			User: (content: unknown) => ({ role: "user", content }),
			Assistant: (content: unknown) => ({ role: "assistant", content }),
		},
	}
})

// Synthetic state follows Copilot's conversation/vscode-node/languageModelAccess.ts at
// microsoft/vscode 4f383697191fef7129052d5396d5709d5799934a (retrieved 2026-10-25):
// encrypted_content and the origin API survive replay. This is not live-model evidence.
const provenance = {
	modelId: "copilot-claude-opus-5",
	modelVendor: "copilot",
	modelVersion: "claude-opus-5",
}

async function reloadedClaudeHistory(): Promise<Anthropic.Messages.MessageParam[]> {
	const first = new AgentResponseAccumulator()
	await first.add({
		type: "reasoning",
		text: "Inspect both files.",
		vscodeLmThinking: {
			value: "Inspect both files.",
			id: "thinking-a",
			metadata: { encrypted_content: "opaque-a+/=", vscode_thinking_origin_api: "messages" },
			...provenance,
		},
	})
	await first.add({
		type: "reasoning",
		text: "",
		vscodeLmThinking: {
			value: "",
			id: "",
			metadata: {
				vscode_reasoning_done: true,
				vscode_thinking_origin_api: "messages",
			},
			...provenance,
		},
	})
	await first.add({ type: "text", text: "Checking both inputs." })
	for (const [id, file] of [
		["toolu_alpha", "first.txt"],
		["toolu_beta", "second.txt"],
	]) {
		await first.add({
			type: "tool_call",
			id,
			name: "exec_command",
			arguments: JSON.stringify({ cmd: `node inspect.cjs ${file}` }),
		})
	}
	const second = new AgentResponseAccumulator()
	await second.add({
		type: "reasoning",
		text: "",
		vscodeLmThinking: {
			value: "",
			id: "thinking-b",
			metadata: { encrypted_content: "opaque-b+/=", vscode_thinking_origin_api: "messages" },
			...provenance,
		},
	})
	await second.add({ type: "text", text: "Both inputs agree." })
	return JSON.parse(
		JSON.stringify([
			{ role: "user", content: [{ type: "text", text: "Compare both inputs." }] },
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(await first.finish()) },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_alpha", content: "alpha: 42" },
					{ type: "tool_result", tool_use_id: "toolu_beta", content: "beta: 42" },
				],
			},
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(await second.finish()) },
			{ role: "user", content: [{ type: "text", text: "Continue." }] },
		]),
	) as Anthropic.Messages.MessageParam[]
}

describe("Claude Copilot history replay across tool steps", () => {
	afterEach(() => {
		host.supportsThinking = true
	})

	it("reconstructs encrypted thinking and completion markers after reload without leaking Alpha provenance", async () => {
		const history = await reloadedClaudeHistory()
		const saved = JSON.stringify(history)
		const replay = convertToVsCodeLmMessages(history)
		const first = replay[1].content
		const second = replay[3].content

		expect(first).toEqual([
			{
				value: "Inspect both files.",
				id: "thinking-a",
				metadata: { encrypted_content: "opaque-a+/=", vscode_thinking_origin_api: "messages" },
			},
			{
				value: "",
				id: "",
				metadata: {
					vscode_reasoning_done: true,
					vscode_thinking_origin_api: "messages",
				},
			},
			new vscode.LanguageModelTextPart("Checking both inputs."),
			new vscode.LanguageModelToolCallPart("toolu_alpha", "exec_command", { cmd: "node inspect.cjs first.txt" }),
			new vscode.LanguageModelToolCallPart("toolu_beta", "exec_command", { cmd: "node inspect.cjs second.txt" }),
		])
		expect(replay[2].content).toEqual([
			new vscode.LanguageModelToolResultPart("toolu_alpha", [new vscode.LanguageModelTextPart("alpha: 42")]),
			new vscode.LanguageModelToolResultPart("toolu_beta", [new vscode.LanguageModelTextPart("beta: 42")]),
		])
		expect(second).toEqual([
			{
				value: "",
				id: "thinking-b",
				metadata: { encrypted_content: "opaque-b+/=", vscode_thinking_origin_api: "messages" },
			},
			new vscode.LanguageModelTextPart("Both inputs agree."),
		])
		expect(JSON.stringify(replay)).not.toContain("modelId")
		expect(JSON.stringify(replay)).not.toContain("modelVendor")
		expect(JSON.stringify(replay)).not.toContain("modelVersion")

		// A host retaining or mutating a request cannot alter the persisted state or the next retry.
		const thinking = second[0] as unknown as VscodeLmThinking
		thinking.metadata!.encrypted_content = "mutated-by-host"
		expect(JSON.stringify(history)).toBe(saved)
		expect(convertToVsCodeLmMessages(history)[3].content[0]).toMatchObject({
			metadata: { encrypted_content: "opaque-b+/=" },
		})
	})

	it("keeps paired calls, results and visible follow-up when an older host cannot reconstruct thinking", async () => {
		const history = await reloadedClaudeHistory()
		const saved = JSON.stringify(history)
		host.supportsThinking = false
		const replay = convertToVsCodeLmMessages(history)

		expect(replay.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"])
		expect(replay[1].content).toEqual([
			new vscode.LanguageModelTextPart("Checking both inputs."),
			new vscode.LanguageModelToolCallPart("toolu_alpha", "exec_command", { cmd: "node inspect.cjs first.txt" }),
			new vscode.LanguageModelToolCallPart("toolu_beta", "exec_command", { cmd: "node inspect.cjs second.txt" }),
		])
		expect(replay[2].content).toEqual([
			new vscode.LanguageModelToolResultPart("toolu_alpha", [new vscode.LanguageModelTextPart("alpha: 42")]),
			new vscode.LanguageModelToolResultPart("toolu_beta", [new vscode.LanguageModelTextPart("beta: 42")]),
		])
		expect(replay[3].content).toEqual([new vscode.LanguageModelTextPart("Both inputs agree.")])
		expect(JSON.stringify(replay)).not.toContain("opaque-")
		expect(JSON.stringify(history)).toBe(saved)
	})
})
