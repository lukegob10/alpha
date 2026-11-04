import type { Anthropic } from "@anthropic-ai/sdk"
import { convertToR1Format } from "../r1-format"

describe("R1 reasoning history fidelity", () => {
	it("preserves every reasoning block in an interleaved tool continuation", () => {
		// Canonical history can contain reasoning between text and tool parts.
		const input = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "First thought. " },
					{ type: "text", text: "Checking the file." },
					{ type: "reasoning", text: "Second thought." },
					{ type: "tool_use", id: "read-call", name: "read_file", input: { path: "main.ts" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "read-call", content: "contents" }] },
		] as unknown as Anthropic.Messages.MessageParam[]

		expect(convertToR1Format(input)).toEqual([
			{
				role: "assistant",
				content: "Checking the file.",
				reasoning_content: "First thought. Second thought.",
				tool_calls: [
					{
						id: "read-call",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"main.ts"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "read-call", content: "contents" },
		])
	})

	it.each([false, true])(
		"preserves reasoning while merging consecutive assistant messages (array=%s)",
		(arrayContent) => {
			const input = [
				{ role: "assistant", content: "First", reasoning_content: "First thought. " },
				{
					role: "assistant",
					content: arrayContent
						? [
								{ type: "reasoning", text: "Second " },
								{ type: "reasoning", text: "thought." },
							]
						: "Second",
					...(!arrayContent ? { reasoning_content: "Second thought." } : {}),
				},
			] as unknown as Anthropic.Messages.MessageParam[]

			expect(convertToR1Format(input)[0]).toMatchObject({
				role: "assistant",
				reasoning_content: "First thought. Second thought.",
			})
		},
	)

	it("uses the complete reasoning field once when embedded reasoning is also present", () => {
		const input = [
			{
				role: "assistant",
				reasoning_content: "Complete reasoning.",
				content: [{ type: "reasoning", text: "Embedded duplicate." }],
			},
		] as unknown as Anthropic.Messages.MessageParam[]

		expect(convertToR1Format(input)[0]).toMatchObject({ reasoning_content: "Complete reasoning." })
	})
})
