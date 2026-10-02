import { describe, expect, it } from "vitest"

import type { ApiStreamChunk } from "../../../api/transform/stream"
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

	it("normalizes Codex freeform apply_patch calls for preflight and dispatch", async () => {
		const patch = "*** Begin Patch\r\n*** Add File: src/new-file.ts\r\n+export const value = 1\r\n*** End Patch\r\n"
		const preflightCalls: unknown[] = []
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add(
			{ type: "tool_call", id: "patch-1", name: "apply_patch", arguments: patch },
			undefined,
			(call) => {
				preflightCalls.push(call.arguments)
			},
		)

		const response = await accumulator.finish()

		expect(preflightCalls).toEqual([{ patch }])
		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "patch-1", name: "apply_patch", arguments: { patch } },
		])
	})

	it("assembles a streamed freeform apply_patch before preflight", async () => {
		const patch = "*** Begin Patch\n*** Add File: src/new-file.ts\n+export const value = 1\n*** End Patch\n"
		const preflightArguments: unknown[] = []
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "tool_call_start", id: "patch-stream", name: "apply_patch" })
		await accumulator.add({ type: "tool_call_delta", id: "patch-stream", delta: patch.slice(0, 38) })
		await accumulator.add({ type: "tool_call_delta", id: "patch-stream", delta: patch.slice(38) })
		await accumulator.add({ type: "tool_call_end", id: "patch-stream" }, undefined, (call) => {
			preflightArguments.push(call.arguments)
		})

		const response = await accumulator.finish()

		expect(preflightArguments).toEqual([{ patch }])
		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "patch-stream", name: "apply_patch", arguments: { patch } },
		])
	})

	it("keeps JSON apply_patch function calls unchanged", async () => {
		const patch = "*** Begin Patch\n*** Add File: src/new-file.ts\n+export const value = 1\n*** End Patch\n"
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({
			type: "tool_call",
			id: "patch-json",
			name: "apply_patch",
			arguments: JSON.stringify({ patch }),
		})
		const response = await accumulator.finish()

		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "patch-json", name: "apply_patch", arguments: { patch } },
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

	it("retains a tool call between text fragments while deferring the call until stream completion", async () => {
		const accumulator = new AgentResponseAccumulator()
		const emitted: string[] = []
		let chunksConsumed = 0
		let canonicalCallEmittedAfterChunk: number | undefined
		const onItem = (item: { type: string }) => {
			emitted.push(item.type)
			if (item.type === "tool_call") canonicalCallEmittedAfterChunk = chunksConsumed
		}

		await accumulator.add({ type: "text", text: "First. " }, onItem)
		chunksConsumed += 1
		await accumulator.add({ type: "tool_call_start", id: "call-1", name: "read_file" }, onItem)
		chunksConsumed += 1
		await accumulator.add({ type: "tool_call_delta", id: "call-1", delta: '{"path":"a.ts"}' }, onItem)
		chunksConsumed += 1
		await accumulator.add({ type: "tool_call_end", id: "call-1" }, onItem)
		chunksConsumed += 1
		await accumulator.add({ type: "text", text: "Second." }, onItem)
		chunksConsumed += 1
		expect(emitted).toEqual(["text", "text"])

		const response = await accumulator.finish(onItem)
		expect(emitted).toEqual(["text", "text", "tool_call"])
		expect(canonicalCallEmittedAfterChunk).toBe(5)
		expect(response.items).toEqual([
			{ type: "text", text: "First. " },
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "text", text: "Second." },
		])
	})

	it("reports a stable completed call for preflight before the provider reaches EOF", async () => {
		const accumulator = new AgentResponseAccumulator()
		const readyCalls: Array<{ chunkIndex: number; id: string; name: string; arguments: unknown }> = []
		const chunks: ApiStreamChunk[] = [
			{ type: "text", text: "First. " },
			{ type: "tool_call_start", id: "call-1", name: "read_file" },
			{ type: "tool_call_delta", id: "call-1", delta: '{"path":"a.ts"}' },
			{ type: "tool_call_end", id: "call-1" },
			{ type: "text", text: "Second." },
		]
		let chunksConsumed = 0

		for (const chunk of chunks) {
			chunksConsumed += 1
			await accumulator.add(chunk, undefined, (call) => {
				readyCalls.push({ chunkIndex: chunksConsumed, ...call })
			})
		}

		expect(readyCalls).toEqual([
			{
				chunkIndex: 4,
				type: "tool_call",
				id: "call-1",
				name: "read_file",
				arguments: { path: "a.ts" },
			},
		])
		// The scripted stream has one trailing chunk after the call is complete.
		expect(chunksConsumed - readyCalls[0]!.chunkIndex).toBe(1)

		const response = await accumulator.finish()
		expect(response.items).toEqual([
			{ type: "text", text: "First. " },
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "text", text: "Second." },
		])
	})

	it("reports a validated call after its end marker and before EOF while keeping canonical item ordering", async () => {
		const accumulator = new AgentResponseAccumulator()
		const events: string[] = []
		const completedCalls: string[] = []
		let chunksConsumed = 0
		const chunks: ApiStreamChunk[] = [
			{ type: "text", text: "Before " },
			{ type: "tool_call", id: "call-early", name: "read_file", arguments: '{"path":"a.ts"}' },
			{ type: "tool_call_end", id: "call-early" },
			{ type: "text", text: "after" },
		]

		for (const chunk of chunks) {
			chunksConsumed += 1
			await accumulator.add(
				chunk,
				(item) => {
					events.push(item.type)
				},
				undefined,
				(call) => {
					completedCalls.push(`${chunksConsumed}:${call.id}`)
					events.push("completed")
				},
			)
		}

		expect(completedCalls).toEqual(["3:call-early"])
		expect(events).toEqual(["text", "completed", "text"])

		const response = await accumulator.finish((item) => {
			events.push(item.type)
		})
		expect(events).toEqual(["text", "completed", "text", "tool_call"])
		expect(response.items).toEqual([
			{ type: "text", text: "Before " },
			{ type: "tool_call", id: "call-early", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "text", text: "after" },
		])
	})

	it("does not report partial, malformed, or synthetic calls as completed", async () => {
		const accumulator = new AgentResponseAccumulator()
		const completedCalls: string[] = []
		const onCompleted = (call: { id: string }) => {
			completedCalls.push(call.id)
		}

		await accumulator.add(
			{ type: "tool_call_start", id: "call-partial", name: "read_file" },
			undefined,
			undefined,
			onCompleted,
		)
		await accumulator.add(
			{ type: "tool_call_delta", id: "call-partial", delta: '{"path":"a.ts"}' },
			undefined,
			undefined,
			onCompleted,
		)
		await accumulator.add(
			{ type: "tool_call", id: "call-malformed-args", name: "read_file", arguments: "not-json" },
			undefined,
			undefined,
			onCompleted,
		)
		await accumulator.add(
			{ type: "tool_call", id: "call/malformed-id", name: "read_file", arguments: "{}" },
			undefined,
			undefined,
			onCompleted,
		)
		await accumulator.add(
			{ type: "tool_call", id: "", name: "read_file", arguments: "{}" },
			undefined,
			undefined,
			onCompleted,
		)

		expect(completedCalls).toEqual([])
	})

	it("reports one completion per stable call ID despite duplicate completion markers", async () => {
		const accumulator = new AgentResponseAccumulator()
		const completedCalls: string[] = []
		const onCompleted = (call: { id: string }) => {
			completedCalls.push(call.id)
		}

		await accumulator.add(
			{ type: "tool_call", id: "call-once", name: "read_file", arguments: "{}" },
			undefined,
			undefined,
			onCompleted,
		)
		await accumulator.add(
			{ type: "tool_call", id: "call-once", name: "read_file", arguments: "{}" },
			undefined,
			undefined,
			onCompleted,
		)
		await accumulator.add({ type: "tool_call_end", id: "call-once" }, undefined, undefined, onCompleted)

		expect(completedCalls).toEqual(["call-once"])
	})

	it.each([
		{
			label: "provider error",
			terminalChunk: { type: "error", error: "provider failed", message: "Provider failed." } as ApiStreamChunk,
		},
		{
			label: "incomplete outcome",
			terminalChunk: { type: "outcome", status: "incomplete", reason: "token limit" } as ApiStreamChunk,
		},
	])("blocks later completion notifications after a $label", async ({ terminalChunk }) => {
		const accumulator = new AgentResponseAccumulator()
		const completedCalls: string[] = []
		await accumulator.add(terminalChunk)
		await accumulator.add(
			{ type: "tool_call", id: "call-after-terminal", name: "read_file", arguments: "{}" },
			undefined,
			undefined,
			(call) => {
				completedCalls.push(call.id)
			},
		)

		expect(completedCalls).toEqual([])
	})

	it("does not preflight a call after a provider failure has been observed", async () => {
		const accumulator = new AgentResponseAccumulator()
		const readyCalls: string[] = []
		await accumulator.add({ type: "error", error: "failed", message: "Provider failed." })
		await accumulator.add(
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: "{}" },
			undefined,
			(call) => {
				readyCalls.push(call.id)
			},
		)

		expect(readyCalls).toEqual([])
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

	it.each([
		{ id: "bad", name: "read_file", arguments: "not-json" },
		{ id: "bad", name: "read_file", arguments: "null" },
		{ id: "", name: "read_file", arguments: "{}" },
		{ id: "bad", name: "", arguments: "{}" },
	])("does not hide an invalid call behind a successful provider outcome: %j", async (call) => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "text", text: "Finished." })
		await accumulator.add({ type: "tool_call", ...call })
		await accumulator.add({ type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true })

		const response = await accumulator.finish()

		expect(response.toolCalls).toEqual([])
		expect(response.items.at(-1)).toMatchObject({ type: "error", retryable: false })
		expect(response.outcome).toMatchObject({ status: "failed", retryable: false })
	})

	it("does not hide colliding call IDs behind a successful provider outcome", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "tool_call", id: "call/a", name: "read_file", arguments: "{}" })
		await accumulator.add({ type: "tool_call", id: "call:a", name: "read_file", arguments: "{}" })
		await accumulator.add({ type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true })

		const response = await accumulator.finish()

		expect(response.items.at(-1)).toMatchObject({ type: "error", callId: "call:a", retryable: false })
		expect(response.outcome).toMatchObject({ status: "failed", retryable: false })
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

	it("does not expose buffered tool calls from an incomplete provider response", async () => {
		const emitted: string[] = []
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({
			type: "tool_call_partial",
			index: 0,
			id: "call-truncated",
			name: "apply_patch",
			arguments: '{"patch":"*** Begin Patch"}',
		})
		await accumulator.add({
			type: "outcome",
			status: "incomplete",
			terminal: true,
			semanticOutputObserved: true,
			reason: "output token limit",
		})

		const response = await accumulator.finish((item) => {
			emitted.push(item.type)
		})

		expect(response.outcome).toMatchObject({ status: "incomplete", reason: "output token limit" })
		expect(response.toolCalls).toEqual([])
		expect(emitted).not.toContain("tool_call")
	})

	it("retains a complete accepted call from an incomplete response for terminal receipt repair", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({
			type: "tool_call",
			id: "accepted-before-truncation",
			name: "read_file",
			arguments: '{"path":"README.md"}',
		})
		await accumulator.add({
			type: "outcome",
			status: "incomplete",
			terminal: true,
			semanticOutputObserved: true,
			reason: "output token limit",
		})

		const response = await accumulator.finish()

		expect(response.outcome).toMatchObject({ status: "incomplete", reason: "output token limit" })
		expect(response.toolCalls).toEqual([
			{
				type: "tool_call",
				id: "accepted-before-truncation",
				name: "read_file",
				arguments: { path: "README.md" },
			},
		])
	})

	it.each(["null", "[]", "1", '"text"'])("rejects non-object JSON tool arguments: %s", async (argumentsText) => {
		const readyCalls: unknown[] = []
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add(
			{ type: "tool_call", id: "call-invalid-root", name: "read_file", arguments: argumentsText },
			undefined,
			(call) => {
				readyCalls.push(call)
			},
		)

		const response = await accumulator.finish()

		expect(readyCalls).toEqual([])
		expect(response.toolCalls).toEqual([])
		expect(response.items).toContainEqual({
			type: "error",
			message: 'Unable to parse arguments for tool call "read_file" (call-invalid-root).',
			callId: "call-invalid-root",
			toolName: "read_file",
			retryable: false,
		})
		expect(response.outcome).toMatchObject({ status: "failed", retryable: false })
	})
})
