import { afterEach, describe, expect, it } from "vitest"

import { NativeToolCallParser } from "../NativeToolCallParser"

afterEach(() => {
	NativeToolCallParser.clearAllStreamingToolCalls()
	NativeToolCallParser.clearRawChunkState()
})

describe("native tool call identity", () => {
	it.each([
		{ name: "exec_command", args: { cmd: "fixture command" }, canonicalName: "exec_command" },
		{ name: "shell", args: { command: "fixture command" }, canonicalName: "exec_command" },
		{ name: "list_tasks", args: {}, canonicalName: "list_tasks" },
	] as const)(
		"preserves the provider ID through direct and streamed $name parsing",
		({ name, args, canonicalName }) => {
			const id = `provider_call_${name}_01`
			const encoded = JSON.stringify(args)
			const direct = NativeToolCallParser.parseToolCall({ id, name, arguments: encoded })

			expect(direct).toMatchObject({ type: "tool_use", id, name: canonicalName, partial: false })

			NativeToolCallParser.startStreamingToolCall(id, name, "identity-task")
			const partial = NativeToolCallParser.processStreamingChunk(id, encoded, "identity-task")
			expect(partial).toMatchObject({ type: "tool_use", id, name: canonicalName, partial: true })
			expect(NativeToolCallParser.finalizeStreamingToolCall(id, "identity-task")).toMatchObject({
				type: "tool_use",
				id,
				name: canonicalName,
				partial: false,
			})
			expect(NativeToolCallParser.hasActiveStreamingToolCalls("identity-task")).toBe(false)
		},
	)

	it("keeps the same provider ID contract for dynamic MCP tools", () => {
		const id = "provider_call_mcp_01"
		const name = "mcp--fixture--inspect"
		const encoded = JSON.stringify({ value: "fixture" })
		expect(NativeToolCallParser.parseDynamicMcpTool({ id, name, arguments: encoded })).toMatchObject({
			type: "mcp_tool_use",
			id,
			partial: false,
		})

		NativeToolCallParser.startStreamingToolCall(id, name, "identity-task")
		expect(NativeToolCallParser.processStreamingChunk(id, encoded, "identity-task")).toBeNull()
		expect(NativeToolCallParser.finalizeStreamingToolCall(id, "identity-task")).toMatchObject({
			type: "mcp_tool_use",
			id,
			partial: false,
		})
	})
})
