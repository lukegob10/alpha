import { describe, expect, it, vi } from "vitest"

import {
	AgentResponseAccumulator,
	AgentTurnEngine,
	collectAgentResponse,
	type AgentResponse,
	type AgentTurnHost,
} from "../AgentTurnEngine"

const emptyResponse = (): AgentResponse => ({
	items: [],
	text: "",
	reasoning: "",
	toolCalls: [],
})

describe("AgentResponseAccumulator", () => {
	it("forwards text and reasoning while keeping tool calls buffered", async () => {
		const accumulator = new AgentResponseAccumulator()
		const seen: string[] = []

		await accumulator.add({ type: "text", text: "before " }, (item) => {
			if (item.type === "text") {
				seen.push(item.text)
			}
		})
		await accumulator.add({ type: "tool_call_start", id: "call-1", name: "read_file" })
		await accumulator.add({ type: "tool_call_delta", id: "call-1", delta: '{"path":"a.ts"}' })

		expect(seen).toEqual(["before "])
		const response = await accumulator.finish((item) => {
			if (item.type === "tool_call") {
				seen.push(item.name)
			}
		})

		expect(seen).toEqual(["before ", "read_file"])
		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
		])
	})

	it("does not duplicate tool calls with duplicate end markers or IDs", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call_start", id: "call-1", name: "read_file" } as const
				yield { type: "tool_call_delta", id: "call-1", delta: '{"path":"a.ts"}' } as const
				yield { type: "tool_call_end", id: "call-1" } as const
				yield { type: "tool_call_end", id: "call-1" } as const
				yield { type: "tool_call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' } as const
			})(),
		)

		expect(response.toolCalls).toHaveLength(1)
	})

	it("returns a structured error for malformed tool arguments", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call", id: "call-1", name: "read_file", arguments: "not-json" } as const
			})(),
		)

		expect(response.toolCalls).toHaveLength(0)
		expect(response.items).toContainEqual({
			type: "error",
			message: 'Unable to parse arguments for tool call "read_file" (call-1).',
		})
	})
})

describe("AgentTurnEngine", () => {
	it("sequences steps and stops when the host completes", async () => {
		const calls: string[] = []
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi.fn(async (input) => {
				calls.push(input)
				if (input === "first") {
					return { response: emptyResponse(), nextInput: "second" }
				}
				return { response: emptyResponse(), nextInput: "complete" }
			}),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({ status: "completed", steps: 2 })
		expect(calls).toEqual(["first", "second"])
	})

	it("does not start another step after abort", async () => {
		let aborted = false
		const host: AgentTurnHost<string> = {
			shouldAbort: () => aborted,
			runStep: vi.fn(async () => {
				aborted = true
				return { response: emptyResponse(), nextInput: "next" }
			}),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({ status: "aborted", steps: 1 })
		expect(host.runStep).toHaveBeenCalledTimes(1)
	})

	it("runs the completion callback after each completed step", async () => {
		const completed: number[] = []
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi
				.fn()
				.mockResolvedValueOnce({ response: emptyResponse(), nextInput: "next" })
				.mockResolvedValueOnce({ response: emptyResponse(), nextInput: "complete" }),
			onStepComplete: (_response, step) => {
				completed.push(step)
			},
		}

		await new AgentTurnEngine(host).run("first")

		expect(completed).toEqual([1, 2])
	})
})
