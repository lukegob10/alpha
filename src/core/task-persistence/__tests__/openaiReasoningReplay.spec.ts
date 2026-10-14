import type { Anthropic } from "@anthropic-ai/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { OpenAiHandler } from "../../../api/providers/openai"
import { buildOpenAiResponsesInput } from "../../../api/providers/openai-responses"
import { createAgentResponse, type AgentResponse } from "../../agent/AgentResponse"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { Task } from "../../task/Task"
import { buildCanonicalAssistantHistoryContent } from "../canonicalAssistantHistory"
import type { ApiMessage } from "../apiMessages"
import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(() => ({
		chat: { completions: { create: vi.fn() } },
		responses: { create: responsesCreate },
	}))
	return { default: constructor, AzureOpenAI: constructor }
})

interface TaskHistoryBridge {
	apiConversationHistory: ApiMessage[]
	addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string): Promise<boolean>
	persistAssistantResponseBeforeEffects(
		message: Anthropic.MessageParam,
		reasoning?: string,
		response?: AgentResponse,
	): Promise<boolean>
	buildCleanConversationHistory(messages: ApiMessage[]): unknown[]
}

const options = {
	apiProvider: "openai" as const,
	openAiModelId: "gpt-6.1-sol",
	openAiApiKey: "synthetic-test-key",
	openAiBaseUrl: "https://api.openai.com/v1",
}

function assistantMessage(id: string, text: string) {
	return {
		id,
		type: "message" as const,
		role: "assistant" as const,
		status: "completed" as const,
		content: [{ type: "output_text" as const, text, annotations: [] }],
	}
}

const firstReasoning = {
	id: "reasoning-before-read",
	type: "reasoning" as const,
	encrypted_content: "opaque-before-read+/=\r\n",
	summary: [{ type: "summary_text" as const, text: "First summary." }],
}
const secondReasoning = {
	id: "reasoning-after-read",
	type: "reasoning" as const,
	encrypted_content: "opaque-after-read+/=\n",
	summary: [{ type: "summary_text" as const, text: "Second summary." }],
}
const call = {
	id: "function-item",
	type: "function_call" as const,
	status: "completed" as const,
	call_id: "read-call",
	name: "read_file",
	arguments: '{"path":"a.ts"}',
}
const output = [
	assistantMessage("message-before", "Before the read."),
	firstReasoning,
	call,
	secondReasoning,
	assistantMessage("message-after", "After the read."),
]
const providerResponse = { id: "response-ordered", status: "completed", output, usage: null }
const variants = [
	"nonstreaming",
	"streamed receipts",
	"final-only reasoning",
	"late opaque metadata",
	"updated summary",
]

function mockProviderResponse(variant: string) {
	responsesCreate.mockResolvedValueOnce(
		variant === "nonstreaming"
			? providerResponse
			: (async function* () {
					for (const [output_index, item] of output.entries()) {
						if (item.type === "reasoning" && variant === "final-only reasoning") continue
						if (item.type === "message") {
							for (const delta of [item.content[0]!.text.slice(0, 5), item.content[0]!.text.slice(5)]) {
								yield { type: "response.output_text.delta", output_index, content_index: 0, delta }
							}
						} else if (item.type === "function_call") {
							yield { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } }
							for (const delta of [item.arguments.slice(0, 7), item.arguments.slice(7)]) {
								yield { type: "response.function_call_arguments.delta", output_index, delta }
							}
						}
						const streamedItem =
							item.type === "reasoning" && variant === "late opaque metadata"
								? { ...item, encrypted_content: undefined }
								: item.type === "reasoning" && variant === "updated summary"
									? { ...item, summary: [] }
									: item
						// Duplicate receipts and the completed response are the same item.
						yield { type: "response.output_item.done", output_index, item: streamedItem }
						yield { type: "response.output_item.done", output_index, item: streamedItem }
					}
					yield { type: "response.completed", response: providerResponse }
				})(),
	)
}

function createTaskHistoryBridge(handler: OpenAiHandler): TaskHistoryBridge {
	// Keep real Task write-time persistence and request projection. Replace only
	// disk I/O, inbox settlement, and unrelated lifecycle publication.
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

async function collectResponse(handler: OpenAiHandler): Promise<AgentResponse> {
	const accumulator = new AgentResponseAccumulator()
	for await (const chunk of handler.createMessage("", [])) await accumulator.add(chunk)
	return accumulator.finish()
}

async function addToolResult(task: TaskHistoryBridge, text = "File contents.", isError = false) {
	expect(
		await task.addToApiConversationHistory({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "read-call", content: text, is_error: isError }],
		}),
	).toBe(true)
}

function expectedReplay(store: boolean) {
	return [
		{
			type: "message",
			role: "assistant",
			id: "message-before",
			content: [{ type: "output_text", text: "Before the read.", annotations: [] }],
		},
		{
			type: "reasoning",
			encrypted_content: firstReasoning.encrypted_content,
			summary: firstReasoning.summary,
			...(store ? { id: firstReasoning.id } : {}),
		},
		{ type: "function_call", call_id: "read-call", name: "read_file", arguments: call.arguments },
		{
			type: "reasoning",
			encrypted_content: secondReasoning.encrypted_content,
			summary: secondReasoning.summary,
			...(store ? { id: secondReasoning.id } : {}),
		},
		{
			type: "message",
			role: "assistant",
			id: "message-after",
			content: [{ type: "output_text", text: "After the read.", annotations: [] }],
		},
		{ type: "function_call_output", call_id: "read-call", output: "File contents." },
	]
}

// Codex pin, retrieved 2026-10-11:
// https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context_manager/history.rs
// Ordered response items survive for_prompt_annotated. The same pin's client.rs
// history_dedupes_streamed_and_final_messages_across_turns covers final receipts.
describe("OpenAI reasoning persistence and replay", () => {
	beforeEach(() => responsesCreate.mockReset())

	it.each(variants)("replays opaque reasoning at its original output positions: %s", async (variant) => {
		mockProviderResponse(variant)
		const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: variant !== "nonstreaming" })
		const response = await collectResponse(handler)
		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "read-call", name: "read_file", arguments: { path: "a.ts" } },
		])
		expect(response.items.filter((item) => item.type === "reasoning")).toEqual([
			{
				type: "reasoning",
				text: "",
				encryptedContent: firstReasoning.encrypted_content,
				id: firstReasoning.id,
				summary: firstReasoning.summary,
			},
			{
				type: "reasoning",
				text: "",
				encryptedContent: secondReasoning.encrypted_content,
				id: secondReasoning.id,
				summary: secondReasoning.summary,
			},
		])
		expect(handler.getReasoningItems()).toHaveLength(2)

		const task = createTaskHistoryBridge(handler)
		expect(
			await task.addToApiConversationHistory(
				{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
				"Legacy aggregate summary must not add another reasoning prefix.",
			),
		).toBe(true)
		await addToolResult(task)
		// Reload has no provider stream available to reconstruct discarded order.
		const reloaded: ApiMessage[] = JSON.parse(JSON.stringify(task.apiConversationHistory))
		expect(invalidPersistedApiMessages(reloaded)).toBeUndefined()
		expect(reloaded[0]!.content).toEqual([
			{ type: "text", text: "Before the read.", id: "message-before", outputIndex: 0 },
			firstReasoning,
			{ type: "tool_use", id: "read-call", name: "read_file", input: { path: "a.ts" } },
			secondReasoning,
			{ type: "text", text: "After the read.", id: "message-after", outputIndex: 4 },
		])
		for (const store of [false, true]) {
			expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), store)).toEqual(
				expectedReplay(store),
			)
		}
	})

	it("retains canonical opaque metadata across reload and scopes deduplication to each response", async () => {
		const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: true })
		const task = createTaskHistoryBridge(handler)
		for (let turn = 0; turn < 2; turn++) {
			mockProviderResponse("streamed receipts")
			const response = await collectResponse(handler)
			expect(
				await task.persistAssistantResponseBeforeEffects(
					{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
					response.reasoning,
					response,
				),
			).toBe(true)
			await addToolResult(task)
			const reloaded: ApiMessage[] = JSON.parse(JSON.stringify(task.apiConversationHistory))
			expect(reloaded[turn * 2]).toHaveProperty("agentResponseItems", response.items)
			expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), false)).toEqual(
				Array.from({ length: turn + 1 }, () => expectedReplay(false)).flat(),
			)
		}
	})

	it.each(["failed", "cancelled"] as const)("retains received opaque items after a %s stream", async (status) => {
		const controller = new AbortController()
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				for (const [output_index, item] of output.slice(0, 4).entries()) {
					yield { type: "response.output_item.done", output_index, item }
				}
				if (status === "cancelled") controller.abort(new Error("request cancelled"))
				else throw new Error("provider failed")
			})(),
		)
		const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: true })
		const accumulator = new AgentResponseAccumulator()
		await expect(async () => {
			for await (const chunk of handler.createMessage("", [], {
				taskId: "opaque-reasoning-salvage",
				signal: controller.signal,
			})) {
				await accumulator.add(chunk)
			}
		}).rejects.toThrow(status === "cancelled" ? "request cancelled" : "provider failed")
		const response = await accumulator.finish(undefined, { status })
		expect(response.outcome).toEqual({ status })
		const task = createTaskHistoryBridge(handler)
		await task.persistAssistantResponseBeforeEffects(
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
			undefined,
			response,
		)
		await addToolResult(task, `Error: ${status}`, true)
		const reloaded: ApiMessage[] = JSON.parse(JSON.stringify(task.apiConversationHistory))
		expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), true)).toEqual([
			...expectedReplay(true).slice(0, 4),
			{ type: "function_call_output", call_id: "read-call", output: `Error: ${status}` },
		])

		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield {
					type: "response.completed",
					response: { ...providerResponse, output: [assistantMessage("recovered", "Recovered.")] },
				}
			})(),
		)
		const retriedResponse = await collectResponse(handler)
		expect(handler.getReasoningItems()).toEqual([])
		expect(retriedResponse.items.filter((item) => item.type === "reasoning")).toEqual([])
	})

	it.each(["item list", "single getter"])("keeps the legacy encrypted-reasoning fallback: %s", async (fallback) => {
		const handler = new OpenAiHandler(options)
		vi.spyOn(handler, "getReasoningItems").mockReturnValue(
			fallback === "item list" ? [firstReasoning, secondReasoning] : [],
		)
		vi.spyOn(handler, "getEncryptedContent").mockReturnValue(firstReasoning)
		const task = createTaskHistoryBridge(handler)
		const response = createAgentResponse([{ type: "text", text: "Legacy answer." }])
		await task.persistAssistantResponseBeforeEffects(
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
			undefined,
			response,
		)
		const reloaded: ApiMessage[] = JSON.parse(JSON.stringify(task.apiConversationHistory))
		expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), true)).toEqual([
			{ ...firstReasoning, summary: fallback === "single getter" ? [] : firstReasoning.summary },
			...(fallback === "item list" ? [secondReasoning] : []),
			{ role: "assistant", content: "Legacy answer." },
		])
	})
})
