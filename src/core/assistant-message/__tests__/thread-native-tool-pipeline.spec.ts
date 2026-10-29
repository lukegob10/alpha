import { afterEach, describe, expect, it, vi } from "vitest"

import type { ThreadToolName } from "@alpha-code/types"
import { NativeToolCallParser } from "../NativeToolCallParser"

const validCalls: Array<[ThreadToolName, Record<string, unknown>]> = [
	["list_threads", { limit: 50 }],
	["list_archived_threads", { cursor: "opaque-page" }],
	["read_thread", { threadId: "peer", turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 0 }],
	["wait_threads", { targets: [{ threadId: "peer", afterCursor: "opaque-revision" }], timeoutMs: 0 }],
	["create_thread", { prompt: "Inspect parser", title: "Review" }],
	[
		"create_thread",
		{
			prompt: "Inspect parser",
			provider: "openai-native",
			profile: "Saved OpenAI",
			model: "gpt-6-sol",
			reasoning_effort: "high",
		},
	],
	["fork_thread", {}],
	["fork_thread", { threadId: "peer", provider: "anthropic", profile: "Saved Anthropic", reasoning_effort: "high" }],
	["send_message_to_thread", { threadId: "peer", prompt: "Summarize" }],
	[
		"send_message_to_thread",
		{
			threadId: "peer",
			prompt: "Summarize",
			provider: "vscode-lm",
			profile: "Copilot",
			model: "gpt-6-sol",
			reasoning_effort: "xhigh",
		},
	],
	["set_thread_title", { title: "Parser review" }],
	["set_thread_archived", { threadId: "peer", archived: false }],
]

describe("thread native tool pipeline", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		NativeToolCallParser.clearAllStreamingToolCalls()
	})

	it.each(validCalls)("preserves the upstream %s arguments through direct and streamed parsing", (name, args) => {
		const parsed = NativeToolCallParser.parseToolCall({
			id: `direct-${name}`,
			name,
			arguments: JSON.stringify(args),
		})
		expect(parsed?.type).toBe("tool_use")
		if (parsed?.type === "tool_use") expect(parsed.nativeArgs).toEqual(args)
		const id = `streamed-${name}`
		NativeToolCallParser.startStreamingToolCall(id, name)
		expect(NativeToolCallParser.processStreamingChunk(id, JSON.stringify(args))?.nativeArgs).toEqual(args)
		const finalized = NativeToolCallParser.finalizeStreamingToolCall(id)
		expect(finalized?.type).toBe("tool_use")
		if (finalized?.type === "tool_use") expect(finalized.nativeArgs).toEqual(args)
	})

	it.each([
		["list_threads", { cursor: "not-supported" }],
		["list_archived_threads", { limit: 51 }],
		["read_thread", { task_id: "peer" }],
		["wait_threads", { targets: [] }],
		["create_thread", { prompt: "é".repeat(501) }],
		["fork_thread", { mode: "code" }],
		["send_message_to_thread", { threadId: "peer", prompt: "Inspect", model: "" }],
		["set_thread_title", { title: "   " }],
		["set_thread_archived", { threadId: "peer", archived: "true" }],
	] as const)("rejects invalid %s payloads before dispatch", (name, args) => {
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		expect(
			NativeToolCallParser.parseToolCall({ id: `invalid-${name}`, name, arguments: JSON.stringify(args) }),
		).toBeNull()
	})
})
