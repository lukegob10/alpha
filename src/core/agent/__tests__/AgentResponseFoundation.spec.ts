import { describe, expect, it } from "vitest"

import { AgentResponseAccumulator } from "../AgentResponseAccumulator"

describe("AgentResponseAccumulator", () => {
	it("retains text, signed reasoning, usage, grounding, and tool calls", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "text", text: "answer" })
		await accumulator.add({ type: "reasoning", text: "thinking" })
		await accumulator.add({ type: "thinking_complete", signature: "sig-1" })
		await accumulator.add({
			type: "usage",
			inputTokens: 0,
			outputTokens: 4,
			cacheReadTokens: 0,
			reasoningTokens: 2,
		})
		await accumulator.add({
			type: "grounding",
			sources: [{ title: "Source", url: "https://example.test", snippet: "excerpt" }],
		})
		await accumulator.add({ type: "tool_call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' })

		const response = await accumulator.finish()

		expect(response.text).toBe("answer")
		expect(response.reasoning).toBe("thinking")
		expect(response.items).toEqual([
			{ type: "text", text: "answer" },
			{ type: "reasoning", text: "thinking", signature: "sig-1" },
			{ type: "usage", inputTokens: 0, outputTokens: 4, cacheReadTokens: 0, reasoningTokens: 2 },
			{ type: "grounding", sources: [{ title: "Source", url: "https://example.test", snippet: "excerpt" }] },
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
		])
	})

	it("emits indexed calls once and in model order despite duplicate markers", async () => {
		const emitted: string[] = []
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "tool_call_partial", index: 1, id: "call-2", name: "second", arguments: "{}" })
		await accumulator.add({ type: "tool_call_partial", index: 0, id: "call-1", name: "first", arguments: "{}" })
		await accumulator.add({ type: "tool_call_end", id: "call-2" })
		await accumulator.add({ type: "tool_call_end", id: "call-1" })
		await accumulator.add({ type: "tool_call_end", id: "call-1" })

		const onItem = (item: { type: string; name?: string }) => {
			if (item.type === "tool_call") emitted.push(item.name!)
		}
		const response = await accumulator.finish(onItem)
		await accumulator.finish(onItem)

		expect(emitted).toEqual(["first", "second"])
		expect(response.toolCalls.map((call) => call.id)).toEqual(["call-1", "call-2"])
	})

	it("keeps valid calls when a later call has malformed arguments", async () => {
		const response = await new AgentResponseAccumulator().finish()
		expect(response.items).toEqual([])

		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "tool_call", id: "valid", name: "first", arguments: "{}" })
		await accumulator.add({ type: "tool_call", id: "bad", name: "second", arguments: "not-json" })
		const result = await accumulator.finish()

		expect(result.toolCalls).toEqual([{ type: "tool_call", id: "valid", name: "first", arguments: {} }])
		expect(result.items).toContainEqual({
			type: "error",
			message: 'Unable to parse arguments for tool call "second" (bad).',
			callId: "bad",
			toolName: "second",
			retryable: false,
		})
		expect(result.outcome).toEqual({
			status: "failed",
			reason: 'Unable to parse arguments for tool call "second" (bad).',
			retryable: false,
		})
	})

	it("marks provider error responses as failed rather than completed", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({
			type: "error",
			error: "transport failed",
			message: "transport failed",
			code: "EPIPE",
			retryable: true,
		})

		expect(await accumulator.finish(undefined, { status: "completed" })).toMatchObject({
			items: [
				{
					type: "error",
					message: "transport failed",
					code: "EPIPE",
					retryable: true,
				},
			],
			outcome: { status: "failed", reason: "transport failed", retryable: true },
		})
	})

	it("fails colliding persisted tool-call IDs before either call can be dispatched together", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "tool_call", id: "call/a", name: "read_file", arguments: '{"path":"a.ts"}' })
		await accumulator.add({ type: "tool_call", id: "call:a", name: "read_file", arguments: '{"path":"b.ts"}' })

		const result = await accumulator.finish()

		expect(result.toolCalls).toEqual([
			{ type: "tool_call", id: "call/a", name: "read_file", arguments: { path: "a.ts" } },
		])
		expect(result.items.at(-1)).toMatchObject({
			type: "error",
			callId: "call:a",
			retryable: false,
		})
		expect(result.outcome).toMatchObject({
			status: "failed",
			retryable: false,
		})
	})

	it("retains an explicit provider terminal outcome", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({
			type: "text",
			text: "partial",
		})
		await accumulator.add({
			type: "outcome",
			status: "incomplete",
			terminal: true,
			semanticOutputObserved: true,
			reason: "max_output_tokens",
			retryable: false,
		})

		expect((await accumulator.finish()).outcome).toEqual({
			status: "incomplete",
			reason: "max_output_tokens",
			retryable: false,
		})
	})
})
