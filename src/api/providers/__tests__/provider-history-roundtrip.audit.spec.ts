import type { Anthropic } from "@anthropic-ai/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AnthropicVertexHandler } from "../anthropic-vertex"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import type { AgentResponse } from "../../../core/agent/AgentResponse"
import { Task } from "../../../core/task/Task"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"
import type { ApiMessage } from "../../../core/task-persistence/apiMessages"
import type { ApiStreamChunk } from "../../transform/stream"

const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }))

vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(function () {
		return { messages: { create: createMessage } }
	}),
}))

interface TaskHistoryBridge {
	apiConversationHistory: ApiMessage[]
	addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string): Promise<boolean>
	persistAssistantResponseBeforeEffects(
		message: Anthropic.MessageParam,
		reasoning?: string,
		response?: AgentResponse,
	): Promise<boolean>
	buildCleanConversationHistory(messages: ApiMessage[]): Anthropic.MessageParam[]
}

const options = {
	apiProvider: "vertex" as const,
	apiModelId: "claude-sonnet-4-5@20250929",
	vertexProjectId: "synthetic-project",
	vertexRegion: "global",
	enableReasoningEffort: true,
	modelMaxThinkingTokens: 4096,
}

const toolUse: Anthropic.ToolUseBlockParam = {
	type: "tool_use",
	id: "command-call",
	name: "exec_command",
	input: { cmd: "pwd" },
}

type AssistantBlock =
	| Anthropic.TextBlockParam
	| Anthropic.ThinkingBlockParam
	| Anthropic.RedactedThinkingBlockParam
	| Anthropic.ToolUseBlockParam

function* contentEvents(content: AssistantBlock[]) {
	for (const [index, block] of content.entries()) {
		if (block.type === "thinking") {
			yield { type: "content_block_start", index, content_block: { ...block, thinking: "", signature: "" } }
			yield { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }
			yield { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }
		} else {
			yield { type: "content_block_start", index, content_block: block }
		}
		yield { type: "content_block_stop", index }
	}
}

function scriptedResponse(content: AssistantBlock[], streaming: boolean): unknown {
	if (!streaming) {
		return { content, stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 20 } }
	}
	return (async function* () {
		yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }
		yield* contentEvents(content)
		yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }
		yield { type: "message_stop" }
	})()
}

function historyBridge(handler: AnthropicVertexHandler): TaskHistoryBridge {
	// Exercise real Task persistence and request projection; isolate only disk I/O
	// and unrelated lifecycle notifications, as in openaiReasoningReplay.spec.ts.
	return Object.assign(Object.create(Task.prototype), {
		api: handler,
		apiConfiguration: options,
		effectiveApiConfiguration: options,
		apiConversationHistory: [],
		saveApiConversationHistory: vi.fn(async () => true),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
		publishCanonicalLifecycleResponseItems: vi.fn(async () => undefined),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => undefined),
	}) as TaskHistoryBridge
}

async function nextRequestAssistantContent(content: AssistantBlock[], streaming: boolean, transport?: unknown) {
	createMessage.mockResolvedValueOnce(transport ?? scriptedResponse(content, streaming))
	const handler = new AnthropicVertexHandler({ ...options, vertexStreamingEnabled: streaming })
	const accumulator = new AgentResponseAccumulator()
	let displayedReasoning = ""
	for await (const chunk of handler.createMessage("", [])) {
		await accumulator.add(chunk)
		if (chunk.type === "reasoning") displayedReasoning += chunk.text
	}
	const response = await accumulator.finish()
	expect(response.outcome?.status).toBe("completed")
	expect(response.toolCalls).toHaveLength(1)
	const expectedReasoning = content.flatMap((block) => (block.type === "thinking" ? [block.thinking] : [])).join("")
	expect(displayedReasoning).toBe(expectedReasoning)
	expect(response.reasoning).toBe(expectedReasoning)
	return replayAssistantContent(handler, response, streaming)
}

async function replayAssistantContent(handler: AnthropicVertexHandler, response: AgentResponse, streaming = true) {
	const task = historyBridge(handler)
	expect(
		await task.persistAssistantResponseBeforeEffects(
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
			response.reasoning,
			response,
		),
	).toBe(true)
	expect(
		await task.addToApiConversationHistory({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "F:/workspace" }],
		}),
	).toBe(true)
	const reloaded: ApiMessage[] = JSON.parse(JSON.stringify(task.apiConversationHistory))
	expect(reloaded[0]).toMatchObject({ agentResponseItems: response.items, agentResponseOutcome: response.outcome })
	createMessage.mockResolvedValueOnce(scriptedResponse([{ type: "text", text: "Done." }], streaming))
	for await (const _chunk of handler.createMessage("", task.buildCleanConversationHistory(reloaded))) {
		// Fully consume the next request through the real adapter.
	}
	const params = createMessage.mock.calls.at(-1)![0] as { messages: Anthropic.MessageParam[] }
	return params.messages.find((message) => message.role === "assistant")?.content
}

// Provider contract retrieved 2026-10-11:
// https://platform.claude.com/docs/en/build-with-claude/thinking#redacted-thinking-blocks
// Thinking and redacted blocks must survive tool-result round trips unchanged.
// Codex reference pin: cc7ba33601286a751477832b01de7b6f8de0dd9c;
// codex-rs/core/src/context_manager/history.rs preserves ordered response items.
describe("provider history round-trip", () => {
	beforeEach(() => createMessage.mockReset())

	it.each([false, true])("preserves redacted thinking in the next request (streaming=%s)", async (streaming) => {
		const content: AssistantBlock[] = [{ type: "redacted_thinking", data: "opaque-redacted+/=" }, toolUse]
		expect(await nextRequestAssistantContent(content, streaming)).toEqual(content)
	})

	it.each([false, true])("preserves signed empty thinking in the next request (streaming=%s)", async (streaming) => {
		const content: AssistantBlock[] = [{ type: "thinking", thinking: "", signature: "opaque-empty+/=" }, toolUse]
		expect(await nextRequestAssistantContent(content, streaming)).toEqual(content)
	})

	it.each([false, true])("preserves separately signed thinking blocks (streaming=%s)", async (streaming) => {
		const content: AssistantBlock[] = [
			{ type: "thinking", thinking: "First block.", signature: "opaque-first+/=" },
			{ type: "thinking", thinking: "Second block.", signature: "opaque-second+/=" },
			toolUse,
		]
		expect(await nextRequestAssistantContent(content, streaming)).toEqual(content)
	})

	it.each([false, true])("preserves one signed nonempty block (streaming=%s)", async (streaming) => {
		const content: AssistantBlock[] = [
			{ type: "thinking", thinking: "One block.", signature: "opaque-complete-signature+/=" },
			toolUse,
		]
		expect(await nextRequestAssistantContent(content, streaming)).toEqual(content)
	})

	it.each([false, true])(
		"preserves interleaved signed, redacted, text, and tool blocks (streaming=%s)",
		async (streaming) => {
			const content: AssistantBlock[] = [
				{ type: "thinking", thinking: "First block.", signature: "opaque-first+/=" },
				{ type: "text", text: "Checking the command." },
				{ type: "redacted_thinking", data: "opaque-redacted+/=" },
				toolUse,
				{ type: "thinking", thinking: "", signature: "opaque-empty+/=" },
				{ type: "text", text: "Waiting for the result." },
			]
			expect(await nextRequestAssistantContent(content, streaming)).toEqual(content)
		},
	)

	it("replaces signature snapshots and seals each indexed thinking block once", async () => {
		// SDK MessageStream.ts at 2979ed5cef4b2f059b95af23e08728c01e588f86:
		// signature_delta replaces the signature at event.index; it does not concatenate.
		const content: AssistantBlock[] = [
			{ type: "thinking", thinking: "A complete block.", signature: "replacement-signature+/=" },
			toolUse,
		]
		const transport = (async function* () {
			for (const event of contentEvents(content)) {
				if (event.type === "content_block_stop" && event.index === 0) {
					yield {
						type: "content_block_delta",
						index: 0,
						delta: { type: "signature_delta", signature: "replacement-signature+/=" },
					}
				}
				if (event.delta?.type === "signature_delta") {
					yield { ...event, delta: { type: "signature_delta", signature: "superseded-snapshot" } }
				} else {
					yield event
				}
			}
			yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }
			yield { type: "message_stop" }
		})()
		expect(await nextRequestAssistantContent(content, true, transport)).toEqual(content)
	})

	it.each(["eof", "terminal", "cancelled", "failed"] as const)(
		"retains sealed reasoning and usage without signing an interrupted block (%s)",
		async (ending) => {
			const sealed: AssistantBlock[] = [
				{ type: "thinking", thinking: "Saved reasoning.", signature: "sealed-signature+/=" },
				{ type: "redacted_thinking", data: "sealed-redacted+/=" },
				toolUse,
			]
			const controller = new AbortController()
			const failure =
				ending === "cancelled"
					? new DOMException("Request aborted", "AbortError")
					: new Error("Provider disconnected")
			createMessage.mockResolvedValueOnce(
				(async function* () {
					yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }
					yield* contentEvents(sealed)
					yield {
						type: "content_block_start",
						index: 3,
						content_block: { type: "thinking", thinking: "", signature: "" },
					}
					yield {
						type: "content_block_delta",
						index: 3,
						delta: { type: "thinking_delta", thinking: "Unfinished reasoning." },
					}
					yield {
						type: "content_block_delta",
						index: 3,
						delta: { type: "signature_delta", signature: "unsealed-signature" },
					}
					yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }
					if (ending === "terminal") yield { type: "message_stop" }
					if (ending === "cancelled") controller.abort(failure)
					if (ending === "cancelled" || ending === "failed") throw failure
				})(),
			)
			const handler = new AnthropicVertexHandler({ ...options, vertexStreamingEnabled: true })
			const accumulator = new AgentResponseAccumulator()
			let outputTokens = 0
			let caught: unknown
			try {
				for await (const chunk of handler.createMessage("", [], {
					taskId: "interrupted-history",
					signal: controller.signal,
				})) {
					if (chunk.type === "usage") outputTokens += chunk.outputTokens
					await accumulator.add(chunk)
				}
			} catch (error) {
				caught = error
			}
			const outcome = ending === "cancelled" || ending === "failed" ? { status: ending } : undefined
			const response = await accumulator.finish(undefined, outcome)
			expect(caught).toBe(outcome ? failure : undefined)
			expect(response.outcome?.status).toBe(outcome?.status ?? "incomplete")
			expect(handler.getThoughtSignature()).toBeUndefined()
			expect(outputTokens).toBe(5)
			expect(response.reasoning).toBe("Saved reasoning.Unfinished reasoning.")
			expect(response.items).toContainEqual({ type: "reasoning", text: "Unfinished reasoning.", outputIndex: 3 })
			expect(response.items.filter((item) => item.type === "reasoning" && item.signature)).toHaveLength(1)
			expect(createMessage).toHaveBeenCalledOnce()
			expect(await replayAssistantContent(handler, response)).toEqual(sealed)
		},
	)

	it("reports cumulative Anthropic token counts once through the additive usage contract", async () => {
		// https://platform.claude.com/docs/en/build-with-claude/streaming#event-types
		// message_delta usage is cumulative; the SDK overwrites rather than adds.
		createMessage.mockResolvedValueOnce(
			(async function* () {
				yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "Done." } }
				yield { type: "content_block_stop", index: 0 }
				yield { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 5 } }
				yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }
				yield { type: "message_stop" }
			})(),
		)
		const handler = new AnthropicVertexHandler({ ...options, vertexStreamingEnabled: true })
		let outputTokens = 0
		for await (const chunk of handler.createMessage("", [])) {
			// Task.ts consumes usage as deltas (outputTokens += chunk.outputTokens).
			if (chunk.type === "usage") outputTokens += chunk.outputTokens
		}
		expect(outputTokens).toBe(9)
	})

	it("normalizes repeated, stale, and optional usage snapshots independently for each request", async () => {
		const handler = new AnthropicVertexHandler({ ...options, vertexStreamingEnabled: true })
		for (let request = 0; request < 2; request++) {
			createMessage.mockResolvedValueOnce(
				(async function* () {
					yield {
						type: "message_start",
						message: {
							usage: {
								input_tokens: 10,
								output_tokens: 1,
								cache_creation_input_tokens: 3,
								cache_read_input_tokens: 2,
							},
						},
					}
					const update = {
						input_tokens: 12,
						output_tokens: 5,
						cache_creation_input_tokens: 5,
						cache_read_input_tokens: 3,
					}
					yield { type: "message_delta", delta: { stop_reason: null }, usage: update }
					yield { type: "message_delta", delta: { stop_reason: null }, usage: update }
					yield { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 3 } }
					yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }
					yield { type: "message_stop" }
				})(),
			)
			const usages: Extract<ApiStreamChunk, { type: "usage" }>[] = []
			for await (const chunk of handler.createMessage("", [])) if (chunk.type === "usage") usages.push(chunk)
			expect(usages.map((usage) => usage.outputTokens)).toEqual([1, 4, 0, 0, 4])
			expect(usages.reduce((sum, usage) => sum + usage.inputTokens, 0)).toBe(12)
			expect(usages.reduce((sum, usage) => sum + (usage.cacheWriteTokens ?? 0), 0)).toBe(5)
			expect(usages.reduce((sum, usage) => sum + (usage.cacheReadTokens ?? 0), 0)).toBe(3)
		}
	})
})
