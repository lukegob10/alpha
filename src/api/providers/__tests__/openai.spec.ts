// npx vitest run api/providers/__tests__/openai.spec.ts

import { OpenAiHandler, getOpenAiModels } from "../openai"
import { ApiHandlerOptions } from "../../../shared/api"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { openAiModelInfoSaneDefaults } from "@alpha-code/types"
import { Package } from "../../../shared/package"
import axios from "axios"
import { resolveTaskReasoning } from "../../../core/agent/TaskReasoning"
import { supportsOpenAiResponsesFreeformApplyPatch } from "../openai-responses"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import type { ApiStreamChunk } from "../../transform/stream"

const mockCreate = vitest.fn()
const mockResponsesCreate = vitest.fn()

vitest.mock("openai", () => {
	const mockConstructor = vitest.fn()
	return {
		__esModule: true,
		default: mockConstructor.mockImplementation(() => ({
			responses: {
				create: mockResponsesCreate,
			},
			chat: {
				completions: {
					create: mockCreate.mockImplementation(async (options) => {
						if (!options.stream) {
							return {
								id: "test-completion",
								choices: [
									{
										message: { role: "assistant", content: "Test response", refusal: null },
										finish_reason: "stop",
										index: 0,
									},
								],
								usage: {
									prompt_tokens: 10,
									completion_tokens: 5,
									total_tokens: 15,
								},
							}
						}

						return {
							[Symbol.asyncIterator]: async function* () {
								yield {
									choices: [
										{
											delta: { content: "Test response" },
											index: 0,
										},
									],
									usage: null,
								}
								yield {
									choices: [
										{
											delta: {},
											finish_reason: "stop",
											index: 0,
										},
									],
									usage: {
										prompt_tokens: 10,
										completion_tokens: 5,
										total_tokens: 15,
									},
								}
							},
						}
					}),
				},
			},
		})),
	}
})

// Mock axios for getOpenAiModels tests
vitest.mock("axios", () => ({
	default: {
		get: vitest.fn(),
	},
}))

describe("OpenAiHandler", () => {
	let handler: OpenAiHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			openAiApiKey: "test-api-key",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
		}
		handler = new OpenAiHandler(mockOptions)
		mockCreate.mockClear()
		mockResponsesCreate.mockReset()
	})

	it("requires terminal outcomes on Chat Completions routes while preserving Responses EOF", () => {
		const chatCompletionsHandler = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-4" })
		const responsesHandler = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-6-luna" })

		expect(chatCompletionsHandler.streamCapabilities).toEqual({ lifecycle: true, cancellation: true })
		expect(responsesHandler.streamCapabilities).toEqual({ cancellation: true })
	})

	describe("Responses API freeform apply_patch path", () => {
		const applyPatchTools = [
			{
				type: "function" as const,
				function: {
					name: "apply_patch",
					description: "Apply a patch",
					parameters: {
						type: "object",
						properties: { patch: { type: "string" } },
						required: ["patch"],
						additionalProperties: false,
					},
				},
			},
		]

		it("sends a user-selected max effort for an official Responses model", async () => {
			mockResponsesCreate.mockResolvedValueOnce({
				id: "response-max",
				status: "completed",
				output: [
					{
						id: "message-max",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Done." }],
					},
				],
				usage: null,
			})
			const provider = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "gpt-6-luna",
				openAiStreamingEnabled: false,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
					reasoningEffort: "max",
				},
			})

			for await (const _chunk of provider.createMessage("system", [])) {
				// Consume the provider response.
			}

			expect(mockResponsesCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "gpt-6-luna", reasoning: { effort: "max", summary: "auto" } }),
				expect.anything(),
			)
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("uses raw custom patch input and preserves encrypted reasoning and usage", async () => {
			const patch = '*** Begin Patch\n*** Add File: answer.txt\n+print("ok")\n*** End Patch'
			const customCall = {
				id: "item_patch",
				type: "custom_tool_call",
				call_id: "call_patch",
				name: "apply_patch",
				input: patch,
			}
			const reasoning = {
				id: "reasoning_1",
				type: "reasoning",
				encrypted_content: "opaque-reasoning",
				summary: [{ type: "summary_text", text: "Reviewed the patch." }],
			}
			const secondReasoning = {
				id: "reasoning_2",
				type: "reasoning",
				encrypted_content: "opaque-reasoning-2",
				summary: [{ type: "summary_text", text: "Confirmed the patch." }],
			}
			const message = {
				id: "message_1",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Applying the patch." }],
			}
			const response = {
				id: "resp_1",
				status: "completed",
				output: [reasoning, customCall, message, secondReasoning],
				usage: {
					input_tokens: 120,
					output_tokens: 30,
					input_tokens_details: { cached_tokens: 40 },
					output_tokens_details: { reasoning_tokens: 12 },
					total_tokens: 150,
				},
			}
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-5.6-sol" })
			let streamingReasoningItemIds: string[] | undefined
			mockResponsesCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						type: "response.output_item.added",
						output_index: 1,
						sequence_number: 0,
						item: { ...customCall, input: "" },
					}
					yield {
						type: "response.custom_tool_call_input.delta",
						output_index: 1,
						item_id: "item_patch",
						sequence_number: 1,
						delta: patch.slice(0, 40),
					}
					yield {
						type: "response.custom_tool_call_input.delta",
						output_index: 1,
						item_id: "item_patch",
						sequence_number: 2,
						delta: patch.slice(40),
					}
					yield { type: "response.output_item.done", output_index: 1, sequence_number: 3, item: customCall }
					yield {
						type: "response.output_item.done",
						output_index: 3,
						sequence_number: 4,
						item: secondReasoning,
					}
					yield { type: "response.output_item.done", output_index: 0, sequence_number: 5, item: reasoning }
					streamingReasoningItemIds = provider.getReasoningItems().map((item) => item.id)
					yield { type: "response.output_item.done", output_index: 2, sequence_number: 6, item: message }
					yield { type: "response.completed", sequence_number: 7, response }
				},
			}))

			const chunks = []
			for await (const chunk of provider.createMessage("legacy prompt", [], {
				taskId: "responses-patch",
				instructionFragments: [
					{ role: "developer", content: "Codex base" },
					{ role: "user", content: "Workspace context" },
				],
				tools: applyPatchTools,
				tool_choice: { type: "function", function: { name: "apply_patch" } },
				store: false,
			})) {
				chunks.push(chunk)
			}

			expect(mockResponsesCreate).toHaveBeenCalledOnce()
			expect(mockCreate).not.toHaveBeenCalled()
			const [request] = mockResponsesCreate.mock.calls[0]!
			expect(request.input).toEqual([
				{ role: "developer", content: "Codex base" },
				{ role: "user", content: "Workspace context" },
			])
			expect(request.tools).toEqual([
				expect.objectContaining({
					type: "custom",
					name: "apply_patch",
					format: {
						type: "grammar",
						syntax: "lark",
						definition: expect.stringContaining("start: begin_patch hunk+ end_patch"),
					},
				}),
			])
			expect(request.tool_choice).toEqual({ type: "custom", name: "apply_patch" })
			expect(request.store).toBe(false)

			const partialArguments = chunks
				.filter((chunk) => chunk.type === "tool_call_partial")
				.map((chunk) => chunk.arguments ?? "")
				.join("")
			expect(JSON.parse(partialArguments)).toEqual({ patch })
			expect(chunks).toContainEqual({ type: "tool_call_end", id: "call_patch" })
			expect(chunks).toContainEqual({ type: "text", text: "Applying the patch." })
			expect(chunks).not.toContainEqual({ type: "reasoning", text: "Reviewed the patch." })
			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 120,
				outputTokens: 30,
				cacheReadTokens: 40,
				reasoningTokens: 12,
			})
			expect(provider.getResponseId()).toBe("resp_1")
			expect(provider.getEncryptedContent()).toEqual({ encrypted_content: "opaque-reasoning", id: "reasoning_1" })
			expect(streamingReasoningItemIds).toEqual(["reasoning_1", "reasoning_2"])
			expect(provider.getReasoningItems()).toEqual([
				{
					id: "reasoning_1",
					encrypted_content: "opaque-reasoning",
					summary: [{ type: "summary_text", text: "Reviewed the patch." }],
				},
				{
					id: "reasoning_2",
					encrypted_content: "opaque-reasoning-2",
					summary: [{ type: "summary_text", text: "Confirmed the patch." }],
				},
			])
		})

		it("marks an output_item.done tool call complete before later streamed output", async () => {
			const functionCall = {
				id: "item_list",
				type: "function_call",
				call_id: "call_list",
				name: "list_files",
				arguments: '{"path":"."}',
			}
			const message = {
				id: "message_tail",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "The directory was inspected." }],
			}
			const response = {
				id: "resp_early_read",
				status: "completed",
				output: [functionCall, message],
				usage: null,
			}
			mockResponsesCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "response.output_item.done", output_index: 0, item: functionCall }
					yield { type: "response.output_item.done", output_index: 1, item: message }
					yield { type: "response.completed", response }
				},
			}))
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-5.6-sol" })
			const chunks = []

			for await (const chunk of provider.createMessage("system", [], {
				taskId: "responses-output-item-done",
				tools: [
					{
						type: "function",
						function: {
							name: "list_files",
							description: "List one directory",
							parameters: {
								type: "object",
								properties: { path: { type: "string" } },
								required: ["path"],
							},
						},
					},
				],
			})) {
				chunks.push(chunk)
			}

			const toolCallIndex = chunks.findIndex((chunk) => chunk.type === "tool_call")
			const toolCallEndIndex = chunks.findIndex((chunk) => chunk.type === "tool_call_end")
			const tailIndex = chunks.findIndex((chunk) => chunk.type === "text")
			expect(chunks[toolCallIndex]).toEqual({
				type: "tool_call",
				id: "call_list",
				name: "list_files",
				arguments: '{"path":"."}',
			})
			expect(chunks[toolCallEndIndex]).toEqual({ type: "tool_call_end", id: "call_list" })
			expect(toolCallEndIndex).toBeGreaterThan(toolCallIndex)
			expect(tailIndex).toBeGreaterThan(toolCallEndIndex)
		})

		it("accepts a minimal completed event after output items and retains streamed reasoning metadata", async () => {
			const reasoning = {
				id: "reasoning_minimal",
				type: "reasoning",
				encrypted_content: "opaque-minimal",
				summary: [{ type: "summary_text", text: "Checked the file." }],
			}
			const functionCall = {
				id: "item_minimal",
				type: "function_call",
				call_id: "call_minimal",
				name: "read_file",
				arguments: '{"path":"example.txt"}',
			}
			mockResponsesCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "response.output_item.done", output_index: 0, item: reasoning }
					yield { type: "response.output_item.done", output_index: 1, item: functionCall }
					yield {
						type: "response.completed",
						response: {
							id: "resp_minimal",
							usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
						},
					}
				},
			})
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-5.6-sol" })
			const chunks = []
			for await (const chunk of provider.createMessage("system", [], { taskId: "responses-minimal-completed" })) {
				chunks.push(chunk)
			}

			expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
				{ type: "tool_call", id: "call_minimal", name: "read_file", arguments: '{"path":"example.txt"}' },
			])
			expect(chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_minimal" },
			])
			expect(chunks).toContainEqual({ type: "usage", inputTokens: 8, outputTokens: 3, cacheReadTokens: 2 })
			expect(provider.getResponseId()).toBe("resp_minimal")
			expect(provider.getEncryptedContent()).toEqual({
				encrypted_content: "opaque-minimal",
				id: "reasoning_minimal",
			})
			expect(provider.getReasoningItems()).toEqual([
				{
					id: "reasoning_minimal",
					encrypted_content: "opaque-minimal",
					summary: [{ type: "summary_text", text: "Checked the file." }],
				},
			])
			expect(provider.getSummary()).toEqual([{ type: "summary_text", text: "Checked the file." }])
		})

		it.each(["incomplete", "failed"])("rejects an explicit %s status in a completed event", async (status) => {
			mockResponsesCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "response.completed", response: { id: "resp_bad_status", status } }
				},
			})
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-5.6-sol" })
			await expect(async () => {
				for await (const _chunk of provider.createMessage("system", [], { taskId: "responses-bad-status" })) {
					// Consume the request stream.
				}
			}).rejects.toThrow(`status ${status}`)
		})

		it.each([
			{ streaming: true, endTurn: false },
			{ streaming: true, endTurn: true },
			{ streaming: true, endTurn: undefined },
			{ streaming: false, endTurn: false },
			{ streaming: false, endTurn: true },
			{ streaming: false, endTurn: undefined },
		])("preserves Responses end_turn=$endTurn with streaming=$streaming", async ({ streaming, endTurn }) => {
			const response = {
				id: "continuation-response",
				status: "completed",
				output: [
					{
						id: "message",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Continuing." }],
					},
				],
				...(endTurn !== undefined ? { end_turn: endTurn } : {}),
				usage: null,
			}
			mockResponsesCreate.mockResolvedValueOnce(
				streaming
					? {
							[Symbol.asyncIterator]: async function* () {
								yield { type: "response.completed", response }
							},
						}
					: response,
			)
			const provider = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "gpt-6-sol",
				openAiStreamingEnabled: streaming,
			})
			const accumulator = new AgentResponseAccumulator()
			for await (const chunk of provider.createMessage("system", [])) await accumulator.add(chunk)
			const normalized = await accumulator.finish()
			expect(normalized.items).toEqual(
				expect.arrayContaining([expect.objectContaining({ type: "text", text: "Continuing." })]),
			)
			if (endTurn === false) {
				expect(normalized.outcome).toMatchObject({ status: "completed", requiresContinuation: true })
			} else {
				expect(normalized.outcome?.requiresContinuation).not.toBe(true)
			}
		})

		it("rejects a minimal completed event while a streamed tool call is still open", async () => {
			mockResponsesCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: async function* () {
					yield {
						type: "response.output_item.added",
						output_index: 0,
						item: {
							id: "item_open",
							type: "function_call",
							call_id: "call_open",
							name: "read_file",
							arguments: "",
						},
					}
					yield { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' }
					yield { type: "response.completed", response: { id: "resp_open" } }
				},
			})
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-5.6-sol" })
			const chunks: unknown[] = []
			await expect(async () => {
				for await (const chunk of provider.createMessage("system", [], { taskId: "responses-open-tool" })) {
					chunks.push(chunk)
				}
			}).rejects.toThrow("streamed tool call was complete")
			expect(chunks).not.toContainEqual({ type: "tool_call_end", id: "call_open" })
		})

		it.each([
			{ change: "call ID", replacement: { call_id: "different-call" } },
			{ change: "name", replacement: { name: "exec_command" } },
			{ change: "type", replacement: { type: "custom_tool_call", input: "{}" } },
		])("rejects a streamed tool whose final $change changes", async ({ replacement }) => {
			const call = {
				id: "tool-item",
				type: "function_call",
				call_id: "original-call",
				name: "read_file",
				arguments: "{}",
			}
			mockResponsesCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } }
					yield { type: "response.output_item.done", output_index: 0, item: { ...call, ...replacement } }
					yield { type: "response.completed", response: { id: "response", status: "completed" } }
				},
			})
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-6-sol" })
			const chunks: ApiStreamChunk[] = []
			await expect(async () => {
				for await (const chunk of provider.createMessage("system", [], { taskId: "changed-tool-identity" })) {
					chunks.push(chunk)
				}
			}).rejects.toThrow("changed identity")
			expect(chunks.filter((chunk) => chunk.type === "tool_call_end" || chunk.type === "tool_call")).toEqual([])
			expect(chunks.some((chunk) => chunk.type === "usage")).toBe(false)
		})

		it.each([
			{ type: "function_call", itemId: "function-item" },
			{ type: "function_call", itemId: undefined },
			{ type: "custom_tool_call", itemId: "custom-item" },
			{ type: "custom_tool_call", itemId: undefined },
		])("finalizes repeated $type output once with item ID $itemId", async ({ type, itemId }) => {
			const isCustom = type === "custom_tool_call"
			const patch = "*** Begin Patch\n*** Add File: result.txt\n+done\n*** End Patch"
			const call = {
				type,
				...(itemId ? { id: itemId } : {}),
				call_id: "replayed-call",
				name: isCustom ? "apply_patch" : "exec_command",
				...(isCustom ? { input: patch } : { arguments: '{"cmd":"pwd"}' }),
			}
			const message = {
				id: "final-message",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Finished." }],
			}
			mockResponsesCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						type: "response.output_item.added",
						output_index: 0,
						item: { ...call, ...(isCustom ? { input: "" } : { arguments: "" }) },
					}
					yield { type: "response.output_item.done", output_index: 0, item: call }
					yield { type: "response.output_item.done", output_index: 0, item: call }
					yield { type: "response.output_item.done", output_index: 1, item: message }
					yield {
						type: "response.completed",
						response: {
							id: "replayed-response",
							status: "completed",
							output: [call, message],
							usage: null,
						},
					}
				},
			}))
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-6-sol" })
			const chunks: ApiStreamChunk[] = []

			for await (const chunk of provider.createMessage("system", [], {
				taskId: "responses-replayed-completion",
				tools: applyPatchTools,
			})) {
				chunks.push(chunk)
			}

			expect(chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "replayed-call" },
			])
			expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([])
			const argumentsText = chunks
				.filter((chunk) => chunk.type === "tool_call_partial")
				.map((chunk) => chunk.arguments ?? "")
				.join("")
			expect(JSON.parse(argumentsText)).toEqual(isCustom ? { patch } : { cmd: "pwd" })
			expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "Finished." }])
		})

		it.each([
			{ outputIndex: "0", finalCallId: "call-1", reason: "invalid index" },
			{ outputIndex: -1, finalCallId: "call-1", reason: "invalid index" },
			{ outputIndex: 0.5, finalCallId: "call-1", reason: "invalid index" },
			{ outputIndex: 1, finalCallId: "call-1", reason: "final output" },
			{ outputIndex: 0, finalCallId: "different-call", reason: "final output" },
		])(
			"rejects mismatched output identity at $outputIndex ($finalCallId)",
			async ({ outputIndex, finalCallId, reason }) => {
				const call = {
					id: "tool-item",
					type: "function_call",
					call_id: "call-1",
					name: "exec_command",
					arguments: '{"cmd":"pwd"}',
				}
				mockResponsesCreate.mockImplementationOnce(async () => ({
					[Symbol.asyncIterator]: async function* () {
						yield { type: "response.output_item.done", output_index: outputIndex, item: call }
						yield {
							type: "response.completed",
							response: {
								id: "mismatched-response",
								status: "completed",
								output: [{ ...call, call_id: finalCallId }],
								usage: null,
							},
						}
					},
				}))
				const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-6-sol" })
				const chunks: ApiStreamChunk[] = []

				await expect(async () => {
					for await (const chunk of provider.createMessage("system", [], {
						taskId: "responses-mismatched-completion",
						tools: applyPatchTools,
					})) {
						chunks.push(chunk)
					}
				}).rejects.toThrow(reason)
				expect(chunks.filter((chunk) => chunk.type === "tool_call_end").length).toBeLessThanOrEqual(1)
				expect(chunks.some((chunk) => chunk.type === "usage")).toBe(false)
			},
		)

		it.each([
			{ modelId: "gpt-4o", baseUrl: "https://api.openai.com/v1" },
			{ modelId: "gpt-5.6-sol", baseUrl: "https://gateway.example.com/v1" },
		])("keeps Chat Completions fallback for $modelId at $baseUrl", async ({ modelId, baseUrl }) => {
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: modelId, openAiBaseUrl: baseUrl })
			for await (const _chunk of provider.createMessage("system", [], {
				taskId: "fallback",
				tools: applyPatchTools,
			})) {
				// Consume the request stream.
			}
			expect(mockResponsesCreate).not.toHaveBeenCalled()
			expect(mockCreate).toHaveBeenCalledOnce()
		})

		it.each([
			{ tools: undefined, expectedTools: undefined },
			{
				tools: [
					{
						type: "function" as const,
						function: {
							name: "read_file",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						},
					},
				],
				expectedTools: [expect.objectContaining({ type: "function", name: "read_file" })],
			},
		])("uses Responses for a Codex GPT model without apply_patch", async ({ tools, expectedTools }) => {
			mockResponsesCreate.mockResolvedValueOnce({
				id: "resp_no_patch",
				status: "completed",
				output: [
					{
						id: "message_1",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Ready." }],
					},
				],
				usage: null,
			})
			const provider = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "gpt-6-sol",
				openAiStreamingEnabled: false,
			})
			const chunks: unknown[] = []
			for await (const chunk of provider.createMessage("system", [], { taskId: "responses-no-patch", tools })) {
				chunks.push(chunk)
			}

			expect(mockResponsesCreate).toHaveBeenCalledOnce()
			expect(mockCreate).not.toHaveBeenCalled()
			expect(mockResponsesCreate.mock.calls[0]?.[0].tools).toEqual(expectedTools)
			expect(chunks).toContainEqual({ type: "text", text: "Ready." })
		})

		it("normalizes freeform input in non-streaming mode", async () => {
			const patch = "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch"
			const reasoningItems = [
				{
					id: "reasoning_nonstream_1",
					type: "reasoning",
					encrypted_content: "opaque-nonstream-1",
					summary: [{ type: "summary_text", text: "Reviewed the deletion." }],
				},
				{
					id: "reasoning_nonstream_2",
					type: "reasoning",
					encrypted_content: "opaque-nonstream-2",
					summary: [{ type: "summary_text", text: "Confirmed the deletion." }],
				},
			]
			mockResponsesCreate.mockResolvedValueOnce({
				id: "resp_nonstream",
				status: "completed",
				output: [
					reasoningItems[0],
					{
						id: "item_patch",
						type: "custom_tool_call",
						call_id: "call_patch",
						name: "apply_patch",
						input: patch,
					},
					reasoningItems[1],
				],
				usage: {
					input_tokens: 10,
					output_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 13,
				},
			})
			const provider = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "gpt-5.6-sol",
				openAiStreamingEnabled: false,
			})
			const chunks: unknown[] = []
			for await (const chunk of provider.createMessage("system", [], {
				taskId: "responses-nonstream",
				tools: applyPatchTools,
			})) {
				chunks.push(chunk)
			}

			expect(mockResponsesCreate.mock.calls[0]?.[0].stream).toBe(false)
			expect(mockResponsesCreate.mock.calls[0]?.[0].store).toBe(false)
			expect(chunks).toContainEqual({
				type: "tool_call",
				id: "call_patch",
				name: "apply_patch",
				arguments: JSON.stringify({ patch }),
			})
			expect(provider.getReasoningItems()).toEqual([
				{
					id: "reasoning_nonstream_1",
					encrypted_content: "opaque-nonstream-1",
					summary: [{ type: "summary_text", text: "Reviewed the deletion." }],
				},
				{
					id: "reasoning_nonstream_2",
					encrypted_content: "opaque-nonstream-2",
					summary: [{ type: "summary_text", text: "Confirmed the deletion." }],
				},
			])
		})

		it("allows explicit storage opt-in on the Responses path", async () => {
			mockResponsesCreate.mockResolvedValueOnce({
				id: "resp_stored",
				status: "completed",
				output: [],
				usage: null,
			})
			const provider = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "gpt-5.6-sol",
				openAiStreamingEnabled: false,
			})
			for await (const _chunk of provider.createMessage("system", [], {
				taskId: "responses-stored",
				tools: applyPatchTools,
				store: true,
			})) {
				// Consume the request stream.
			}
			expect(mockResponsesCreate.mock.calls[0]?.[0].store).toBe(true)
		})

		it("rejects an incomplete streamed response before completing its tool call", async () => {
			const patch = "*** Begin Patch\n*** End Patch"
			const customCall = {
				id: "item_patch",
				type: "custom_tool_call",
				call_id: "call_patch",
				name: "apply_patch",
				input: patch,
			}
			mockResponsesCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "response.output_item.added", output_index: 0, item: { ...customCall, input: "" } }
					yield { type: "response.custom_tool_call_input.delta", output_index: 0, delta: patch }
					yield {
						type: "response.incomplete",
						response: {
							id: "resp_incomplete",
							status: "incomplete",
							incomplete_details: { reason: "max_output_tokens" },
							output: [customCall],
							usage: null,
						},
					}
				},
			})
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-5.6-sol" })
			const chunks: unknown[] = []
			await expect(async () => {
				for await (const chunk of provider.createMessage("system", [], {
					taskId: "responses-incomplete-stream",
					tools: applyPatchTools,
				}))
					chunks.push(chunk)
			}).rejects.toThrow("incomplete")
			expect(chunks).not.toContainEqual({ type: "tool_call_end", id: "call_patch" })
		})

		it.each(["response", "tool item"] as const)(
			"rejects incomplete non-streaming %s before emitting a tool call",
			async (incompletePart) => {
				mockResponsesCreate.mockResolvedValueOnce({
					id: "resp_incomplete",
					status: incompletePart === "response" ? "incomplete" : "completed",
					incomplete_details: { reason: "max_output_tokens" },
					output: [
						{
							id: "item_patch",
							type: "custom_tool_call",
							...(incompletePart === "tool item" ? { status: "incomplete" } : {}),
							call_id: "call_patch",
							name: "apply_patch",
							input: "*** Begin Patch",
						},
					],
					usage: null,
				})
				const provider = new OpenAiHandler({
					...mockOptions,
					openAiModelId: "gpt-5.6-sol",
					openAiStreamingEnabled: false,
				})
				const chunks: unknown[] = []
				await expect(async () => {
					for await (const chunk of provider.createMessage("system", [], {
						taskId: "responses-incomplete-nonstream",
						tools: applyPatchTools,
					}))
						chunks.push(chunk)
				}).rejects.toThrow("incomplete")
				expect(chunks).toEqual([])
			},
		)

		it("keeps the Responses protocol when the captured tools omit apply_patch", async () => {
			mockResponsesCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: async function* () {
					yield {
						type: "response.completed",
						response: { id: "resp_without_tools", status: "completed", output: [], usage: null },
					}
				},
			})
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-5.6-sol" })
			for await (const _chunk of provider.createMessage("system", [], { taskId: "no-patch-tool" })) {
				// Consume the request stream.
			}
			expect(mockResponsesCreate).toHaveBeenCalledOnce()
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("rejects unsupported tools instead of silently switching a Codex GPT request to Chat Completions", async () => {
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-6-sol" })
			await expect(async () => {
				for await (const _chunk of provider.createMessage("system", [], {
					taskId: "unsupported-responses-tool",
					tools: [{ type: "custom", name: "unexpected" } as any],
				})) {
					// Consume the request stream.
				}
			}).rejects.toThrow("Responses tool")
			expect(mockResponsesCreate).not.toHaveBeenCalled()
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("forwards cancellation through the Responses request", async () => {
			let requestSignal: AbortSignal | undefined
			let started: (() => void) | undefined
			const requestStarted = new Promise<void>((resolve) => {
				started = resolve
			})
			mockResponsesCreate.mockImplementationOnce(async (_request, options) => {
				requestSignal = options.signal
				started?.()
				return {
					[Symbol.asyncIterator]: async function* () {
						await new Promise<void>((_resolve, reject) =>
							options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
								once: true,
							}),
						)
						yield { type: "error", message: "Abort was not observed" }
					},
				}
			})
			const controller = new AbortController()
			const provider = new OpenAiHandler({ ...mockOptions, openAiModelId: "gpt-5.6-sol" })
			const stream = provider.createMessage("system", [], {
				taskId: "responses-cancel",
				signal: controller.signal,
				tools: applyPatchTools,
			})
			const next = stream.next()
			await requestStarted
			controller.abort()
			await expect(next).rejects.toThrow()
			expect(requestSignal?.aborted).toBe(true)
		})

		it("routes only the exact supported model IDs on the direct OpenAI host", () => {
			expect(supportsOpenAiResponsesFreeformApplyPatch("gpt-5.6-sol", "https://api.openai.com/v1")).toBe(true)
			expect(supportsOpenAiResponsesFreeformApplyPatch(" gpt-5.6-sol ", "https://api.openai.com/v1")).toBe(false)
			expect(supportsOpenAiResponsesFreeformApplyPatch("gpt-5.6-sol-preview", "https://api.openai.com/v1")).toBe(
				false,
			)
			expect(
				supportsOpenAiResponsesFreeformApplyPatch("gpt-5.6-sol", "https://api.openai.com/v1/chat/completions"),
			).toBe(false)
		})
	})

	describe("constructor", () => {
		it.each(["gpt-4", "o3-mini"])(
			"preserves reasoning for %s in streaming and non-streaming responses",
			async (modelId) => {
				for (const streaming of [true, false]) {
					for (const field of ["reasoning", "reasoning_content"]) {
						const message = {
							content: null,
							[field]: "Checking the documented roles before reading the implementation.",
							tool_calls: [
								{
									index: 0,
									id: "read",
									type: "function",
									function: { name: "read_file", arguments: "{}" },
								},
							],
						}
						mockCreate.mockImplementationOnce(async () =>
							streaming
								? {
										[Symbol.asyncIterator]: async function* () {
											yield { choices: [{ delta: message, finish_reason: "tool_calls" }] }
										},
									}
								: { choices: [{ message }] },
						)
						const provider = new OpenAiHandler({
							...mockOptions,
							openAiModelId: modelId,
							openAiStreamingEnabled: streaming,
						})
						const chunks = []
						for await (const chunk of provider.createMessage("system", [])) chunks.push(chunk)
						expect(chunks.filter((chunk) => chunk.type === "reasoning")).toEqual([
							{ type: "reasoning", text: message[field] },
						])
						expect(chunks.findIndex((chunk) => chunk.type.startsWith("tool_call"))).toBeGreaterThan(
							chunks.findIndex((chunk) => chunk.type === "reasoning"),
						)
					}
				}
			},
		)

		it("passes cancellation to the transport and settles a stalled request", async () => {
			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce((_request, options) => {
				requestSignal = options.signal
				return new Promise((_resolve, reject) =>
					options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
				)
			})
			const controller = new AbortController()
			const stream = handler.createMessage("system", [], { taskId: "cancel", signal: controller.signal })
			const next = stream.next()
			controller.abort()
			await expect(next).rejects.toThrow()
			expect(requestSignal?.aborted).toBe(true)
		})

		it("does not invent reasoning for tool-only responses", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "read", function: { name: "read_file", arguments: "{}" } },
									],
								},
								finish_reason: "tool_calls",
							},
						],
					}
				},
			}))
			const chunks = []
			for await (const chunk of handler.createMessage("system", [])) chunks.push(chunk)
			expect(chunks.some((chunk) => chunk.type === "reasoning")).toBe(false)
		})

		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(OpenAiHandler)
			expect(handler.getModel().id).toBe(mockOptions.openAiModelId)
		})

		it("should use custom base URL if provided", () => {
			const customBaseUrl = "https://custom.openai.com/v1"
			const handlerWithCustomUrl = new OpenAiHandler({
				...mockOptions,
				openAiBaseUrl: customBaseUrl,
			})
			expect(handlerWithCustomUrl).toBeInstanceOf(OpenAiHandler)
		})

		it("should set default headers correctly", () => {
			// Check that the OpenAI constructor was called with correct parameters
			expect(vi.mocked(OpenAI)).toHaveBeenCalledWith({
				baseURL: expect.any(String),
				apiKey: expect.any(String),
				defaultHeaders: {
					"HTTP-Referer": "https://github.com/lukegob10/alpha",
					"X-Title": "Alpha",
					"User-Agent": `Alpha/${Package.version}`,
				},
				timeout: expect.any(Number),
			})
		})
	})

	describe("createMessage", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello!",
					},
				],
			},
		]

		it("projects developer and user fragments in order and preserves the legacy fallback", async () => {
			const instructionFragments = [
				{ role: "developer", content: "Base instructions\n\n" },
				{ role: "developer", content: "Shared base section" },
				{ role: "user", content: "Project instructions\n\n" },
				{ role: "user", content: "Additional project context" },
				{ role: "developer", content: "Mode instructions\n\n" },
				{ role: "system", content: "Final base section" },
			] as const

			for await (const _chunk of handler.createMessage("Legacy prompt", messages, {
				taskId: "fragment-test",
				instructionFragments,
			})) {
				// consume stream
			}

			let requestMessages = mockCreate.mock.calls.at(-1)?.[0].messages
			expect(requestMessages?.slice(0, 3)).toEqual([
				{ role: "system", content: "Base instructions\n\nShared base section" },
				{ role: "user", content: "Project instructions\n\nAdditional project context" },
				{ role: "system", content: "Mode instructions\n\nFinal base section" },
			])
			expect(requestMessages?.[3]?.role).toBe("user")

			mockCreate.mockClear()
			for await (const _chunk of handler.createMessage("Legacy prompt", messages)) {
				// consume stream
			}

			requestMessages = mockCreate.mock.calls.at(-1)?.[0].messages
			expect(requestMessages?.[0]).toEqual({ role: "system", content: "Legacy prompt" })
			expect(requestMessages?.[1]?.role).toBe("user")
		})

		it("coalesces role-aware prompt fragments into one user message for DeepSeek R1", async () => {
			const r1Handler = new OpenAiHandler({ ...mockOptions, openAiModelId: "deepseek-reasoner" })
			const instructionFragments = [
				{ role: "developer", content: "Base instructions\n\n" },
				{ role: "developer", content: "Shared base section\n\n" },
				{ role: "user", content: "Project instructions\n\n" },
				{ role: "user", content: "Additional project context\n\n" },
				{ role: "system", content: "Mode instructions\n\n" },
				{ role: "system", content: "Final base section" },
			] as const

			for await (const _chunk of r1Handler.createMessage("Legacy prompt", [], {
				taskId: "r1-fragment-test",
				instructionFragments,
			})) {
				// consume stream
			}

			expect(mockCreate.mock.calls.at(-1)?.[0].messages).toEqual([
				{
					role: "user",
					content:
						"Base instructions\n\nShared base section\n\nProject instructions\n\nAdditional project context\n\nMode instructions\n\nFinal base section",
				},
			])
		})

		it("keeps prompt cache markers on role-aware instructions and conversation history", async () => {
			const cachedHandler = new OpenAiHandler({
				...mockOptions,
				openAiCustomModelInfo: { contextWindow: 128_000, supportsPromptCache: true },
			})
			const instructionFragments = [
				{ role: "developer", content: "Base instructions\n\n" },
				{ role: "developer", content: "Shared base section" },
				{ role: "user", content: "Project instructions\n\n" },
				{ role: "user", content: "Additional project context" },
				{ role: "developer", content: "Mode instructions\n\n" },
				{ role: "system", content: "Final base section" },
			] as const

			for await (const _chunk of cachedHandler.createMessage("Legacy prompt", messages, {
				taskId: "cache-fragment-test",
				instructionFragments,
			})) {
				// consume stream
			}

			const requestMessages = mockCreate.mock.calls.at(-1)?.[0].messages
			expect(requestMessages?.[0]).toMatchObject({
				role: "system",
				content: "Base instructions\n\nShared base section",
			})
			expect(requestMessages?.[1]).toEqual({
				role: "user",
				content: "Project instructions\n\nAdditional project context",
			})
			expect(requestMessages?.[2]).toMatchObject({
				role: "system",
				content: [
					{
						text: "Mode instructions\n\nFinal base section",
						cache_control: { type: "ephemeral" },
					},
				],
			})
			expect(requestMessages?.[3]).toMatchObject({
				role: "user",
				content: [{ text: "Hello!", cache_control: { type: "ephemeral" } }],
			})
		})

		it("should handle non-streaming mode", async () => {
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunk = chunks.find((chunk) => chunk.type === "text")
			const usageChunk = chunks.find((chunk) => chunk.type === "usage")

			expect(textChunk).toBeDefined()
			expect(textChunk?.text).toBe("Test response")
			expect(usageChunk).toBeDefined()
			expect(usageChunk?.inputTokens).toBe(10)
			expect(usageChunk?.outputTokens).toBe(5)
			expect(chunks).toContainEqual(expect.objectContaining({ type: "outcome", status: "completed" }))
		})

		it("should handle tool calls in non-streaming mode", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "test_tool",
										arguments: '{"arg":"value"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				},
			})

			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const toolCallChunks = chunks.filter((chunk) => chunk.type === "tool_call")
			expect(toolCallChunks).toHaveLength(1)
			expect(toolCallChunks[0]).toEqual({
				type: "tool_call",
				id: "call_1",
				name: "test_tool",
				arguments: '{"arg":"value"}',
			})
			expect(chunks).toContainEqual(expect.objectContaining({ type: "outcome", status: "completed" }))
		})

		it("does not expose non-streaming tool calls from a length-truncated response", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call-truncated",
									type: "function",
									function: { name: "apply_patch", arguments: '{"patch":"partial"}' },
								},
							],
						},
						finish_reason: "length",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			})
			const nonStreamingHandler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled: false })
			const chunks: any[] = []
			for await (const chunk of nonStreamingHandler.createMessage(systemPrompt, messages)) chunks.push(chunk)

			const accumulator = new AgentResponseAccumulator()
			for (const chunk of chunks) await accumulator.add(chunk)
			const response = await accumulator.finish()

			expect(chunks[0]).toMatchObject({ type: "outcome", status: "incomplete", terminal: true })
			expect(response.toolCalls).toEqual([])
			expect(response.outcome?.status).toBe("incomplete")
		})

		it("should handle streaming responses", async () => {
			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should handle tool calls in streaming responses", async () => {
			mockCreate.mockImplementation(async (options) => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_1",
												function: { name: "test_tool", arguments: "" },
											},
										],
									},
									finish_reason: null,
								},
							],
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: '{"arg":' } }],
									},
									finish_reason: null,
								},
							],
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: '"value"}' } }],
									},
									finish_reason: "tool_calls",
								},
							],
						}
					},
				}
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(3)
			// First chunk has id and name
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "test_tool",
				arguments: "",
			})
			// Subsequent chunks have arguments
			expect(toolCallPartialChunks[1]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: '{"arg":',
			})
			expect(toolCallPartialChunks[2]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: '"value"}',
			})

			// Verify tool_call_end event is emitted when finish_reason is "tool_calls"
			const toolCallEndChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(toolCallEndChunks).toHaveLength(1)
		})

		it("marks an open tool call incomplete when the stream stops without a tool_calls finish reason", async () => {
			mockCreate.mockImplementation(async (options) => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_fallback",
												function: { name: "fallback_tool", arguments: '{"test":"fallback"}' },
											},
										],
									},
									finish_reason: null,
								},
							],
						}
						// Stream ends without finish_reason being set to "tool_calls"
						yield {
							choices: [
								{
									delta: {},
									finish_reason: "stop", // Different finish reason
								},
							],
						}
					},
				}
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(1)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_fallback",
				name: "fallback_tool",
				arguments: '{"test":"fallback"}',
			})
			expect(chunks).toContainEqual(
				expect.objectContaining({ type: "outcome", status: "incomplete", terminal: true }),
			)
			expect(chunks.some((chunk) => chunk.type === "tool_call_end")).toBe(false)

			const accumulator = new AgentResponseAccumulator()
			for (const chunk of chunks) await accumulator.add(chunk)
			const response = await accumulator.finish()
			expect(response.toolCalls).toEqual([])
			expect(response.outcome?.status).toBe("incomplete")
		})

		it("marks EOF without a finish reason incomplete instead of completing assistant text", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { content: "Partial answer." }, finish_reason: null }] }
				},
			}))

			const chunks: unknown[] = []
			for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

			expect(chunks).toContainEqual(
				expect.objectContaining({
					type: "outcome",
					status: "incomplete",
					terminal: false,
					semanticOutputObserved: true,
				}),
			)
		})

		it("should include reasoning_effort when reasoning effort is enabled", async () => {
			const reasoningOptions: ApiHandlerOptions = {
				...mockOptions,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
					supportsReasoningEffort: true,
					reasoningEffort: "high",
				},
			}
			const reasoningHandler = new OpenAiHandler(reasoningOptions)
			const stream = reasoningHandler.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
			}
			// Assert the mockCreate was called with reasoning_effort
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.reasoning_effort).toBe("high")
		})

		it.each([true, false])("sends task overrides for a legacy custom profile (stream=%s)", async (streaming) => {
			const profile: ApiHandlerOptions = {
				...mockOptions,
				openAiStreamingEnabled: streaming,
				enableReasoningEffort: true,
				openAiCustomModelInfo: { contextWindow: 128_000, supportsPromptCache: false, reasoningEffort: "low" },
			}
			const before = structuredClone(profile)
			for (const preference of [
				{ kind: "effort", effort: "high" },
				{ kind: "effort", effort: "low" },
				{ kind: "default" },
				{ kind: "off" },
			] as const) {
				const resolution = resolveTaskReasoning(profile, preference, new OpenAiHandler(profile).getModel())
				const requestHandler = new OpenAiHandler(resolution.configuration)
				for await (const _chunk of requestHandler.createMessage(systemPrompt, messages)) {
					/* consume */
				}
			}
			expect(mockCreate.mock.calls.map(([request]) => request.reasoning_effort)).toEqual([
				"high",
				"low",
				"low",
				undefined,
			])
			expect(profile).toEqual(before)
		})

		it("should not include reasoning_effort when reasoning effort is disabled", async () => {
			const noReasoningOptions: ApiHandlerOptions = {
				...mockOptions,
				enableReasoningEffort: false,
				openAiCustomModelInfo: { contextWindow: 128_000, supportsPromptCache: false },
			}
			const noReasoningHandler = new OpenAiHandler(noReasoningOptions)
			const stream = noReasoningHandler.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
			}
			// Assert the mockCreate was called without reasoning_effort
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.reasoning_effort).toBeUndefined()
		})

		it("should include max_tokens when includeMaxTokens is true", async () => {
			const optionsWithMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096,
					supportsPromptCache: false,
				},
			}
			const handlerWithMaxTokens = new OpenAiHandler(optionsWithMaxTokens)
			const stream = handlerWithMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
			}
			// Assert the mockCreate was called with max_tokens
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(4096)
		})

		it("should not include max_tokens when includeMaxTokens is false", async () => {
			const optionsWithoutMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: false,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096,
					supportsPromptCache: false,
				},
			}
			const handlerWithoutMaxTokens = new OpenAiHandler(optionsWithoutMaxTokens)
			const stream = handlerWithoutMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
			}
			// Assert the mockCreate was called without max_tokens
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBeUndefined()
		})

		it("should not include max_tokens when includeMaxTokens is undefined", async () => {
			const optionsWithUndefinedMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				// includeMaxTokens is not set, should not include max_tokens
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096,
					supportsPromptCache: false,
				},
			}
			const handlerWithDefaultMaxTokens = new OpenAiHandler(optionsWithUndefinedMaxTokens)
			const stream = handlerWithDefaultMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
			}
			// Assert the mockCreate was called without max_tokens
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBeUndefined()
		})

		it("should use user-configured modelMaxTokens instead of model default maxTokens", async () => {
			const optionsWithUserMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				modelMaxTokens: 32000, // User-configured value
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096, // Model's default value (should not be used)
					supportsPromptCache: false,
				},
			}
			const handlerWithUserMaxTokens = new OpenAiHandler(optionsWithUserMaxTokens)
			const stream = handlerWithUserMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
			}
			// Assert the mockCreate was called with user-configured modelMaxTokens (32000), not model default maxTokens (4096)
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(32000)
		})

		it("should fallback to model default maxTokens when user modelMaxTokens is not set", async () => {
			const optionsWithoutUserMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				// modelMaxTokens is not set
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096, // Model's default value (should be used as fallback)
					supportsPromptCache: false,
				},
			}
			const handlerWithoutUserMaxTokens = new OpenAiHandler(optionsWithoutUserMaxTokens)
			const stream = handlerWithoutUserMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
			}
			// Assert the mockCreate was called with model default maxTokens (4096) as fallback
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(4096)
		})
	})

	describe("error handling", () => {
		const testMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello",
					},
				],
			},
		]

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))

			const stream = handler.createMessage("system prompt", testMessages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should not reach here
				}
			}).rejects.toThrow("API Error")
		})

		it("should handle rate limiting", async () => {
			const rateLimitError = new Error("Rate limit exceeded")
			rateLimitError.name = "Error"
			;(rateLimitError as any).status = 429
			mockCreate.mockRejectedValueOnce(rateLimitError)

			const stream = handler.createMessage("system prompt", testMessages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should not reach here
				}
			}).rejects.toThrow("Rate limit exceeded")
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.openAiModelId,
					messages: [{ role: "user", content: "Test prompt" }],
				},
				{},
			)
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("OpenAI completion error: API Error")
		})

		it("should handle empty response", async () => {
			mockCreate.mockImplementationOnce(() => ({
				choices: [{ message: { content: "" } }],
			}))
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})
	})

	describe("getModel", () => {
		it("should return model info with sane defaults", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mockOptions.openAiModelId)
			expect(model.info).toBeDefined()
			expect(model.info.contextWindow).toBe(128_000)
			expect(model.info.supportsImages).toBe(true)
		})

		it("should handle undefined model ID", () => {
			const handlerWithoutModel = new OpenAiHandler({
				...mockOptions,
				openAiModelId: undefined,
			})
			const model = handlerWithoutModel.getModel()
			expect(model.id).toBe("")
			expect(model.info).toBeDefined()
		})
	})

	describe("Azure AI Inference Service", () => {
		const azureOptions = {
			...mockOptions,
			openAiBaseUrl: "https://test.services.ai.azure.com",
			openAiModelId: "deepseek-v3",
			azureApiVersion: "2024-05-01-preview",
		}

		it("should initialize with Azure AI Inference Service configuration", () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			expect(azureHandler).toBeInstanceOf(OpenAiHandler)
			expect(azureHandler.getModel().id).toBe(azureOptions.openAiModelId)
		})

		it("should handle streaming responses with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = azureHandler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")

			// Verify the API call was made with correct Azure AI Inference Service path
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					temperature: 0,
					tools: undefined,
					tool_choice: undefined,
					parallel_tool_calls: true,
				},
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when not explicitly set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should handle non-streaming responses with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler({
				...azureOptions,
				openAiStreamingEnabled: false,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = azureHandler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunk = chunks.find((chunk) => chunk.type === "text")
			const usageChunk = chunks.find((chunk) => chunk.type === "usage")

			expect(textChunk).toBeDefined()
			expect(textChunk?.text).toBe("Test response")
			expect(usageChunk).toBeDefined()
			expect(usageChunk?.inputTokens).toBe(10)
			expect(usageChunk?.outputTokens).toBe(5)

			// Verify the API call was made with correct Azure AI Inference Service path
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: "Hello!" },
					],
					tools: undefined,
					tool_choice: undefined,
					parallel_tool_calls: true,
				},
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when not explicitly set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should handle completePrompt with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			const result = await azureHandler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [{ role: "user", content: "Test prompt" }],
				},
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when includeMaxTokens is not set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})
	})

	describe("Grok xAI Provider", () => {
		const grokOptions = {
			...mockOptions,
			openAiBaseUrl: "https://api.x.ai/v1",
			openAiModelId: "grok-1",
		}

		it("should initialize with Grok xAI configuration", () => {
			const grokHandler = new OpenAiHandler(grokOptions)
			expect(grokHandler).toBeInstanceOf(OpenAiHandler)
			expect(grokHandler.getModel().id).toBe(grokOptions.openAiModelId)
		})

		it("should exclude stream_options when streaming with Grok xAI", async () => {
			const grokHandler = new OpenAiHandler(grokOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = grokHandler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: grokOptions.openAiModelId,
					stream: true,
				}),
				{},
			)

			const mockCalls = mockCreate.mock.calls
			const lastCall = mockCalls[mockCalls.length - 1]
			expect(lastCall[0]).not.toHaveProperty("stream_options")
		})
	})

	describe("O3 Family Models", () => {
		const o3Options = {
			...mockOptions,
			openAiModelId: "o3-mini",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 65536,
				supportsPromptCache: false,
				reasoningEffort: "medium" as "low" | "medium" | "high",
			},
		}

		it.each([true, false])("keeps developer and user instruction roles in order (stream=%s)", async (streaming) => {
			const o3Handler = new OpenAiHandler({ ...o3Options, openAiStreamingEnabled: streaming })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]
			const instructionFragments = [
				{ role: "developer", content: "Base instructions\n\n" },
				{ role: "developer", content: "Shared base section" },
				{ role: "user", content: "Project instructions\n\n" },
				{ role: "user", content: "Additional project context" },
				{ role: "system", content: "Mode instructions\n\n" },
				{ role: "developer", content: "Final base section" },
			] as const

			for await (const _chunk of o3Handler.createMessage("Legacy prompt", messages, {
				taskId: "o3-fragment-test",
				instructionFragments,
			})) {
				// consume stream
			}

			const requestMessages = mockCreate.mock.calls.at(-1)?.[0].messages
			expect(requestMessages?.slice(0, 3)).toEqual([
				{ role: "developer", content: "Formatting re-enabled\nBase instructions\n\nShared base section" },
				{ role: "user", content: "Project instructions\n\nAdditional project context" },
				{ role: "developer", content: "Mode instructions\n\nFinal base section" },
			])
		})

		it("should handle O3 model with streaming and include max_completion_tokens when includeMaxTokens is true", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				includeMaxTokens: true,
				modelMaxTokens: 32000,
				modelTemperature: 0.5,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					reasoning_effort: "medium",
					temperature: undefined,
					// O3 models do not support deprecated max_tokens but do support max_completion_tokens
					max_completion_tokens: 32000,
				}),
				{},
			)
		})

		it("uses the task-selected effort instead of the custom model default", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				enableReasoningEffort: true,
				reasoningEffort: "high",
				openAiCustomModelInfo: {
					...o3Options.openAiCustomModelInfo,
					reasoningEffort: "low",
				},
			})

			for await (const _chunk of o3Handler.createMessage("system", [])) {
				// Consume the stream so the request is dispatched.
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ reasoning_effort: "high" }),
				expect.anything(),
			)
		})

		it("should handle tool calls with O3 model in streaming mode", async () => {
			const o3Handler = new OpenAiHandler(o3Options)

			mockCreate.mockImplementation(async (options) => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_1",
												function: { name: "test_tool", arguments: "" },
											},
										],
									},
									finish_reason: null,
								},
							],
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: "{}" } }],
									},
									finish_reason: "tool_calls",
								},
							],
						}
					},
				}
			})

			const stream = o3Handler.createMessage("system", [])
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(2)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "test_tool",
				arguments: "",
			})
			expect(toolCallPartialChunks[1]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: "{}",
			})

			// Verify tool_call_end event is emitted when finish_reason is "tool_calls"
			const toolCallEndChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(toolCallEndChunks).toHaveLength(1)
		})

		it("marks O3 tool fragments incomplete when finish_reason is length", async () => {
			const o3Handler = new OpenAiHandler(o3Options)

			mockCreate.mockImplementation(async (options) => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_o3_fallback",
												function: { name: "o3_fallback_tool", arguments: '{"o3":"test"}' },
											},
										],
									},
									finish_reason: null,
								},
							],
						}
						// Stream ends with different finish reason
						yield {
							choices: [
								{
									delta: {},
									finish_reason: "length", // Different finish reason
								},
							],
						}
					},
				}
			})

			const stream = o3Handler.createMessage("system", [])
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(1)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_o3_fallback",
				name: "o3_fallback_tool",
				arguments: '{"o3":"test"}',
			})
			expect(chunks).toContainEqual(expect.objectContaining({ type: "outcome", status: "incomplete" }))
		})

		it("should handle O3 model with streaming and exclude max_tokens when includeMaxTokens is false", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				includeMaxTokens: false,
				modelTemperature: 0.7,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					reasoning_effort: "medium",
					temperature: undefined,
				}),
				{},
			)

			// Verify max_tokens is NOT included
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should handle O3 model non-streaming with reasoning_effort and max_completion_tokens when includeMaxTokens is true", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				openAiStreamingEnabled: false,
				includeMaxTokens: true,
				modelTemperature: 0.3,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					reasoning_effort: "medium",
					temperature: undefined,
					// O3 models do not support deprecated max_tokens but do support max_completion_tokens
					max_completion_tokens: 65536, // Using default maxTokens from o3Options
				}),
				{},
			)

			// Verify stream is not set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("stream")
		})

		it("should handle tool calls with O3 model in non-streaming mode", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				openAiStreamingEnabled: false,
			})

			mockCreate.mockResolvedValueOnce({
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "test_tool",
										arguments: "{}",
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				},
			})

			const stream = o3Handler.createMessage("system", [])
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const toolCallChunks = chunks.filter((chunk) => chunk.type === "tool_call")
			expect(toolCallChunks).toHaveLength(1)
			expect(toolCallChunks[0]).toEqual({
				type: "tool_call",
				id: "call_1",
				name: "test_tool",
				arguments: "{}",
			})
		})

		it("should use default temperature of 0 when not specified for O3 models", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				// No modelTemperature specified
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: undefined, // Temperature is not supported for O3 models
				}),
				{},
			)
		})

		it("should handle O3 model with Azure AI Inference Service respecting includeMaxTokens", async () => {
			const o3AzureHandler = new OpenAiHandler({
				...o3Options,
				openAiBaseUrl: "https://test.services.ai.azure.com",
				includeMaxTokens: false, // Should NOT include max_tokens
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3AzureHandler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
				}),
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when includeMaxTokens is false
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should NOT include max_tokens for O3 model with Azure AI Inference Service even when includeMaxTokens is true", async () => {
			const o3AzureHandler = new OpenAiHandler({
				...o3Options,
				openAiBaseUrl: "https://test.services.ai.azure.com",
				includeMaxTokens: true, // Should include max_tokens
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3AzureHandler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					// O3 models do not support max_tokens
				}),
				{ path: "/models/chat/completions" },
			)
		})
	})
})

describe("getOpenAiModels", () => {
	beforeEach(() => {
		vi.mocked(axios.get).mockClear()
	})

	it("should return empty array when baseUrl is not provided", async () => {
		const result = await getOpenAiModels(undefined, "test-key")
		expect(result).toEqual([])
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("should return empty array when baseUrl is empty string", async () => {
		const result = await getOpenAiModels("", "test-key")
		expect(result).toEqual([])
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("should trim whitespace from baseUrl", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "gpt-4" }, { id: "gpt-3.5-turbo" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const result = await getOpenAiModels("  https://api.openai.com/v1  ", "test-key")

		expect(axios.get).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.any(Object))
		expect(result).toEqual(["gpt-4", "gpt-3.5-turbo"])
	})

	it("should handle baseUrl with trailing spaces", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }, { id: "model-2" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const result = await getOpenAiModels("https://api.example.com/v1 ", "test-key")

		expect(axios.get).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.any(Object))
		expect(result).toEqual(["model-1", "model-2"])
	})

	it("should handle baseUrl with leading spaces", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const result = await getOpenAiModels(" https://api.example.com/v1", "test-key")

		expect(axios.get).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.any(Object))
		expect(result).toEqual(["model-1"])
	})

	it("should return empty array for invalid URL after trimming", async () => {
		const result = await getOpenAiModels("   not-a-valid-url   ", "test-key")
		expect(result).toEqual([])
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("should include authorization header when apiKey is provided", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		await getOpenAiModels("https://api.example.com/v1", "test-api-key")

		expect(axios.get).toHaveBeenCalledWith(
			"https://api.example.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer test-api-key",
				}),
			}),
		)
	})

	it("should include custom headers when provided", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const customHeaders = {
			"X-Custom-Header": "custom-value",
		}

		await getOpenAiModels("https://api.example.com/v1", "test-key", customHeaders)

		expect(axios.get).toHaveBeenCalledWith(
			"https://api.example.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-Custom-Header": "custom-value",
					Authorization: "Bearer test-key",
				}),
			}),
		)
	})

	it("should handle API errors gracefully", async () => {
		vi.mocked(axios.get).mockRejectedValueOnce(new Error("Network error"))

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual([])
	})

	it("should handle malformed response data", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({ data: null })

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual([])
	})

	it("should deduplicate model IDs", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "gpt-4" }, { id: "gpt-4" }, { id: "gpt-3.5-turbo" }, { id: "gpt-4" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual(["gpt-4", "gpt-3.5-turbo"])
	})
})
