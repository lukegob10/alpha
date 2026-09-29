import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { formatCommandToolResult, getCommandToolResultLimit, type ToolCallbacks } from "../BaseTool"
import { manageCommandTool } from "../ManageCommandTool"
import { commandSessionRegistry } from "../CommandSessionRegistry"
import { ToolRegistry } from "../ToolRegistry"
import type { Task } from "../../task/Task"
import type { ToolResponse, ToolUse } from "../../../shared/tools"

beforeEach(() => {
	vi.spyOn(commandSessionRegistry, "resolve").mockReturnValue({ executionId: "session-id", process: {} as never })
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("write_stdin adapter", () => {
	it("advertises the numeric session handle accepted by the adapter", () => {
		const schema = new ToolRegistry().resolve("write_stdin")!.schema
		expect(schema.type).toBe("function")
		if (schema.type !== "function") return
		expect(schema.function.parameters).toMatchObject({
			properties: { session_id: { type: "integer", minimum: 1 } },
			required: ["session_id"],
		})
	})

	it.each([
		{ label: "empty poll default", chars: undefined, requested: undefined, expected: 5_000 },
		{ label: "empty poll below minimum", chars: "", requested: 1_000, expected: 5_000 },
		{ label: "empty poll at maximum", chars: "", requested: 300_000, expected: 300_000 },
		{ label: "empty poll above maximum", chars: "", requested: 400_000, expected: 300_000 },
		{ label: "input default", chars: "yes\n", requested: undefined, expected: 250 },
		{ label: "input below minimum", chars: "yes\n", requested: 0, expected: 250 },
		{ label: "input at maximum", chars: "yes\n", requested: 30_000, expected: 30_000 },
		{ label: "input above maximum", chars: "yes\n", requested: 300_000, expected: 30_000 },
	])("uses the Codex-compatible wait bound for $label", async ({ chars, requested, expected }) => {
		const execute = vi.spyOn(manageCommandTool, "execute").mockResolvedValue(undefined)
		const registry = new ToolRegistry()
		const descriptor = registry.resolve("write_stdin")
		expect(descriptor).toBeDefined()

		const call: ToolUse<"write_stdin"> = {
			type: "tool_use",
			id: "write-stdin-call",
			name: "write_stdin",
			params: {},
			partial: false,
			nativeArgs: {
				session_id: 42,
				...(chars === undefined ? {} : { chars }),
				...(requested === undefined ? {} : { yield_time_ms: requested }),
			},
		}
		const callbacks = {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		} as unknown as ToolCallbacks

		await descriptor!.execute({ task: {} as Task, call, callbacks })

		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({
				execution_id: "session-id",
				action: chars ? "input" : "wait",
				timeout_ms: expected,
			}),
			expect.any(Object),
			expect.any(Object),
			expect.any(Function),
			42,
			expect.any(Object),
		)
	})

	it.each([
		{ label: "omitted", requested: undefined, expected: 10_000 },
		{ label: "very large", requested: Number.MAX_VALUE, expected: 100_000 },
		{ label: "fractional", requested: 12.5, expected: 10_000 },
		{ label: "negative", requested: -1, expected: 0 },
	])("caps write_stdin output tokens when the request is $label", async ({ requested, expected }) => {
		const execute = vi.spyOn(manageCommandTool, "execute").mockResolvedValue(undefined)
		const registry = new ToolRegistry()
		const descriptor = registry.resolve("write_stdin")
		const call: ToolUse<"write_stdin"> = {
			type: "tool_use",
			id: "write-stdin-call",
			name: "write_stdin",
			params: {},
			partial: false,
			nativeArgs: {
				session_id: 42,
				...(requested === undefined ? {} : { max_output_tokens: requested }),
			},
		}
		const callbacks = {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		} as unknown as ToolCallbacks

		await descriptor!.execute({ task: {} as Task, call, callbacks })

		expect(execute.mock.calls[0][2].commandResultMaxOutputTokens).toBe(expected)
	})

	it("keeps formatted headers and all text blocks inside the aggregate output cap", async () => {
		const execute = vi.spyOn(manageCommandTool, "execute").mockResolvedValue(undefined)
		const registry = new ToolRegistry()
		const descriptor = registry.resolve("write_stdin")
		const call: ToolUse<"write_stdin"> = {
			type: "tool_use",
			id: "write-stdin-call",
			name: "write_stdin",
			params: {},
			partial: false,
			nativeArgs: { session_id: 42, max_output_tokens: 5 },
		}
		const pushToolResult = vi.fn()
		const callbacks = {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		} as unknown as ToolCallbacks

		await descriptor!.execute({ task: {} as Task, call, callbacks })

		const wrappedCallbacks = execute.mock.calls[0][2]
		expect(wrappedCallbacks.commandResultFormat).toBe("codex")
		expect(wrappedCallbacks.commandResultMaxOutputTokens).toBe(5)
		const blocks: ToolResponse = [
			{ type: "text", text: "a".repeat(15) },
			{ type: "text", text: "b".repeat(15) },
		]
		wrappedCallbacks.pushToolResult(blocks)

		expect(pushToolResult).toHaveBeenCalledWith([
			{ type: "text", text: "a".repeat(15) },
			{ type: "text", text: "b".repeat(5) },
		])
	})

	it("keeps the Codex header intact under a small write_stdin output cap", async () => {
		const execute = vi.spyOn(manageCommandTool, "execute").mockResolvedValue(undefined)
		const registry = new ToolRegistry()
		const descriptor = registry.resolve("write_stdin")
		const call: ToolUse<"write_stdin"> = {
			type: "tool_use",
			id: "write-stdin-call",
			name: "write_stdin",
			params: {},
			partial: false,
			nativeArgs: { session_id: 42, max_output_tokens: 32 },
		}
		const pushToolResult = vi.fn()
		const callbacks = {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		} as unknown as ToolCallbacks

		await descriptor!.execute({ task: {} as Task, call, callbacks })

		const wrappedCallbacks = execute.mock.calls[0][2]
		const content = formatCommandToolResult(
			{ wall_time_seconds: 0.125, output: "x".repeat(1_000), exit_code: 0 },
			getCommandToolResultLimit(wrappedCallbacks),
			"abc123",
		)
		wrappedCallbacks.pushToolResult(content)

		expect(content).toMatch(/^Chunk ID: abc123\nWall time: 0\.1250 seconds\nProcess exited with code 0\nOutput:\n/)
		const output = content.slice(content.indexOf("Output:\n") + "Output:\n".length)
		expect(output.length).toBeLessThanOrEqual(128)
		expect(output).toContain("[output truncated]")
		expect(pushToolResult).toHaveBeenCalledWith(content)
	})
})
