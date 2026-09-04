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
			callId: "call-1",
			toolName: "read_file",
			retryable: false,
		})
		expect(response.outcome).toEqual({
			status: "failed",
			reason: 'Unable to parse arguments for tool call "read_file" (call-1).',
			retryable: false,
		})
	})
})

describe("AgentTurnEngine", () => {
	it("treats a visible assistant response without tool calls as a completed turn", async () => {
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi.fn(async () => ({
				response: { ...emptyResponse(), text: "The requested explanation." },
				nextInput: "synthetic-recovery",
			})),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "completed",
			steps: 1,
			completionReason: "assistant",
			response: { ...emptyResponse(), text: "The requested explanation." },
		})
		expect(host.runStep).toHaveBeenCalledOnce()
	})

	it("lets hosts require an explicit completion boundary", async () => {
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			canCompleteWithoutTools: () => false,
			runStep: vi
				.fn()
				.mockResolvedValueOnce({
					response: { ...emptyResponse(), text: "Managed child progress." },
					nextInput: "explicit-completion-required",
				})
				.mockResolvedValueOnce({ response: emptyResponse(), nextInput: "complete" }),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "completed",
			steps: 2,
			completionReason: "host",
			response: emptyResponse(),
		})
		expect(host.runStep).toHaveBeenNthCalledWith(2, "explicit-completion-required")
	})

	it("never completes a response that contains a canonical error item", async () => {
		const response: AgentResponse = {
			items: [
				{ type: "text", text: "Partial answer." },
				{ type: "error", message: "Provider stream failed." },
			],
			text: "Partial answer.",
			reasoning: "",
			toolCalls: [],
			outcome: { status: "completed" },
		}
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi.fn(async () => ({ response, nextInput: "complete" as const })),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "failed",
			steps: 1,
			reason: "Provider stream failed.",
			response,
		})
	})

	it.each([
		{
			label: "an explicit attempt_completion call",
			response: {
				...emptyResponse(),
				items: [
					{
						type: "tool_call" as const,
						id: "completion-1",
						name: "attempt_completion",
						arguments: { result: "Finished." },
					},
				],
				toolCalls: [
					{
						type: "tool_call" as const,
						id: "completion-1",
						name: "attempt_completion",
						arguments: { result: "Finished." },
					},
				],
			},
		},
		{
			label: "assistant text accompanied by attempt_completion",
			response: {
				items: [
					{ type: "text" as const, text: "Finished." },
					{
						type: "tool_call" as const,
						id: "completion-1",
						name: "attempt_completion",
						arguments: { result: "Finished." },
					},
				],
				text: "Finished.",
				reasoning: "",
				toolCalls: [
					{
						type: "tool_call" as const,
						id: "completion-1",
						name: "attempt_completion",
						arguments: { result: "Finished." },
					},
				],
			},
		},
	] satisfies Array<{ label: string; response: AgentResponse }>)(
		"treats $label as one host-owned completion step",
		async ({ response }) => {
			const onStepComplete = vi.fn()
			const host: AgentTurnHost<string> = {
				shouldAbort: () => false,
				runStep: vi.fn(async () => ({ response, nextInput: "complete" as const })),
				onStepComplete,
			}

			const result = await new AgentTurnEngine(host).run("first")

			expect(result).toEqual({ status: "completed", steps: 1, completionReason: "host", response })
			expect(host.runStep).toHaveBeenCalledOnce()
			expect(onStepComplete).toHaveBeenCalledOnce()
			expect(onStepComplete).toHaveBeenCalledWith(response, 1)
		},
	)

	it("runs selected continuation input before implicit completion", async () => {
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			canCompleteWithoutTools: () => true,
			runStep: vi
				.fn()
				.mockResolvedValueOnce({
					response: { ...emptyResponse(), text: "First answer." },
					nextInput: "queued-user-message",
					requiresContinuation: true,
				})
				.mockResolvedValueOnce({
					response: { ...emptyResponse(), text: "Answer with queued context." },
					nextInput: "unused-recovery",
				}),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "completed",
			steps: 2,
			completionReason: "assistant",
			response: { ...emptyResponse(), text: "Answer with queued context." },
		})
		expect(host.runStep).toHaveBeenNthCalledWith(2, "queued-user-message")
	})

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

		expect(result).toEqual({
			status: "completed",
			steps: 2,
			completionReason: "host",
			response: emptyResponse(),
		})
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
