import { Anthropic } from "@anthropic-ai/sdk"

import { filterNonAnthropicBlocks, VALID_ANTHROPIC_BLOCK_TYPES } from "../anthropic-filter"

describe("anthropic-filter", () => {
	describe("VALID_ANTHROPIC_BLOCK_TYPES", () => {
		it("should contain all valid Anthropic types", () => {
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("text")).toBe(true)
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("image")).toBe(true)
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("tool_use")).toBe(true)
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("tool_result")).toBe(true)
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("thinking")).toBe(true)
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("redacted_thinking")).toBe(true)
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("document")).toBe(true)
		})

		it("should not contain internal or provider-specific types", () => {
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("reasoning")).toBe(false)
			expect(VALID_ANTHROPIC_BLOCK_TYPES.has("thoughtSignature")).toBe(false)
		})
	})

	describe("filterNonAnthropicBlocks", () => {
		it("keeps source message boundaries and cache controls while stripping unsupported metadata", () => {
			const messages = [
				{
					role: "assistant" as const,
					id: "source-response",
					phase: "final_answer",
					memoryCitation: { entries: [], rolloutIds: ["source-1"] },
					agentResponseItems: [{ type: "text", text: "Canonical evidence" }],
					agentResponseOutcome: { status: "completed" },
					content: [
						{
							type: "text" as const,
							text: "Checking",
							id: "progress",
							phase: "commentary",
							outputIndex: 0,
						},
						{
							type: "text" as const,
							text: "Answer",
							id: "answer",
							phase: "final_answer",
							outputIndex: 1,
							memoryCitation: { entries: [], rolloutIds: ["source-1"] },
							cache_control: { type: "ephemeral" as const },
						},
					],
				},
			]
			const snapshot = structuredClone(messages)
			expect(filterNonAnthropicBlocks(messages)).toEqual([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Checking" },
						{ type: "text", text: "Answer", cache_control: { type: "ephemeral" } },
					],
				},
			])
			expect(messages).toEqual(snapshot)
		})
		it("omits Responses metadata from legacy string messages on Anthropic wire", () => {
			const messages = [{ role: "assistant" as const, content: "Answer", id: "original", phase: "final_answer" }]
			expect(filterNonAnthropicBlocks(messages)).toEqual([{ role: "assistant", content: "Answer" }])
			expect(messages[0]).toHaveProperty("id", "original")
		})
		it("should pass through messages with string content", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there!" },
			]

			const result = filterNonAnthropicBlocks(messages)

			expect(result).toEqual(messages)
		})

		it("should pass through messages with valid Anthropic blocks", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there!" }],
				},
			]

			const result = filterNonAnthropicBlocks(messages)

			expect(result).toEqual(messages)
		})

		it("should filter out reasoning blocks from messages", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Hello" },
				{
					role: "assistant",
					content: [
						{ type: "reasoning" as any, text: "Internal reasoning" },
						{ type: "text", text: "Response" },
					],
				},
			]

			const result = filterNonAnthropicBlocks(messages)

			expect(result).toHaveLength(2)
			expect(result[1].content).toEqual([{ type: "text", text: "Response" }])
		})

		it("should filter out thoughtSignature blocks from messages", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Hello" },
				{
					role: "assistant",
					content: [
						{ type: "thoughtSignature", thoughtSignature: "encrypted-sig" } as any,
						{ type: "text", text: "Response" },
					],
				},
			]

			const result = filterNonAnthropicBlocks(messages)

			expect(result).toHaveLength(2)
			expect(result[1].content).toEqual([{ type: "text", text: "Response" }])
		})

		it("should remove messages that become empty after filtering", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Hello" },
				{
					role: "assistant",
					content: [{ type: "reasoning" as any, text: "Only reasoning" }],
				},
				{ role: "user", content: "Continue" },
			]

			const result = filterNonAnthropicBlocks(messages)

			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Hello")
			expect(result[1].content).toBe("Continue")
		})

		it("should handle mixed content with multiple invalid block types", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "Reasoning" } as any,
						{ type: "text", text: "Text 1" },
						{ type: "thoughtSignature", thoughtSignature: "sig" } as any,
						{ type: "text", text: "Text 2" },
					],
				},
			]

			const result = filterNonAnthropicBlocks(messages)

			expect(result).toHaveLength(1)
			expect(result[0].content).toEqual([
				{ type: "text", text: "Text 1" },
				{ type: "text", text: "Text 2" },
			])
		})

		it("should filter out any unknown block types", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "unknown_future_type", data: "some data" } as any,
						{ type: "text", text: "Valid text" },
					],
				},
			]

			const result = filterNonAnthropicBlocks(messages)

			expect(result).toHaveLength(1)
			expect(result[0].content).toEqual([{ type: "text", text: "Valid text" }])
		})
	})
})
