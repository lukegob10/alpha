import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser } from "../NativeToolCallParser"

describe("native tool argument objects", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		vi.spyOn(console, "error").mockImplementation(() => undefined)
	})

	afterEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		vi.restoreAllMocks()
	})

	it.each(["[]", "[{}]", '"unexpected"', "0", "false", "null"])(
		"rejects non-object arguments: %s",
		(argumentsJson) => {
			for (const name of ["list_tasks", "list_mcp_resources"] as const) {
				expect(NativeToolCallParser.parseToolCall({ id: "call", name, arguments: argumentsJson })).toBeNull()
			}
			for (const name of ["mcp--server--tool", "mcp__server__tool"]) {
				expect(
					NativeToolCallParser.parseDynamicMcpTool({ id: "call", name, arguments: argumentsJson }),
				).toBeNull()
			}
		},
	)

	it("does not project an array as a valid zero-argument streaming call", () => {
		NativeToolCallParser.startStreamingToolCall("call", "list_tasks")
		expect(NativeToolCallParser.processStreamingChunk("call", "[]")).toBeNull()
		expect(NativeToolCallParser.finalizeStreamingToolCall("call")).toBeNull()
		expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
	})

	it.each(["", "{}"])("preserves empty object calls and omitted arguments: %j", (argumentsJson) => {
		expect(
			NativeToolCallParser.parseToolCall({ id: "call", name: "list_tasks", arguments: argumentsJson }),
		).toMatchObject({ type: "tool_use", nativeArgs: {} })
		expect(
			NativeToolCallParser.parseDynamicMcpTool({
				id: "call",
				name: "mcp--server--tool",
				arguments: argumentsJson,
			}),
		).toMatchObject({ type: "mcp_tool_use", arguments: {} })
	})

	it("preserves nested structured arguments", () => {
		const args = { query: { filters: ["active", { required: true }], count: 0, cursor: null } }
		expect(
			NativeToolCallParser.parseDynamicMcpTool({
				id: "call",
				name: "mcp--server--tool",
				arguments: JSON.stringify(args),
			}),
		).toMatchObject({ type: "mcp_tool_use", arguments: args })
	})
})
