import { describe, expect, it, vi } from "vitest"

import {
	AgentResponseAccumulator,
	AgentTurnEngine,
	collectAgentResponse,
	type AgentResponse,
	type AgentTurnHost,
} from "../AgentTurnEngine"
import type { StepContext } from "../StepContext"

const emptyResponse = (): AgentResponse => ({
	items: [],
	text: "",
	reasoning: "",
	toolCalls: [],
})

const testContext = Object.freeze({ contextId: "test-context" }) as StepContext

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
		await accumulator.add({ type: "tool_call_end", id: "call-1" }, (item) => {
			if (item.type === "tool_call") {
				seen.push(item.name)
			}
		})

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
		})
	})

	it("does not turn an incomplete empty-argument call into an executable tool call", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call_start", id: "call-empty", name: "read_file" } as const
				yield { type: "tool_call_end", id: "call-empty" } as const
			})(),
		)

		expect(response.toolCalls).toEqual([])
		expect(response.items).toContainEqual({
			type: "error",
			message: 'Tool call "read_file" (call-empty) did not provide complete arguments.',
			callId: "call-empty",
			toolName: "read_file",
		})
	})

	it("keeps argument deltas associated by index until a stable ID and name arrive", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call_partial", index: 0, arguments: '{"path":"first.ts"}' } as const
				yield { type: "tool_call_partial", index: 1, arguments: '{"path":"second.ts"}' } as const
				yield { type: "tool_call_partial", index: 0, id: "call-first", name: "read_file" } as const
				yield { type: "tool_call_partial", index: 1, id: "call-second", name: "read_file" } as const
			})(),
		)

		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "call-first", name: "read_file", arguments: { path: "first.ts" } },
			{ type: "tool_call", id: "call-second", name: "read_file", arguments: { path: "second.ts" } },
		])
	})

	it("preserves usage, grounding, and reasoning signatures", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "reasoning", text: "Thinking" } as const
				yield { type: "thinking_complete", signature: "sig-1" } as const
				yield {
					type: "usage",
					inputTokens: 10,
					outputTokens: 4,
					reasoningTokens: 2,
					cacheReadTokens: 8,
				} as const
				yield {
					type: "grounding",
					sources: [{ title: "Source", url: "https://example.test/source" }],
				} as const
			})(),
		)

		expect(response.items).toEqual([
			{ type: "reasoning", text: "Thinking", signature: "sig-1" },
			{ type: "usage", inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 8 },
			{ type: "grounding", sources: [{ title: "Source", url: "https://example.test/source" }] },
		])
	})

	it("normalizes VS Code LM-style complete tool calls", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "text", text: "Inspecting files." } as const
				yield {
					type: "tool_call",
					id: "vscode-call-1",
					name: "read_file",
					arguments: '{"path":"src/index.ts"}',
				} as const
			})(),
		)

		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "vscode-call-1", name: "read_file", arguments: { path: "src/index.ts" } },
		])
	})

	it("normalizes OpenAI Responses-style argument deltas", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "reasoning", text: "I will inspect the file." } as const
				yield { type: "tool_call_partial", index: 0, id: "openai-call-1", name: "read_file" } as const
				yield { type: "tool_call_partial", index: 0, arguments: '{"path":"' } as const
				yield { type: "tool_call_partial", index: 0, arguments: 'README.md"}' } as const
				yield { type: "usage", inputTokens: 100, outputTokens: 20 } as const
			})(),
		)

		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "openai-call-1", name: "read_file", arguments: { path: "README.md" } },
		])
	})

	it("joins indexed deltas when OpenAI provides the call ID after the first chunk", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call_partial", index: 0, arguments: '{"path":"' } as const
				yield {
					type: "tool_call_partial",
					index: 0,
					id: "openai-call-late-id",
					name: "read_file",
					arguments: 'README.md"}',
				} as const
			})(),
		)

		expect(response.toolCalls).toEqual([
			{
				type: "tool_call",
				id: "openai-call-late-id",
				name: "read_file",
				arguments: { path: "README.md" },
			},
		])
	})

	it("normalizes Gemini-style reasoning, grounding, and indexed tool fragments", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "reasoning", text: "Checking the repository." } as const
				yield {
					type: "grounding",
					sources: [{ title: "Repository guide", url: "https://example.test/guide", snippet: "Guide" }],
				} as const
				yield { type: "tool_call_partial", index: 2, id: "gemini-call-1", name: "list_files" } as const
				yield { type: "tool_call_partial", index: 2, arguments: '{"path":"src"}' } as const
			})(),
		)

		expect(response.items).toContainEqual({
			type: "grounding",
			sources: [{ title: "Repository guide", url: "https://example.test/guide", snippet: "Guide" }],
		})
		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "gemini-call-1", name: "list_files", arguments: { path: "src" } },
		])
	})

	it("keeps multiple tool calls in model order and deduplicates IDs", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call_start", id: "call-a", name: "list_files" } as const
				yield { type: "tool_call_delta", id: "call-a", delta: '{"path":"a"}' } as const
				yield { type: "tool_call_start", id: "call-b", name: "list_files" } as const
				yield { type: "tool_call_delta", id: "call-b", delta: '{"path":"b"}' } as const
				// End markers can arrive out of order; the normalized response must
				// retain the model's first-seen order.
				yield { type: "tool_call_end", id: "call-b" } as const
				yield { type: "tool_call_end", id: "call-a" } as const
				yield { type: "tool_call_end", id: "call-a" } as const
			})(),
		)

		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "call-a", name: "list_files", arguments: { path: "a" } },
			{ type: "tool_call", id: "call-b", name: "list_files", arguments: { path: "b" } },
		])
	})

	it("does not emit an incomplete call when the stream is aborted before finish", async () => {
		const accumulator = new AgentResponseAccumulator()
		const seen: unknown[] = []

		await accumulator.add({ type: "tool_call_start", id: "call-1", name: "read_file" }, (item) => {
			seen.push(item)
		})
		await accumulator.add({ type: "tool_call_delta", id: "call-1", delta: '{"path":"unfinished' }, (item) => {
			seen.push(item)
		})

		// An aborted stream does not call finish; no tool item has been emitted.
		await expect(Promise.resolve(seen)).resolves.toEqual([])
	})
})

describe("AgentTurnEngine", () => {
	it("completes a normal no-tool response without a synthetic follow-up", async () => {
		const followUps: string[] = []
		const response: AgentResponse = {
			items: [{ type: "text", text: "The task is complete." }],
			text: "The task is complete.",
			reasoning: "",
			toolCalls: [],
		}
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi.fn(async (input) => {
				followUps.push(input)
				return { response, context: testContext, nextInput: "complete" }
			}),
		}

		const result = await new AgentTurnEngine(host).run("initial")

		expect(result).toEqual({ status: "completed", steps: 1 })
		expect(host.runStep).toHaveBeenCalledTimes(1)
		expect(followUps).toEqual(["initial"])
	})

	it("sequences steps and stops when the host completes", async () => {
		const calls: string[] = []
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi.fn(async (input) => {
				calls.push(input)
				if (input === "first") {
					return { response: emptyResponse(), context: testContext, nextInput: "second" }
				}
				return { response: emptyResponse(), context: testContext, nextInput: "complete" }
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
				return { response: emptyResponse(), context: testContext, nextInput: "next" }
			}),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({ status: "aborted", steps: 1 })
		expect(host.runStep).toHaveBeenCalledTimes(1)
	})

	it("runs the completion callback after each completed step", async () => {
		const completed: number[] = []
		const contexts: StepContext[] = []
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi
				.fn()
				.mockResolvedValueOnce({ response: emptyResponse(), context: testContext, nextInput: "next" })
				.mockResolvedValueOnce({ response: emptyResponse(), context: testContext, nextInput: "complete" }),
			onStepComplete: (_response, step, context) => {
				completed.push(step)
				contexts.push(context)
			},
		}

		await new AgentTurnEngine(host).run("first")

		expect(completed).toEqual([1, 2])
		expect(contexts).toEqual([testContext, testContext])
	})
})
