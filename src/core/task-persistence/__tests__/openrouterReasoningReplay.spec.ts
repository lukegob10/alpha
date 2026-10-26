import type { Anthropic } from "@anthropic-ai/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { OpenRouterHandler } from "../../../api/providers/openrouter"
import { convertToOpenAiMessages } from "../../../api/transform/openai-format"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import type { AgentResponse } from "../../agent/AgentResponse"
import { Task } from "../../task/Task"
import type { ApiMessage } from "../apiMessages"
import { buildCanonicalAssistantHistoryContent } from "../canonicalAssistantHistory"
import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"

const { create } = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return { chat: { completions: { create } }, responses: { create: vi.fn() } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})

const configuration = {
	apiProvider: "openrouter" as const,
	apiModelId: "openai/gpt-6.1-sol",
	openRouterApiKey: "synthetic-router-key",
}
const details = [
	{
		type: "reasoning.summary",
		summary: "Before the tool.",
		id: "summary-1",
		index: 0,
		format: "openai-responses-v1",
	},
	{ type: "reasoning.encrypted", data: "opaque+/=\r\n", id: "reasoning-1", index: 1, format: "openai-responses-v1" },
]

interface TaskHistoryBridge {
	apiConversationHistory: ApiMessage[]
	persistAssistantResponseBeforeEffects(
		message: Anthropic.MessageParam,
		reasoning: string,
		response: AgentResponse,
		guard: () => boolean,
	): Promise<boolean>
	addToApiConversationHistory(message: Anthropic.MessageParam): Promise<boolean>
	buildCleanConversationHistory(messages: ApiMessage[]): Anthropic.MessageParam[]
}

function taskHistoryBridge(handler: OpenRouterHandler): TaskHistoryBridge {
	return Object.assign(Object.create(Task.prototype), {
		api: handler,
		apiConfiguration: configuration,
		effectiveApiConfiguration: configuration,
		apiConversationHistory: [],
		saveApiConversationHistory: vi.fn(async () => true),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
		publishCanonicalLifecycleResponseItems: vi.fn(async () => undefined),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => undefined),
	}) as TaskHistoryBridge
}

describe("OpenRouter cancelled reasoning replay", () => {
	beforeEach(() => {
		create.mockReset().mockImplementation(async () =>
			(async function* () {
				yield {
					choices: [{ delta: { reasoning_details: [details[0]] }, finish_reason: null }],
				}
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call-1",
										function: { name: "read_file", arguments: '{"path":"a.ts"}' },
									},
								],
							},
							finish_reason: null,
						},
					],
				}
				yield {
					choices: [{ delta: { reasoning_details: [details[1]] }, finish_reason: "tool_calls" }],
				}
			})(),
		)
	})

	it.each(["before finish", "after accepted call"])(
		"preserves complete signed sequences and excludes unsealed fragments on cancellation %s",
		async (cancelAt) => {
			const handler = new OpenRouterHandler(configuration)
			const controller = new AbortController()
			const accumulator = new AgentResponseAccumulator()
			let cancelled = false
			try {
				for await (const chunk of handler.createMessage("", [], {
					taskId: "router-replay",
					signal: controller.signal,
				})) {
					await accumulator.add(chunk)
					if (
						(cancelAt === "before finish" && chunk.type === "tool_call_partial") ||
						(cancelAt === "after accepted call" && chunk.type === "tool_call_end")
					) {
						cancelled = true
						controller.abort()
					}
				}
			} catch (error) {
				expect(controller.signal.aborted).toBe(true)
				expect((error as Error).name).toBe("AbortError")
			}
			expect(cancelled).toBe(true)
			const response = await accumulator.finish(undefined, { status: "cancelled" })
			const task = taskHistoryBridge(handler)
			expect(
				await task.persistAssistantResponseBeforeEffects(
					{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
					response.reasoning,
					response,
					() => true,
				),
			).toBe(true)
			if (cancelAt === "after accepted call") {
				expect(response.toolCalls).toHaveLength(1)
				await task.addToApiConversationHistory({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call-1",
							content: "Cancelled before execution",
							is_error: true,
						},
					],
				})
			} else {
				expect(response.toolCalls).toHaveLength(0)
			}
			const reloaded: ApiMessage[] = JSON.parse(JSON.stringify(task.apiConversationHistory))
			expect(invalidPersistedApiMessages(reloaded)).toBeUndefined()
			expect(reloaded[0].agentResponseOutcome?.status).toBe("cancelled")
			const replay = convertToOpenAiMessages(task.buildCleanConversationHistory(reloaded), {
				preserveReasoningDetails: true,
			})
			if (cancelAt === "after accepted call") {
				expect(reloaded[0].reasoning_details).toEqual(details)
				expect(replay[0]).toHaveProperty("reasoning_details", details)
				expect(replay[1]).toMatchObject({ role: "tool", tool_call_id: "call-1" })
			} else {
				expect(reloaded[0]).not.toHaveProperty("reasoning_details")
				expect(replay[0]).not.toHaveProperty("reasoning_details")
			}
		},
	)
})
