import { afterEach, describe, expect, it, vi } from "vitest"

import type { ToolName } from "@alpha-code/types"

import { NativeToolCallParser } from "../NativeToolCallParser"

const validCalls: Array<[ToolName, Record<string, unknown>, Record<string, unknown>]> = [
	[
		"create_task",
		{ objective: "Inspect the parser", workspace_mode: "worktree" },
		{ objective: "Inspect the parser", workspace_mode: "worktree" },
	],
	["list_tasks", {}, {}],
	["wait_task", { task_id: "child-1", timeout_ms: null }, { task_id: "child-1", timeout_ms: undefined }],
	[
		"send_task_message",
		{ task_id: "child-1", message: "Keep the result concise." },
		{ task_id: "child-1", message: "Keep the result concise." },
	],
	[
		"steer_task",
		{ task_id: "child-1", message: "Focus on parser recovery." },
		{ task_id: "child-1", message: "Focus on parser recovery." },
	],
	["stop_task", { task_id: "child-1", reason: null }, { task_id: "child-1", reason: undefined }],
]

describe("cross-task native tool pipeline", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		NativeToolCallParser.clearAllStreamingToolCalls()
	})

	it.each(validCalls)("parses %s arguments into the typed execution payload", (name, args, expected) => {
		const result = NativeToolCallParser.parseToolCall({
			id: `cross-task-${name}`,
			name,
			arguments: JSON.stringify(args),
		})

		expect(result?.type).toBe("tool_use")
		if (result?.type === "tool_use") expect(result.nativeArgs).toEqual(expected)
	})

	it.each(validCalls)("preserves %s arguments through streaming finalization", (name, args, expected) => {
		const id = `streamed-cross-task-${name}`
		NativeToolCallParser.startStreamingToolCall(id, name)

		const partial = NativeToolCallParser.processStreamingChunk(id, JSON.stringify(args))
		expect(partial?.nativeArgs).toEqual(expected)

		const result = NativeToolCallParser.finalizeStreamingToolCall(id)
		expect(result?.type).toBe("tool_use")
		if (result?.type === "tool_use") expect(result.nativeArgs).toEqual(expected)
	})

	it.each([
		["create_task", { objective: "Inspect", workspace_mode: "else" }],
		["list_tasks", { extra: true }],
		["wait_task", { task_id: "child-1", timeout_ms: 999 }],
		["send_task_message", { task_id: "not a task id", message: "Hello" }],
		["steer_task", { task_id: "child-1", message: "   " }],
		["stop_task", { task_id: "child-1", reason: "x".repeat(501) }],
	] as const)("rejects invalid %s payloads before dispatch", (name, args) => {
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		const result = NativeToolCallParser.parseToolCall({
			id: `invalid-cross-task-${name}`,
			name,
			arguments: JSON.stringify(args),
		})

		expect(result).toBeNull()
	})
})
