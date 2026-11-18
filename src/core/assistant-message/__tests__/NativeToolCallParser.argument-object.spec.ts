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

	it("validates navigation operations and one-based positions before dispatch", () => {
		const args = { operation: "references", path: "source.ts", line: 1, column: 2 }
		const parse = (overrides: Record<string, unknown>) =>
			NativeToolCallParser.parseToolCall({
				id: "call",
				name: "navigate_code",
				arguments: JSON.stringify({ ...args, ...overrides }),
			})
		expect(parse({})?.nativeArgs).toEqual(args)
		for (const invalid of [{ operation: "rename" }, { line: 0 }, { column: 1.5 }, { path: "" }, { editor: true }]) {
			expect(parse(invalid)).toBeNull()
		}
	})

	it("requires text edit arguments and retains legacy string booleans", () => {
		const args = { file_path: "source.ts", old_string: "abc", new_string: "" }
		const parse = (overrides: Record<string, unknown>) =>
			NativeToolCallParser.parseToolCall({
				id: "call",
				name: "edit",
				arguments: JSON.stringify({ ...args, ...overrides }),
			})
		expect(parse({ replace_all: "true" })?.nativeArgs).toEqual({ ...args, replace_all: true })
		for (const invalid of [
			{ file_path: {} },
			{ old_string: ["a"] },
			{ new_string: null },
			{ replace_all: "other" },
		]) {
			expect(parse(invalid)).toBeNull()
		}
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
