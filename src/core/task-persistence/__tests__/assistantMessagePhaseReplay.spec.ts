import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { Anthropic } from "@anthropic-ai/sdk"
import { TelemetryService } from "@alpha-code/telemetry"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { OpenAiHandler } from "../../../api/providers/openai"
import { buildOpenAiResponsesInput } from "../../../api/providers/openai-responses"
import { filterNonAnthropicBlocks } from "../../../api/transform/anthropic-filter"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { createAgentResponse, type AgentResponse } from "../../agent/AgentResponse"
import { cleanupAfterTruncation, getEffectiveApiHistory } from "../../condense"
import { truncateConversation } from "../../context-management"
import { Task } from "../../task/Task"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../apiMessages"
import {
	buildCanonicalAssistantHistoryContent,
	buildCanonicalAssistantHistoryItems,
} from "../canonicalAssistantHistory"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"

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
const taskId = "assistant-message-phases"
let storagePath: string

function assistantMessage(id: string | undefined, phase: string | null | undefined, ...text: string[]) {
	return {
		type: "message" as const,
		role: "assistant" as const,
		status: "completed" as const,
		...(id !== undefined ? { id } : {}),
		...(phase !== undefined ? { phase } : {}),
		content: text.map((part) => ({ type: "output_text" as const, text: part, annotations: [] })),
	}
}

const reasoningBefore = {
	type: "reasoning" as const,
	id: "reasoning-before",
	encrypted_content: "opaque-before+/=\r\n",
	summary: [{ type: "summary_text" as const, text: "Before reading." }],
}
const reasoningAfter = {
	type: "reasoning" as const,
	id: "reasoning-after",
	encrypted_content: "opaque-after+/=\n",
	summary: [{ type: "summary_text" as const, text: "After reading." }],
}
const call = {
	type: "function_call" as const,
	id: "function-item",
	call_id: "read-call",
	name: "read_file",
	arguments: '{"path":"src/a.ts"}',
	status: "completed" as const,
}
const output = [
	assistantMessage("message-progress-1", "commentary", "Checking."),
	assistantMessage("message-progress-2", "commentary", "Checking."),
	reasoningBefore,
	assistantMessage("message-partial", "partial_answer", "Stable answer.\n", "More work follows."),
	call,
	reasoningAfter,
	assistantMessage("message-final", "final_answer", "Done."),
]
const providerResponse = { id: "response-phases", status: "completed", output, usage: null }
const variants = ["nonstreaming", "added metadata", "receipt metadata", "completed metadata", "completed only"] as const
type Variant = (typeof variants)[number]

function mockProviderResponse(variant: Variant, items = output) {
	const response = { ...providerResponse, output: items }
	responsesCreate.mockResolvedValueOnce(
		variant === "nonstreaming"
			? response
			: (async function* () {
					if (variant !== "completed only") {
						for (const [output_index, item] of items.entries()) {
							if (item.type === "message") {
								if (variant === "added metadata" || variant === "completed metadata") {
									yield {
										type: "response.output_item.added",
										output_index,
										item: {
											...item,
											phase: variant === "completed metadata" ? undefined : item.phase,
											content: [],
										},
									}
								}
								for (const [content_index, part] of item.content.entries()) {
									for (const delta of [part.text.slice(0, 3), part.text.slice(3)]) {
										yield { type: "response.output_text.delta", output_index, content_index, delta }
									}
								}
							}
							const receipt =
								item.type === "message" && variant === "completed metadata"
									? { ...item, phase: undefined }
									: item
							// Repeated completion receipts belong to the same original item.
							yield { type: "response.output_item.done", output_index, item: receipt }
							yield { type: "response.output_item.done", output_index, item: receipt }
						}
					}
					yield { type: "response.completed", response }
				})(),
	)
}

function createTaskHistoryBridge(handler: OpenAiHandler): TaskHistoryBridge {
	const store = new ProviderTranscriptStore(taskId, storagePath)
	const task = Object.assign(Object.create(Task.prototype), {
		api: handler,
		apiConfiguration: options,
		effectiveApiConfiguration: options,
		apiConversationHistory: [],
		// Keep real assistant history construction and request projection. This
		// bridge writes authoritative bytes and a verified sidecar to real disk.
		saveApiConversationHistory: async () => {
			const receipt = await saveApiMessages({
				messages: task.apiConversationHistory,
				taskId,
				globalStoragePath: storagePath,
			})
			const commit = await store.commitAuthoritativeTranscript(receipt)
			await store.assertCommitReceipt(commit)
			return true
		},
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
		publishCanonicalLifecycleResponseItems: vi.fn(async () => undefined),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => undefined),
	}) as TaskHistoryBridge
	return task
}

async function reloadHistory(): Promise<ApiMessage[]> {
	const messages = await readApiMessages({ taskId, globalStoragePath: storagePath })
	// A fresh store must independently read the sidecar and exact canonical bytes.
	expect((await new ProviderTranscriptStore(taskId, storagePath).read()).messages).toEqual(messages)
	return messages
}

async function collectResponse(handler: OpenAiHandler): Promise<AgentResponse> {
	const accumulator = new AgentResponseAccumulator()
	for await (const chunk of handler.createMessage("", [])) await accumulator.add(chunk)
	return accumulator.finish()
}

async function persistResponse(task: TaskHistoryBridge, response: AgentResponse) {
	expect(
		await task.persistAssistantResponseBeforeEffects(
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
			response.reasoning,
			response,
		),
	).toBe(true)
}

async function addToolResult(task: TaskHistoryBridge, result = "File contents.", isError = false) {
	expect(
		await task.addToApiConversationHistory({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: call.call_id, content: result, is_error: isError }],
		}),
	).toBe(true)
}

function replayMessage(id: string | undefined, phase: string | undefined, text: string) {
	return {
		type: "message",
		role: "assistant",
		...(id !== undefined ? { id } : {}),
		...(phase !== undefined ? { phase } : {}),
		content: [{ type: "output_text", text, annotations: [] }],
	}
}

function reasoningInput(item: typeof reasoningBefore, store: boolean) {
	const { id, ...content } = item
	return { ...content, ...(store ? { id } : {}) }
}

function expectedReplay(store: boolean) {
	return [
		replayMessage("message-progress-1", "commentary", "Checking."),
		replayMessage("message-progress-2", "commentary", "Checking."),
		reasoningInput(reasoningBefore, store),
		replayMessage("message-partial", "partial_answer", "Stable answer.\nMore work follows."),
		{ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
		reasoningInput(reasoningAfter, store),
		replayMessage("message-final", "final_answer", "Done."),
		{ type: "function_call_output", call_id: call.call_id, output: "File contents." },
	]
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

// Source contract, retrieved 2026-10-11 at 27065a91ccbf5ba8532844be3777fcf83b77820d:
// protocol/models.rs response_input_message_conversion_preserves_phase and
// core/tests/suite/client.rs resume_sends_prior_items / response_item_ids_persist_across_resume_and_preserve_server_ids.
describe("assistant message phase persistence and replay", () => {
	beforeEach(async () => {
		responsesCreate.mockReset()
		storagePath = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "alpha-message-phases-"))
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it.each(variants)(
		"retains original message boundaries and three phases through disk reload: %s",
		async (variant) => {
			mockProviderResponse(variant)
			const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: variant !== "nonstreaming" })
			const response = await collectResponse(handler)
			expect(buildCanonicalAssistantHistoryItems(response).filter((item) => item.type === "text")).toMatchObject([
				{ id: "message-progress-1", phase: "commentary", text: "Checking.", outputIndex: 0 },
				{ id: "message-progress-2", phase: "commentary", text: "Checking.", outputIndex: 1 },
				{
					id: "message-partial",
					phase: "partial_answer",
					text: "Stable answer.\nMore work follows.",
					outputIndex: 3,
				},
				{ id: "message-final", phase: "final_answer", text: "Done.", outputIndex: 6 },
			])
			expect(response.toolCalls).toHaveLength(1)
			const task = createTaskHistoryBridge(handler)
			await persistResponse(task, response)
			await addToolResult(task)
			const reloaded = await reloadHistory()
			expect(reloaded[0]).toHaveProperty("agentResponseItems", response.items)
			for (const store of [false, true]) {
				expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), store)).toEqual(
					expectedReplay(store),
				)
			}
		},
	)

	it.each([undefined, null, "future_phase"])("keeps unknown phase fallback readable: %s", async (phase) => {
		mockProviderResponse("receipt metadata", [assistantMessage("message-unknown", phase, "Legacy answer.")])
		const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: true })
		const response = await collectResponse(handler)
		const task = createTaskHistoryBridge(handler)
		await persistResponse(task, response)
		const reloaded = await reloadHistory()
		expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), false)).toEqual([
			replayMessage("message-unknown", undefined, "Legacy answer."),
		])
		expect(response.items.filter((item) => item.type === "text").every((item) => !("phase" in item))).toBe(true)
	})

	it.each(["commentary", "partial_answer", "final_answer"])(
		"retains the only assistant message after an opaque reasoning prefix: %s",
		async (phase) => {
			mockProviderResponse("added metadata", [
				reasoningBefore,
				assistantMessage("message-after-reasoning", phase, "Answer after reasoning."),
			])
			const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: true })
			const task = createTaskHistoryBridge(handler)
			await persistResponse(task, await collectResponse(handler))
			const reloaded = await reloadHistory()
			for (const store of [false, true]) {
				expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), store)).toEqual([
					reasoningInput(reasoningBefore, store),
					replayMessage("message-after-reasoning", phase, "Answer after reasoning."),
				])
			}
		},
	)

	it("keeps phase-less server message boundaries when only output positions identify them", async () => {
		mockProviderResponse("receipt metadata", [
			assistantMessage(undefined, undefined, "Repeated."),
			assistantMessage(undefined, undefined, "Repeated."),
		])
		const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: true })
		const response = await collectResponse(handler)
		const task = createTaskHistoryBridge(handler)
		await persistResponse(task, response)
		const reloaded = await reloadHistory()
		const replay = buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), false)
		expect(replay).toHaveLength(2)
		for (const message of replay) {
			expect(message).not.toHaveProperty("phase")
			expect(message).not.toHaveProperty("id")
		}
	})

	it("never substitutes legacy envelope receipt IDs for original message identity", async () => {
		const first = { type: "text" as const, text: "First output.", outputIndex: 0 }
		const second = { type: "text" as const, text: "Second output.", outputIndex: 1 }
		const messages: ApiMessage[] = [
			{ role: "assistant", id: "legacy-receipt-without-prefix", content: [first, second] },
			{ role: "assistant", id: "another-unstructured-receipt", content: "Older string answer." },
		]
		await saveApiMessages({ messages, taskId, globalStoragePath: storagePath })
		const reloaded = await readApiMessages({ taskId, globalStoragePath: storagePath })
		const task = createTaskHistoryBridge(new OpenAiHandler(options))
		expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), false)).toEqual([
			{ role: "assistant", content: "First output." },
			{ role: "assistant", content: "Second output." },
			{ role: "assistant", content: "Older string answer." },
		])
	})

	it("keeps explicit top-level message identity separate from a response receipt and user phase", async () => {
		const messages: ApiMessage[] = [
			{
				role: "assistant",
				id: "arbitrary-provider-receipt",
				messageId: "original-assistant-message",
				phase: "partial_answer",
				content: "An explicitly identified partial answer.",
			},
			{
				role: "user",
				messageId: "not-an-assistant-message",
				phase: "final_answer",
				content: "Please continue.",
			},
		]
		await saveApiMessages({ messages, taskId, globalStoragePath: storagePath })
		const reloaded = await readApiMessages({ taskId, globalStoragePath: storagePath })
		const task = createTaskHistoryBridge(new OpenAiHandler(options))
		expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), false)).toEqual([
			replayMessage("original-assistant-message", "partial_answer", "An explicitly identified partial answer."),
			{ role: "user", content: "Please continue." },
		])
	})

	it.each([undefined, null, "future_phase"])(
		"replays old persisted content without inventing a phase: %s",
		async (phase) => {
			const block = { type: "text" as const, text: "Older answer." }
			if (phase !== undefined) Reflect.set(block, "phase", phase)
			const messages: ApiMessage[] = [
				{ role: "user", content: "Original prompt." },
				{ role: "assistant", content: [block] },
				{ role: "user", content: "Follow up." },
				{ role: "assistant", content: "A phase-less string answer." },
			]
			await saveApiMessages({ messages, taskId, globalStoragePath: storagePath })
			const reloaded = await readApiMessages({ taskId, globalStoragePath: storagePath })
			expect(reloaded).toEqual(messages)
			const task = createTaskHistoryBridge(new OpenAiHandler(options))
			expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), false)).toEqual([
				{ role: "user", content: "Original prompt." },
				{ role: "assistant", content: "Older answer." },
				{ role: "user", content: "Follow up." },
				{ role: "assistant", content: "A phase-less string answer." },
			])
		},
	)

	it("restores original phase metadata after non-destructive truncation and rewind", async () => {
		mockProviderResponse("nonstreaming")
		const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: false })
		const task = createTaskHistoryBridge(handler)
		await task.addToApiConversationHistory({ role: "user", content: "Initial task." })
		await persistResponse(task, await collectResponse(handler))
		await addToolResult(task)
		await task.addToApiConversationHistory({ role: "user", content: "Continue." })
		mockProviderResponse("nonstreaming", [assistantMessage(undefined, undefined, "Later answer.")])
		await persistResponse(task, await collectResponse(handler))
		const original = await reloadHistory()
		const truncated = truncateConversation(original, 0.5, taskId)
		expect(truncated.messagesRemoved).toBe(2)
		await saveApiMessages({ messages: truncated.messages, taskId, globalStoragePath: storagePath })
		const stored = await readApiMessages({ taskId, globalStoragePath: storagePath })
		expect(stored.find((message) => message.role === "assistant" && message.truncationParent)).toMatchObject({
			content: original[1]!.content,
		})
		expect(
			buildOpenAiResponsesInput(
				"",
				[],
				task.buildCleanConversationHistory(getEffectiveApiHistory(stored)),
				false,
			),
		).not.toContainEqual(replayMessage("message-progress-1", "commentary", "Checking."))
		const rewound = cleanupAfterTruncation(stored.filter((message) => !message.isTruncationMarker))
		expect(
			buildOpenAiResponsesInput(
				"",
				[],
				task.buildCleanConversationHistory(getEffectiveApiHistory(rewound)),
				true,
			),
		).toEqual([
			{ role: "user", content: "Initial task." },
			...expectedReplay(true),
			{ role: "user", content: "Continue." },
			{ role: "assistant", content: "Later answer." },
		])
	})

	it("keeps signed-thinking phase metadata in persisted content and strips it only at the Anthropic wire boundary", async () => {
		const task = createTaskHistoryBridge(new OpenAiHandler(options))
		const anthropicOptions = { apiProvider: "vertex", apiModelId: "claude-sonnet-4" }
		Reflect.set(task, "apiConfiguration", anthropicOptions)
		Reflect.set(task, "effectiveApiConfiguration", anthropicOptions)
		const response = createAgentResponse([
			{ type: "reasoning", text: "Signed reasoning.", signature: "original-signature", outputIndex: 0 },
			{ type: "text", text: "Progress.", id: "signed-progress", phase: "commentary", outputIndex: 1 },
			{ type: "text", text: "Answer.", id: "signed-answer", phase: "final_answer", outputIndex: 2 },
		])
		await persistResponse(task, response)
		const reloaded = await reloadHistory()
		expect(reloaded[0]).toHaveProperty("agentResponseItems", response.items)
		expect(reloaded[0]!.content).toEqual([
			{ type: "thinking", thinking: "Signed reasoning.", signature: "original-signature" },
			{ type: "text", text: "Progress.", id: "signed-progress", phase: "commentary", outputIndex: 1 },
			{ type: "text", text: "Answer.", id: "signed-answer", phase: "final_answer", outputIndex: 2 },
		])
		const savedSnapshot = structuredClone(reloaded)
		const wire = filterNonAnthropicBlocks(reloaded)
		expect(wire[0]).not.toHaveProperty("agentResponseItems")
		expect(wire[0]!.content).toEqual([
			{ type: "thinking", thinking: "Signed reasoning.", signature: "original-signature" },
			{ type: "text", text: "Progress." },
			{ type: "text", text: "Answer." },
		])
		expect(reloaded).toEqual(savedSnapshot)
	})

	it("waits for the response lifecycle when a final-answer message precedes another tool call", async () => {
		const reached = deferred()
		const release = deferred()
		const final = assistantMessage("message-before-tool", "final_answer", "A declared answer.")
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield { type: "response.output_item.done", output_index: 0, item: final }
				reached.resolve()
				await release.promise
				yield { type: "response.output_item.done", output_index: 1, item: call }
				yield {
					type: "response.completed",
					response: { ...providerResponse, output: [final, call], end_turn: false },
				}
			})(),
		)
		const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: true })
		let settled = false
		const collection = collectResponse(handler).finally(() => {
			settled = true
		})
		try {
			await reached.promise
			expect(settled).toBe(false)
		} finally {
			release.resolve()
		}
		const response = await collection
		expect(response.toolCalls).toHaveLength(1)
		expect(response.outcome).toEqual({ status: "completed", requiresContinuation: true })
		const task = createTaskHistoryBridge(handler)
		await persistResponse(task, response)
		await addToolResult(task)
		expect(
			buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(await reloadHistory()), false),
		).toEqual([
			replayMessage("message-before-tool", "final_answer", "A declared answer."),
			{ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
			{ type: "function_call_output", call_id: call.call_id, output: "File contents." },
		])
	})

	it.each(["failed", "cancelled"] as const)(
		"retains received phase metadata across a %s response and retry",
		async (status) => {
			const controller = new AbortController()
			responsesCreate.mockResolvedValueOnce(
				(async function* () {
					for (const [output_index, item] of output.slice(0, 5).entries()) {
						yield { type: "response.output_item.done", output_index, item }
					}
					if (status === "cancelled") controller.abort(new Error("phase request cancelled"))
					else throw new Error("phase provider failed")
				})(),
			)
			const handler = new OpenAiHandler({ ...options, openAiStreamingEnabled: true })
			const accumulator = new AgentResponseAccumulator()
			await expect(async () => {
				for await (const chunk of handler.createMessage("", [], { taskId, signal: controller.signal })) {
					await accumulator.add(chunk)
				}
			}).rejects.toThrow(status === "cancelled" ? "phase request cancelled" : "phase provider failed")
			const response = await accumulator.finish(undefined, { status })
			expect(response.outcome).toEqual({ status })
			const task = createTaskHistoryBridge(handler)
			await persistResponse(task, response)
			await addToolResult(task, `Error: ${status}`, true)
			const reloaded = await reloadHistory()
			expect(reloaded[0]).toHaveProperty("agentResponseOutcome", { status })
			expect(buildOpenAiResponsesInput("", [], task.buildCleanConversationHistory(reloaded), true)).toEqual([
				...expectedReplay(true).slice(0, 5),
				{ type: "function_call_output", call_id: call.call_id, output: `Error: ${status}` },
			])
			mockProviderResponse("completed only", [
				assistantMessage("message-recovered", "final_answer", "Recovered."),
			])
			const retried = await collectResponse(handler)
			expect(buildCanonicalAssistantHistoryItems(retried)).toEqual([
				{ type: "text", id: "message-recovered", phase: "final_answer", outputIndex: 0, text: "Recovered." },
			])
		},
	)
})
