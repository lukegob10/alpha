/**
 * Tests for new_task tool isolation enforcement.
 *
 * These tests verify the runtime enforcement that prevents tools from executing
 * when `new_task` appears in a parallel tool batch. When `new_task` is called
 * alongside other tools, the whole tool turn is rejected and every tool_use gets
 * a matching error tool_result.
 *
 * This prevents orphaned tools when delegation disposes the parent task and
 * keeps provider-native tool histories valid.
 */

import type { Anthropic } from "@anthropic-ai/sdk"

describe("new_task Tool Isolation Enforcement", () => {
	/**
	 * Simulates the new_task isolation enforcement logic from Task.ts. This tests
	 * the all-or-nothing rejection that happens when building assistant message
	 * content for the API.
	 */
	const enforceNewTaskIsolation = (
		assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam>,
	): {
		content: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam>
		injectedToolResults: Anthropic.ToolResultBlockParam[]
	} => {
		const injectedToolResults: Anthropic.ToolResultBlockParam[] = []

		const assistantToolUses = assistantContent.filter(
			(block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use",
		)
		const hasMixedNewTaskBatch =
			assistantToolUses.length > 1 && assistantToolUses.some((block) => block.name === "new_task")

		if (hasMixedNewTaskBatch) {
			for (const tool of assistantToolUses) {
				if (tool.id) {
					injectedToolResults.push({
						type: "tool_result",
						tool_use_id: tool.id,
						content:
							"new_task must be called by itself in a message turn. No tools from this turn were executed. Retry by calling only new_task after any required setup is complete.",
						is_error: true,
					})
				}
			}
		}

		return { content: assistantContent, injectedToolResults }
	}

	describe("new_task as last tool (no truncation needed)", () => {
		it("should not truncate when new_task is the only tool", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(1)
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("should reject when new_task is batched after another tool", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(2)
			expect(result.injectedToolResults.map((result) => result.tool_use_id)).toEqual([
				"toolu_read_1",
				"toolu_new_task_1",
			])
		})

		it("should not truncate when there is no new_task tool", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_write_1",
					name: "write_to_file",
					input: { path: "test.txt", content: "hello" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(2)
			expect(result.injectedToolResults).toHaveLength(0)
		})
	})

	describe("new_task batched with other tools (turn rejection required)", () => {
		it("should preserve API history content and reject every tool", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(2)
			expect(result.injectedToolResults).toHaveLength(2)
			expect(result.injectedToolResults.map((toolResult) => toolResult.tool_use_id)).toEqual([
				"toolu_new_task_1",
				"toolu_read_1",
			])
		})

		it("should inject error tool_results for the whole mixed turn", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.injectedToolResults).toHaveLength(2)
			expect(result.injectedToolResults[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "toolu_new_task_1",
				is_error: true,
			})
			expect(result.injectedToolResults[1]).toMatchObject({
				type: "tool_result",
				tool_use_id: "toolu_read_1",
				is_error: true,
			})
			expect(result.injectedToolResults[0].content).toContain("new_task must be called by itself")
		})

		it("should reject multiple tools batched with new_task", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_write_1",
					name: "write_to_file",
					input: { path: "test.txt", content: "hello" },
				},
				{
					type: "tool_use",
					id: "toolu_execute_1",
					name: "execute_command",
					input: { command: "ls" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(4)
			expect(result.injectedToolResults).toHaveLength(4)

			const rejectedIds = result.injectedToolResults.map((r) => r.tool_use_id)
			expect(rejectedIds).toContain("toolu_new_task_1")
			expect(rejectedIds).toContain("toolu_read_1")
			expect(rejectedIds).toContain("toolu_write_1")
			expect(rejectedIds).toContain("toolu_execute_1")
		})

		it("should reject tools before new_task too", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_write_1",
					name: "write_to_file",
					input: { path: "test.txt", content: "hello" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(3)
			expect(result.injectedToolResults.map((toolResult) => toolResult.tool_use_id)).toEqual([
				"toolu_read_1",
				"toolu_new_task_1",
				"toolu_write_1",
			])
		})
	})

	describe("Mixed content (text and tools)", () => {
		it("should handle text blocks before new_task", () => {
			const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [
				{
					type: "text",
					text: "I will delegate this task.",
				},
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(3)
			expect(result.injectedToolResults).toHaveLength(2)
			expect(result.injectedToolResults.map((toolResult) => toolResult.tool_use_id)).toEqual([
				"toolu_new_task_1",
				"toolu_read_1",
			])
		})

		it("should not count text blocks when checking if new_task is last tool", () => {
			// This is a subtle case - if text comes AFTER new_task, we need to decide
			// whether that counts as "new_task is last tool". The implementation only
			// checks array position, so text after new_task means new_task is NOT last.
			// However, text blocks don't need tool_results, so this is fine.
			const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "text",
					text: "Done delegating.",
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(2)
			expect(result.injectedToolResults).toHaveLength(0)
		})
	})

	describe("Edge cases", () => {
		it("should handle empty content array", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = []

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(0)
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("should handle tool without id (should not inject error result)", () => {
			const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				// Simulating a malformed tool without ID (shouldn't happen, but defensive)
				{
					type: "tool_use",
					name: "read_file",
					input: { path: "test.txt" },
				} as any,
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(2)
			expect(result.injectedToolResults).toHaveLength(1)
			expect(result.injectedToolResults[0].tool_use_id).toBe("toolu_new_task_1")
		})

		it("should reject every valid tool id when multiple new_task calls exist", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "First task" },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_2",
					name: "new_task",
					input: { mode: "debug", message: "Second task" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.content).toHaveLength(3)
			expect(result.injectedToolResults.map((toolResult) => toolResult.tool_use_id)).toEqual([
				"toolu_read_1",
				"toolu_new_task_1",
				"toolu_new_task_2",
			])
		})
	})

	describe("Error message content", () => {
		it("should include descriptive error message", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.injectedToolResults[0].content).toContain("new_task must be called by itself")
			expect(result.injectedToolResults[0].content).toContain("No tools from this turn were executed")
		})

		it("should mark error results with is_error: true", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.injectedToolResults[0].is_error).toBe(true)
		})
	})
})
