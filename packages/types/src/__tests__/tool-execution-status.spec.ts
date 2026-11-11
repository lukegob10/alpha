import { describe, expect, it } from "vitest"

import { alphaMessageSchema } from "../message.js"
import { commandExecutionStatusSchema } from "../terminal.js"
import { mcpExecutionStatusSchema } from "../mcp.js"

describe("replayable tool execution presentation", () => {
	const identity = { executionId: "101", taskId: "task", toolCallId: "call" }

	it.each([
		{ ...identity, status: "started", command: "pnpm test", pid: 42 },
		{ ...identity, status: "exited", exitCode: 0 },
		{ ...identity, status: "exited", exitCode: 7 },
		{ ...identity, status: "exited" },
		{ ...identity, status: "error", error: "Launch failed" },
		{ ...identity, status: "cancelled" },
		{ ...identity, status: "timeout" },
	])("preserves command outcome without inferring success: %j", (status) => {
		const message = {
			ts: 101,
			type: "ask",
			ask: "command",
			toolCallId: "call",
			commandExecutionStatus: status,
			commandExecutionOutput: "Preview",
		}
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
	})

	it.each([
		{ ...identity, status: "started", serverName: "server", toolName: "tool" },
		{ ...identity, status: "completed", response: "Result" },
		{ ...identity, status: "error", error: "Server failed" },
		{ ...identity, status: "cancelled" },
	])("preserves MCP outcome and response: %j", (status) => {
		const message = {
			ts: 101,
			type: "ask",
			ask: "use_mcp_server",
			mcpExecutionStatus: status,
			mcpExecutionResponse: "Result",
		}
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
	})

	it("keeps old transcripts readable with an unknown outcome", () => {
		for (const ask of ["command", "use_mcp_server"]) {
			const legacy = { ts: 101, type: "ask", ask, text: "Old tool" }
			expect(alphaMessageSchema.parse(legacy)).toEqual(legacy)
		}
	})

	it("validates status and correlation fields on incoming events", () => {
		expect(commandExecutionStatusSchema.safeParse({ ...identity, status: "success" }).success).toBe(false)
		expect(commandExecutionStatusSchema.safeParse({ ...identity, status: "exited", exitCode: "0" }).success).toBe(
			false,
		)
		expect(mcpExecutionStatusSchema.safeParse({ ...identity, status: "completed", taskId: 123 }).success).toBe(
			false,
		)
	})
})
