import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"

import { Task } from "../../task/Task"
import type { ApiMessage } from "../apiMessages"
import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"
import { buildOpenAiResponsesInput } from "../../../api/providers/openai-responses"
import { transformMessagesForCondensing } from "../../condense"

const text = { type: "text" as const, text: "Checking the file." }
const tool = { type: "tool_use" as const, id: "call-1", name: "read_file", input: { path: "a.ts" } }
const encrypted = { type: "reasoning", encrypted_content: "opaque+/=\r\n", id: "rs-1", summary: [] }
const result: ApiMessage = {
	role: "user",
	content: [{ type: "tool_result", tool_use_id: "call-1", content: "File contents." }],
}

interface TaskHistoryBridge {
	apiConversationHistory: ApiMessage[]
	addToApiConversationHistory(message: Anthropic.MessageParam): Promise<boolean>
	buildCleanConversationHistory(messages: ApiMessage[]): Anthropic.MessageParam[]
}

function bridge(
	provider: string,
	modelId: string,
	captured?: { provider: string; modelId: string },
): TaskHistoryBridge {
	const handler = { getModel: () => ({ id: modelId, info: { contextWindow: 1_000_000, supportsPromptCache: true } }) }
	return Object.assign(Object.create(Task.prototype), {
		api: handler,
		apiConfiguration: { apiProvider: provider, apiModelId: modelId },
		effectiveApiConfiguration: { apiProvider: provider, apiModelId: modelId },
		apiConversationHistory: [],
		...(captured
			? {
					currentAgentStep: {
						snapshot: {
							context: {
								provider: {
									apiProvider: captured.provider,
									modelId: captured.modelId,
									apiProtocol: "openai",
								},
							},
							runtime: { getHandler: () => handler },
						},
					},
				}
			: {}),
		saveApiConversationHistory: vi.fn(async () => true),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
	}) as TaskHistoryBridge
}

function savedAssistant(provider: string, modelId: string, content: unknown[] = [text, encrypted, tool]): ApiMessage {
	return {
		role: "assistant",
		content,
		provider_state_scope: { provider, modelId },
	} as ApiMessage
}

describe("provider reasoning replay scope", () => {
	it.each([
		["openai-native", "gpt-6.1-sol", "xai", "grok-4.7"],
		["xai", "grok-4.7", "openai-native", "gpt-6.1-sol"],
		["openai-native", "gpt-6.1-sol", "openai-native", "gpt-6-astra"],
	])("does not replay %s/%s ciphertext to %s/%s", (source, sourceModel, destination, modelId) => {
		const saved = [savedAssistant(source, sourceModel), result]
		const before = structuredClone(saved)
		const projected = bridge(destination, modelId).buildCleanConversationHistory(saved)
		expect(projected).toEqual([{ role: "assistant", content: [text, tool] }, result])
		expect(buildOpenAiResponsesInput("", [], projected, false)).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ encrypted_content: expect.any(String) })]),
		)
		expect(saved).toEqual(before)
	})

	it("keeps ciphertext and ordered tool pairs on the same provider and model", () => {
		const saved = [savedAssistant("openai-native", "gpt-6.1-sol"), result]
		const projected = bridge("openai-native", "gpt-6.1-sol").buildCleanConversationHistory(saved)
		expect(buildOpenAiResponsesInput("", [], projected, false)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "reasoning", encrypted_content: encrypted.encrypted_content }),
				expect.objectContaining({ type: "function_call", call_id: "call-1" }),
				expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
			]),
		)
	})

	it("filters standalone scoped reasoning without dropping adjacent visible records", () => {
		const standalone = {
			...encrypted,
			provider_state_scope: { provider: "openai-native", modelId: "gpt-6.1-sol" },
		} as unknown as ApiMessage
		const visible: ApiMessage = { role: "assistant", content: "Visible answer." }
		expect(bridge("xai", "grok-4.7").buildCleanConversationHistory([standalone, visible])).toEqual([visible])
		expect(bridge("openai-native", "gpt-6.1-sol").buildCleanConversationHistory([standalone, visible])[0]).toEqual(
			encrypted,
		)
		expect(invalidPersistedApiMessages([standalone])).toBeUndefined()
	})

	it.each([
		["openrouter", "openai/gpt-6.1-sol", "openrouter", "anthropic/claude-sonnet-5.5"],
		["openrouter", "openai/gpt-6.1-sol", "openai-native", "gpt-6.1-sol"],
	])("keeps router reasoning details scoped to %s/%s", (source, sourceModel, destination, modelId) => {
		const saved = [
			{
				...savedAssistant(source, sourceModel, [text, tool]),
				reasoning_details: [
					{ type: "reasoning.encrypted", data: "router-opaque", format: "openai-responses-v1" },
				],
			},
			result,
		]
		expect(bridge(destination, modelId).buildCleanConversationHistory(saved)).toEqual([
			{ role: "assistant", content: [text, tool] },
			result,
		])
		expect(bridge(source, sourceModel).buildCleanConversationHistory(saved)[0]).toHaveProperty(
			"reasoning_details",
			saved[0].reasoning_details,
		)
	})

	it("drops incompatible signed, redacted and Gemini state while retaining ordinary text and tools", () => {
		const saved = [
			savedAssistant("anthropic", "claude-opus-5-5", [
				{ type: "thinking", thinking: "Summary", signature: "signed-state" },
				{ type: "redacted_thinking", data: "redacted-state" },
				{ type: "thoughtSignature", thoughtSignature: "legacy-gemini-state" },
				{ type: "gemini_response", geminiResponse: { modelId: "gemini-4-argon", parts: [{ text: "Reply" }] } },
				text,
				tool,
			]),
			result,
		]
		expect(bridge("gemini", "gemini-4-argon").buildCleanConversationHistory(saved)).toEqual([
			{ role: "assistant", content: [text, tool] },
			result,
		])
	})

	it("retains the legacy replay behavior when old history has no origin scope", () => {
		const unscoped = { role: "assistant" as const, content: [encrypted, text, tool] } as ApiMessage
		const projected = bridge("xai", "grok-4.7").buildCleanConversationHistory([unscoped, result])
		expect(buildOpenAiResponsesInput("", [], projected, false)).toEqual(
			expect.arrayContaining([expect.objectContaining({ encrypted_content: encrypted.encrypted_content })]),
		)
	})

	it("does not send signed state into a separate summarization request after tool transactions become text", () => {
		const original = [
			savedAssistant("gemini", "gemini-4-argon", [
				encrypted,
				{ type: "thinking", thinking: "Summary", signature: "signed-state" },
				{ type: "redacted_thinking", data: "redacted-state" },
				{ type: "thoughtSignature", thoughtSignature: "legacy-state" },
				{ type: "gemini_response", geminiResponse: { modelId: "gemini-4-argon", parts: [{ text: "Reply" }] } },
				text,
				tool,
			]),
			result,
		]
		const before = structuredClone(original)
		const transformed = transformMessagesForCondensing(original)
		expect(transformed[0].content).toEqual([text, { type: "text", text: "[Tool Use: read_file]\npath: a.ts" }])
		expect(transformed[1].content).toEqual([{ type: "text", text: "[Tool Result]\nFile contents." }])
		expect(original).toEqual(before)
	})

	it("records the producing immutable step identity when live settings have already changed", async () => {
		const task = bridge("xai", "grok-4.7", { provider: "openai-native", modelId: "gpt-6.1-sol" })
		await task.addToApiConversationHistory({
			role: "assistant",
			content: [encrypted, text, tool],
		} as Anthropic.MessageParam)
		expect(task.apiConversationHistory[0]).toHaveProperty("provider_state_scope", {
			provider: "openai-native",
			modelId: "gpt-6.1-sol",
		})
	})

	it("rejects assistant replay provenance on a user record", () => {
		expect(
			invalidPersistedApiMessages([
				{
					role: "user",
					content: "User message",
					provider_state_scope: { provider: "xai", modelId: "grok-4.7" },
				},
			]),
		).toContain("invalid provider state scope")
	})

	it("does not reject an existing host's opaque model ID merely because provenance cannot represent it", async () => {
		const task = bridge("vscode-lm", "opaque-model-".repeat(100))
		await task.addToApiConversationHistory({
			role: "assistant",
			content: [encrypted, text],
		} as Anthropic.MessageParam)
		expect(invalidPersistedApiMessages(task.apiConversationHistory)).toBeUndefined()
		expect(task.apiConversationHistory[0].content).toEqual([encrypted, text])
		expect(task.apiConversationHistory[0]).not.toHaveProperty("provider_state_scope")
	})

	it.each([
		{ scope: null },
		{ scope: [] },
		{ scope: {} },
		{ scope: { provider: "", modelId: "model" } },
		{ scope: { provider: "xai", modelId: 4 } },
	])("rejects malformed persisted replay provenance (%j)", ({ scope: provider_state_scope }) => {
		expect(invalidPersistedApiMessages([{ role: "assistant", content: "text", provider_state_scope }])).toContain(
			"invalid provider state scope",
		)
	})
})
