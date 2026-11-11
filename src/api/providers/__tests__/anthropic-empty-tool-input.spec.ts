import { beforeEach, describe, expect, it, vi } from "vitest"

import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import { AnthropicHandler } from "../anthropic"

const { create } = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock("@anthropic-ai/sdk", () => ({
	Anthropic: vi.fn(function () {
		return { messages: { create } }
	}),
}))

function toolStart(name = "get_goal", input: Record<string, unknown> = {}) {
	return { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name, input } }
}

const toolStop = { type: "content_block_stop", index: 0 }
const messageStop = [
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
	{ type: "message_stop" },
]

async function consume(events: unknown[]) {
	create.mockResolvedValue({
		async *[Symbol.asyncIterator]() {
			yield* events
		},
	})
	const accumulator = new AgentResponseAccumulator()
	const handler = new AnthropicHandler({ apiKey: "fixture-key" })
	for await (const chunk of handler.createMessage("system", [])) await accumulator.add(chunk)
	return accumulator.finish()
}

beforeEach(() => create.mockReset())

describe("Anthropic completed tool input", () => {
	it.each([
		{ name: "get_goal", input: {} },
		{ name: "read_file", input: { path: "README.md" } },
	])("retains $name initial input when the completed block has no JSON deltas", async ({ name, input }) => {
		const response = await consume([toolStart(name, input), toolStop, ...messageStop])

		expect(response.outcome).toMatchObject({ status: "completed" })
		expect(response.toolCalls).toEqual([{ type: "tool_call", id: "call", name, arguments: input }])
	})

	it("replaces the initial empty object with streamed arguments", async () => {
		const response = await consume([
			toolStart("read_file"),
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '"README.md"}' },
			},
			toolStop,
			...messageStop,
		])

		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "call", name: "read_file", arguments: { path: "README.md" } },
		])
	})

	it("does not accept an empty input before the tool block completes", async () => {
		const response = await consume([toolStart(), ...messageStop])

		expect(response.outcome).toMatchObject({ status: "incomplete" })
		expect(response.toolCalls).toEqual([])
	})

	it("does not accept an empty input when cancellation interrupts the block", async () => {
		const controller = new AbortController()
		const cancelled = new Error("Request cancelled")
		create.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield toolStart()
				controller.abort(cancelled)
				throw cancelled
			},
		})
		const accumulator = new AgentResponseAccumulator()
		const completed = vi.fn()
		const handler = new AnthropicHandler({ apiKey: "fixture-key" })
		const consumeStream = async () => {
			for await (const chunk of handler.createMessage("system", [], {
				taskId: "fixture-task",
				signal: controller.signal,
			})) {
				await accumulator.add(chunk, undefined, undefined, completed)
			}
		}

		await expect(consumeStream()).rejects.toBe(cancelled)
		const response = await accumulator.finish(undefined, { status: "cancelled" })
		expect(response.toolCalls).toEqual([])
		expect(completed).not.toHaveBeenCalled()
	})
})
