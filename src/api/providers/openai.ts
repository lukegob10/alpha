import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"
import axios from "axios"

import {
	type ModelInfo,
	taskReasoningCustomTokenPattern,
	azureOpenAiDefaultApiVersion,
	openAiModelInfoSaneDefaults,
	resolveOpenAiCustomModelInfo,
	OPENAI_AZURE_AI_INFERENCE_PATH,
} from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { TagMatcher } from "../../utils/tag-matcher"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import {
	ApiStream,
	ApiStreamUsageChunk,
	type ApiStreamCapabilities,
	createApiStreamOutcome,
	createLinkedAbortController,
	iterateApiStreamWithAbort,
	isApiStreamAbortError,
} from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"
import { getNativeOpenAiModelCapabilities } from "./utils/openai-model-capabilities"

import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import type { ApiInstructionFragment, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { handleOpenAIError } from "./utils/openai-error-handler"
import {
	buildOpenAiResponsesInput,
	encodeOpenAiCustomToolInputDelta,
	normalizeOpenAiCustomToolInput,
	supportsOpenAiResponsesFreeformApplyPatch,
	toOpenAiResponsesToolChoice,
	toOpenAiResponsesTools,
} from "./openai-responses"

// OpenAI-compatible endpoints may expose DeepSeek reasoning models. Keep this
// protocol default local to the generic adapter; the retired DeepSeek catalog
// and provider remain removed.
const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.3

function usesOpenAiResponsesApi(modelId: string, options: ApiHandlerOptions): boolean {
	const deepseekReasoner = modelId.includes("deepseek-reasoner") || (options.openAiR1FormatEnabled ?? false)
	return (
		!deepseekReasoner &&
		getNativeOpenAiModelCapabilities(modelId, options.openAiBaseUrl, options.openAiUseAzure)?.responses === true
	)
}

function createOpenAiChatCompletionOutcome(
	finishReason: string | null | undefined,
	terminal: boolean,
	semanticOutputObserved: boolean,
	hasUnterminatedToolCall = false,
) {
	if (!terminal) {
		return createApiStreamOutcome({
			status: "incomplete",
			terminal: false,
			semanticOutputObserved,
			reason: "OpenAI Chat Completions stream ended before a terminal finish reason.",
		})
	}

	if (finishReason === "length") {
		return createApiStreamOutcome({
			status: "incomplete",
			terminal: true,
			semanticOutputObserved,
			reason: "OpenAI Chat Completions response reached the output token limit (finish_reason=length).",
		})
	}

	if (finishReason === "content_filter") {
		return createApiStreamOutcome({
			status: "incomplete",
			terminal: true,
			semanticOutputObserved,
			reason: "OpenAI Chat Completions response was stopped by a content filter.",
		})
	}

	if (finishReason === "stop" && hasUnterminatedToolCall) {
		return createApiStreamOutcome({
			status: "incomplete",
			terminal: true,
			semanticOutputObserved,
			reason: "OpenAI Chat Completions stopped before its streamed tool call was complete.",
		})
	}

	if (finishReason === "stop" || finishReason === "tool_calls") {
		return createApiStreamOutcome({ status: "completed", terminal: true, semanticOutputObserved })
	}

	return createApiStreamOutcome({
		status: "incomplete",
		terminal: true,
		semanticOutputObserved,
		reason: finishReason
			? `OpenAI Chat Completions ended with an unrecognized finish reason (${finishReason}).`
			: "OpenAI Chat Completions response did not include a terminal finish reason.",
	})
}

function hasOpenAiReasoningText(value: unknown): boolean {
	if (!value || typeof value !== "object") return false
	const record = value as Record<string, unknown>
	return Boolean(
		(typeof record.reasoning_content === "string" && record.reasoning_content) ||
			(typeof record.reasoning === "string" && record.reasoning),
	)
}

type OpenAiInstructionRole = "developer" | "system" | "user"

interface OpenAiResponsesToolCallState {
	id: string
	name: string
	type: "custom" | "function"
	customInput: string
	functionArguments: string
}

export interface OpenAiResponsesReasoningItem {
	id: string
	encrypted_content: string
	summary?: OpenAI.Responses.ResponseReasoningItem["summary"]
}

function coalesceOpenAiInstructionFragments(
	fragments: readonly ApiInstructionFragment[],
	getRole: (fragment: ApiInstructionFragment) => OpenAiInstructionRole,
): Array<{ role: OpenAiInstructionRole; content: string }> {
	const messages: Array<{ role: OpenAiInstructionRole; content: string }> = []
	for (const fragment of fragments) {
		if (!fragment.content) continue
		const role = getRole(fragment)
		const previous = messages[messages.length - 1]
		if (previous?.role === role) {
			previous.content += fragment.content
		} else {
			messages.push({ role, content: fragment.content })
		}
	}
	return messages
}

function toOpenAiInstructionMessages(
	fragments: readonly ApiInstructionFragment[],
	privilegedRole: "developer" | "system",
	cacheBoundary = false,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const messages = coalesceOpenAiInstructionFragments(fragments, ({ role }) =>
		role === "user" ? "user" : privilegedRole,
	)
	const cacheBoundaryIndex = cacheBoundary ? messages.length - 1 : -1

	return messages.map(({ role, content: text }, index) => {
		if (index === cacheBoundaryIndex) {
			const content = {
				type: "text" as const,
				text,
				cache_control: { type: "ephemeral" as const },
			} as OpenAI.Chat.ChatCompletionContentPartText & { cache_control: { type: "ephemeral" } }
			return { role, content: [content] }
		}
		return { role, content: text }
	})
}

function toOpenAiReasoningInstructionMessages(
	fragments: readonly ApiInstructionFragment[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const messages = coalesceOpenAiInstructionFragments(fragments, ({ role }) =>
		role === "user" ? "user" : "developer",
	)
	const firstPrivilegedIndex = messages.findIndex(({ role }) => role === "developer")
	if (firstPrivilegedIndex === -1) {
		return [
			{ role: "developer", content: "Formatting re-enabled" },
			...messages.map(({ content }) => ({ role: "user" as const, content })),
		]
	}

	return messages.map(({ role, content }, index) => ({
		role,
		content: index === firstPrivilegedIndex ? `Formatting re-enabled\n${content}` : content,
	}))
}

function toR1InstructionMessages(
	systemPrompt: string,
	fragments: readonly ApiInstructionFragment[] | undefined,
): Anthropic.Messages.MessageParam[] {
	const content =
		fragments === undefined
			? systemPrompt
			: coalesceOpenAiInstructionFragments(fragments, () => "user")
					.map(({ content }) => content)
					.join("")
	return content ? [{ role: "user", content }] : []
}

function openAiResponsesOutputIdentity(item: OpenAI.Responses.ResponseOutputItem): string {
	return item.type === "function_call" || item.type === "custom_tool_call"
		? JSON.stringify([item.type, item.call_id, item.name])
		: JSON.stringify([item.type, item.id])
}

// TODO: Rename this to OpenAICompatibleHandler. Also, I think the
// `OpenAINativeHandler` can subclass from this, since it's obviously
// compatible with the OpenAI API. We can also rename it to `OpenAIHandler`.
export class OpenAiHandler extends BaseProvider implements SingleCompletionHandler {
	readonly streamCapabilities: ApiStreamCapabilities
	protected options: ApiHandlerOptions
	protected client: OpenAI
	private readonly providerName = "OpenAI"
	private lastReasoningDetails?: unknown[]
	private responsesResponseId?: string
	private responsesEncryptedContent?: { encrypted_content: string; id?: string }
	private responsesReasoningItems = new Map<number, OpenAiResponsesReasoningItem>()
	private responsesSummary?: OpenAI.Responses.ResponseReasoningItem["summary"]

	getReasoningDetails(): unknown[] | undefined {
		return this.lastReasoningDetails
	}

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		const modelId = this.options.openAiModelId ?? ""
		this.streamCapabilities = {
			cancellation: true,
			...(!usesOpenAiResponsesApi(modelId, this.options) ? { lifecycle: true } : {}),
		}

		const baseURL = this.options.openAiBaseUrl || "https://api.openai.com/v1"
		const apiKey = this.options.openAiApiKey ?? "not-provided"
		const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
		const urlHost = this._getUrlHost(this.options.openAiBaseUrl)
		const isAzureOpenAi = urlHost === "azure.com" || urlHost.endsWith(".azure.com") || options.openAiUseAzure

		const headers = {
			...DEFAULT_HEADERS,
			...(this.options.openAiHeaders || {}),
		}

		const timeout = getApiRequestTimeout()

		if (isAzureAiInference) {
			// Azure AI Inference Service (e.g., for DeepSeek) uses a different path structure
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				defaultQuery: { "api-version": this.options.azureApiVersion || "2024-05-01-preview" },
				timeout,
			})
		} else if (isAzureOpenAi) {
			// Azure API shape slightly differs from the core API shape:
			// https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
			this.client = new AzureOpenAI({
				baseURL,
				apiKey,
				apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
				defaultHeaders: headers,
				timeout,
			})
		} else {
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				timeout,
			})
		}
	}

	protected shouldUseResponsesApi(modelId = this.options.openAiModelId ?? ""): boolean {
		return usesOpenAiResponsesApi(modelId, this.options)
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.lastReasoningDetails = undefined
		const control =
			metadata && (metadata.signal || metadata.deadline) ? createLinkedAbortController(metadata) : undefined
		try {
			if (!control || !metadata) {
				yield* this.createMessageInternal(systemPrompt, messages, metadata)
				return
			}
			control.signal.throwIfAborted()
			yield* iterateApiStreamWithAbort(
				this.createMessageInternal(systemPrompt, messages, { ...metadata, signal: control.signal }),
				control.signal,
			)
			control.signal.throwIfAborted()
		} catch (error) {
			if (isApiStreamAbortError(error, control?.signal ?? metadata?.signal)) throw error
			// Request admission and asynchronous stream iteration share one metadata-preserving boundary.
			throw handleOpenAIError(error, this.providerName)
		} finally {
			control?.controller.abort()
			control?.dispose()
		}
	}

	private async *createMessageInternal(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.responsesResponseId = undefined
		this.responsesEncryptedContent = undefined
		this.responsesReasoningItems.clear()
		this.responsesSummary = undefined
		const { info: modelInfo, reasoning } = this.getModel()
		const effectiveReasoning = this.getRuntimeReasoning(reasoning)
		const modelUrl = this.options.openAiBaseUrl ?? ""
		const modelId = this.options.openAiModelId ?? ""
		const enabledR1Format = this.options.openAiR1FormatEnabled ?? false
		const isAzureAiInference = this._isAzureAiInference(modelUrl)
		const deepseekReasoner = modelId.includes("deepseek-reasoner") || enabledR1Format
		// Tool visibility can change by mode or approval policy; it must not switch
		// a Codex GPT request between Responses and Chat Completions mid-task.
		const supportsCodexResponses = this.shouldUseResponsesApi(modelId)
		const freeformApplyPatch = supportsOpenAiResponsesFreeformApplyPatch(
			modelId,
			this.options.openAiBaseUrl,
			this.options.openAiUseAzure,
		)
		const responseTools = supportsCodexResponses
			? toOpenAiResponsesTools(this.convertToolsForOpenAI(metadata?.tools), freeformApplyPatch)
			: undefined

		if (supportsCodexResponses) {
			if (metadata?.tools !== undefined && responseTools === undefined) {
				throw new Error("A Codex Responses tool could not be converted from its provider schema.")
			}
			yield* this.handleResponsesMessage(
				modelId,
				systemPrompt,
				messages,
				modelInfo,
				effectiveReasoning,
				responseTools,
				freeformApplyPatch,
				metadata,
			)
			return
		}

		if (modelId.includes("o1") || modelId.includes("o3") || modelId.includes("o4")) {
			yield* this.handleO3FamilyMessage(modelId, systemPrompt, messages, metadata)
			return
		}
		const instructionFragments = metadata?.instructionFragments

		let systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
			role: "system",
			content: systemPrompt,
		}

		if (this.options.openAiStreamingEnabled ?? true) {
			let convertedMessages

			if (deepseekReasoner) {
				convertedMessages = convertToR1Format([
					...toR1InstructionMessages(systemPrompt, instructionFragments),
					...messages,
				])
			} else {
				const historyMessages = convertToOpenAiMessages(messages)
				let cacheableMessages: OpenAI.Chat.ChatCompletionMessageParam[]
				if (instructionFragments !== undefined) {
					const instructionMessages = toOpenAiInstructionMessages(
						instructionFragments,
						"system",
						modelInfo.supportsPromptCache,
					)
					convertedMessages = [...instructionMessages, ...historyMessages]
					cacheableMessages = historyMessages
				} else {
					if (modelInfo.supportsPromptCache) {
						systemMessage = {
							role: "system",
							content: [
								{
									type: "text",
									text: systemPrompt,
									// @ts-ignore-next-line
									cache_control: { type: "ephemeral" },
								},
							],
						}
					}
					convertedMessages = [systemMessage, ...historyMessages]
					cacheableMessages = convertedMessages
				}

				if (modelInfo.supportsPromptCache) {
					// Keep the compatibility normalization local to the OpenAI-compatible adapter:
					// Add cache_control to the last two user messages
					// (note: this works because we only ever add one user message at a time, but if we added multiple we'd need to mark the user message before the last assistant message)
					const lastTwoUserMessages = cacheableMessages.filter((msg) => msg.role === "user").slice(-2)

					lastTwoUserMessages.forEach((msg) => {
						if (typeof msg.content === "string") {
							msg.content = [{ type: "text", text: msg.content }]
						}

						if (Array.isArray(msg.content)) {
							// NOTE: this is fine since env details will always be added at the end. but if it weren't there, and the user added a image_url type message, it would pop a text part before it and then move it after to the end.
							let lastTextPart = msg.content.filter((part) => part.type === "text").pop()

							if (!lastTextPart) {
								lastTextPart = { type: "text", text: "..." }
								msg.content.push(lastTextPart)
							}

							// @ts-ignore-next-line
							lastTextPart["cache_control"] = { type: "ephemeral" }
						}
					})
				}
			}

			const isGrokXAI = this._isGrokXAI(this.options.openAiBaseUrl)

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				temperature: this.options.modelTemperature ?? (deepseekReasoner ? DEEP_SEEK_DEFAULT_TEMPERATURE : 0),
				messages: convertedMessages,
				stream: true as const,
				...(isGrokXAI ? {} : { stream_options: { include_usage: true } }),
				...(effectiveReasoning && effectiveReasoning),
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			const stream = await this.client.chat.completions.create(requestOptions, {
				...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				...(metadata?.signal ? { signal: metadata.signal } : {}),
			})

			const matcher = new TagMatcher(
				"think",
				(chunk) =>
					({
						type: chunk.matched ? "reasoning" : "text",
						text: chunk.data,
					}) as const,
			)

			let lastUsage
			const activeToolCallIds = new Set<string>()
			let finishReason: string | null | undefined
			let sawTerminalFinishReason = false
			let semanticOutputObserved = false
			let sawToolCallFragment = false

			for await (const chunk of stream) {
				const delta = chunk.choices?.[0]?.delta ?? {}
				const chunkFinishReason = chunk.choices?.[0]?.finish_reason
				if (chunkFinishReason) {
					finishReason = chunkFinishReason
					sawTerminalFinishReason = true
				}

				if (delta.content) {
					semanticOutputObserved = true
					for (const chunk of matcher.update(delta.content)) {
						yield chunk
					}
				}

				const reasoningChunks = [...this.readReasoning(delta)]
				if (reasoningChunks.length > 0) semanticOutputObserved = true
				for (const reasoningChunk of reasoningChunks) yield reasoningChunk

				if (delta.tool_calls?.length) {
					semanticOutputObserved = true
					sawToolCallFragment = true
				}

				yield* this.processToolCalls(delta, chunkFinishReason, activeToolCallIds)

				if (chunk.usage) {
					lastUsage = chunk.usage
				}
			}

			for (const chunk of matcher.final()) {
				yield chunk
			}

			if (lastUsage) {
				yield this.processUsageMetrics(lastUsage, modelInfo)
			}

			yield createOpenAiChatCompletionOutcome(
				finishReason,
				sawTerminalFinishReason,
				semanticOutputObserved,
				sawToolCallFragment && finishReason !== "tool_calls",
			)
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: deepseekReasoner
					? convertToR1Format([...toR1InstructionMessages(systemPrompt, instructionFragments), ...messages])
					: [
							...(instructionFragments !== undefined
								? toOpenAiInstructionMessages(instructionFragments, "system")
								: [systemMessage]),
							...convertToOpenAiMessages(messages),
						],
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
				...(effectiveReasoning && effectiveReasoning),
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			const response = await this.client.chat.completions.create(requestOptions, {
				...(this._isAzureAiInference(modelUrl) ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				...(metadata?.signal ? { signal: metadata.signal } : {}),
			})

			const message = response.choices?.[0]?.message
			const finishReason = response.choices?.[0]?.finish_reason
			const outcome = createOpenAiChatCompletionOutcome(
				finishReason,
				true,
				Boolean(message?.content || message?.tool_calls?.length || hasOpenAiReasoningText(message)),
				Boolean(message?.tool_calls?.length) && finishReason !== "tool_calls",
			)
			if (outcome.status !== "completed") yield outcome

			yield* this.readReasoning(message)

			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
						yield { type: "tool_call_end", id: toolCall.id }
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}

			yield this.processUsageMetrics(response.usage, modelInfo)
			if (outcome.status === "completed") yield outcome
		}
	}

	private async *handleResponsesMessage(
		modelId: string,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		modelInfo: ModelInfo,
		effectiveReasoning:
			| { reasoning_effort: OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"] }
			| undefined,
		tools: OpenAI.Responses.Tool[] | undefined,
		freeformApplyPatch: boolean,
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const summaryEnabled = this.options.enableResponsesReasoningSummary !== false
		const store = metadata?.store ?? false
		const reasoning = {
			...(effectiveReasoning?.reasoning_effort !== undefined
				? { effort: effectiveReasoning.reasoning_effort }
				: {}),
			...(summaryEnabled ? { summary: "auto" as const } : {}),
		}
		const maxOutputTokens = this.options.modelMaxTokens || modelInfo.maxTokens
		const commonOptions = {
			model: modelId,
			input: buildOpenAiResponsesInput(
				systemPrompt,
				metadata?.instructionFragments,
				messages,
				store,
				freeformApplyPatch,
			),
			...(tools !== undefined ? { tools } : {}),
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			include: ["reasoning.encrypted_content" as const],
			...(metadata?.tool_choice !== undefined
				? { tool_choice: toOpenAiResponsesToolChoice(metadata.tool_choice, freeformApplyPatch) }
				: {}),
			store,
			...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
			...(this.options.includeMaxTokens === true && maxOutputTokens
				? { max_output_tokens: maxOutputTokens }
				: {}),
		}

		if (this.options.openAiStreamingEnabled ?? true) {
			const requestOptions: OpenAI.Responses.ResponseCreateParamsStreaming = {
				...commonOptions,
				stream: true,
			}
			const stream = await this.client.responses.create(requestOptions, {
				...(metadata?.signal ? { signal: metadata.signal } : {}),
			})
			yield* this.handleOpenAiResponsesStream(stream)
			return
		}

		const requestOptions: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
			...commonOptions,
			stream: false,
		}
		const response = await this.client.responses.create(requestOptions, {
			...(metadata?.signal ? { signal: metadata.signal } : {}),
		})
		yield* this.handleOpenAiResponsesResult(response)
	}

	private async *handleOpenAiResponsesStream(stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>): ApiStream {
		const toolCalls = new Map<number, OpenAiResponsesToolCallState>()
		const handledOutputIdentities = new Map<number, string>()
		const textDeltaParts = new Set<string>()
		let reasoningSummary = ""
		let receivedTerminalEvent = false

		for await (const event of stream) {
			switch (event.type) {
				case "response.output_item.added": {
					const item = event.item
					if (item.type === "function_call") {
						toolCalls.set(event.output_index, {
							id: item.call_id,
							name: item.name,
							type: "function",
							customInput: "",
							functionArguments: "",
						})
						yield {
							type: "tool_call_partial",
							index: event.output_index,
							id: item.call_id,
							name: item.name,
						}
					} else if (item.type === "custom_tool_call") {
						toolCalls.set(event.output_index, {
							id: item.call_id,
							name: item.name,
							type: "custom",
							customInput: "",
							functionArguments: "",
						})
						yield {
							type: "tool_call_partial",
							index: event.output_index,
							id: item.call_id,
							name: item.name,
							arguments: item.name === "apply_patch" ? '{"patch":"' : undefined,
						}
					}
					break
				}
				case "response.function_call_arguments.delta": {
					const call = toolCalls.get(event.output_index)
					if (call?.type === "function") {
						call.functionArguments += event.delta
						yield { type: "tool_call_partial", index: event.output_index, arguments: event.delta }
					}
					break
				}
				case "response.custom_tool_call_input.delta": {
					const call = toolCalls.get(event.output_index)
					if (call?.type === "custom") {
						call.customInput += event.delta
						yield {
							type: "tool_call_partial",
							index: event.output_index,
							arguments: encodeOpenAiCustomToolInputDelta(call.name, event.delta),
						}
					}
					break
				}
				case "response.output_text.delta": {
					textDeltaParts.add(`${event.output_index}:${event.content_index}`)
					yield { type: "text", text: event.delta }
					break
				}
				case "response.refusal.delta": {
					textDeltaParts.add(`${event.output_index}:${event.content_index}`)
					yield { type: "text", text: event.delta }
					break
				}
				case "response.reasoning_summary_text.delta": {
					reasoningSummary += event.delta
					break
				}
				case "response.output_item.done": {
					if (!Number.isSafeInteger(event.output_index) || event.output_index < 0) {
						throw new Error("OpenAI Responses output item has an invalid index")
					}
					if ("status" in event.item && event.item.status === "incomplete") {
						throw new Error("OpenAI Responses output item is incomplete")
					}
					// Output indexes remain stable through completion even when an item has no provider ID.
					const identity = openAiResponsesOutputIdentity(event.item)
					const handled = handledOutputIdentities.get(event.output_index)
					if (handled !== undefined) {
						if (handled !== identity) throw new Error("OpenAI Responses output item changed identity")
						break
					}
					handledOutputIdentities.set(event.output_index, identity)
					yield* this.emitOpenAiResponsesOutputItem(event.item, event.output_index, toolCalls, textDeltaParts)
					break
				}
				case "response.incomplete":
					throw new Error(
						`OpenAI Responses request is incomplete: ${event.response.incomplete_details?.reason ?? "unknown reason"}`,
					)
				case "response.completed": {
					receivedTerminalEvent = true
					yield* this.finishOpenAiResponsesResult(
						event.response,
						toolCalls,
						handledOutputIdentities,
						textDeltaParts,
						reasoningSummary,
						true,
					)
					break
				}
				case "response.failed": {
					const message = event.response.error?.message ?? "OpenAI Responses request failed"
					throw new Error(message)
				}
				case "error":
					throw new Error(event.message)
				default:
					break
			}
			if (receivedTerminalEvent) return
		}

		if (!receivedTerminalEvent) throw new Error("OpenAI Responses stream ended without a terminal event")
	}

	private async *handleOpenAiResponsesResult(response: OpenAI.Responses.Response): ApiStream {
		const toolCalls = new Map<number, OpenAiResponsesToolCallState>()
		const textDeltaParts = new Set<string>()
		yield* this.finishOpenAiResponsesResult(response, toolCalls, new Map(), textDeltaParts, "")
	}

	private async *finishOpenAiResponsesResult(
		response: Partial<OpenAI.Responses.Response> & { end_turn?: boolean },
		toolCalls: Map<number, OpenAiResponsesToolCallState>,
		handledOutputIdentities: Map<number, string>,
		textDeltaParts: Set<string>,
		reasoningSummary: string,
		completedEvent = false,
	): ApiStream {
		if (response.status !== "completed" && (!completedEvent || response.status !== undefined)) {
			throw new Error(`OpenAI Responses request ended with status ${response.status}`)
		}
		if (typeof response.id !== "string" || !response.id) {
			throw new Error("OpenAI Responses completed without a response id")
		}
		if (response.output !== undefined && !Array.isArray(response.output)) {
			throw new Error("OpenAI Responses completed with invalid output")
		}
		if (!completedEvent && response.output === undefined) {
			throw new Error("OpenAI Responses result did not include output")
		}
		const output = response.output ?? []
		if (output.some((item) => "status" in item && item.status === "incomplete")) {
			throw new Error("OpenAI Responses output item is incomplete")
		}
		// A minimal completion can omit output; otherwise its items must agree with streamed receipts.
		if (response.output !== undefined) {
			for (const [index, identity] of handledOutputIdentities) {
				const item = output[index]
				if (!item || openAiResponsesOutputIdentity(item) !== identity) {
					throw new Error("OpenAI Responses completed item did not match its final output")
				}
			}
		}
		for (const [index, item] of output.entries()) {
			if (handledOutputIdentities.has(index)) continue
			yield* this.emitOpenAiResponsesOutputItem(item, index, toolCalls, textDeltaParts)
		}
		if (toolCalls.size > 0) {
			throw new Error("OpenAI Responses completed before its streamed tool call was complete")
		}

		this.captureOpenAiResponsesState(response)
		if (!this.responsesEncryptedContent) {
			const summary = this.responsesSummary?.map((part) => part.text).join("\n") || reasoningSummary
			if (summary) yield { type: "reasoning", text: summary }
		}
		yield this.processOpenAiResponsesUsage(response.usage)
		// Codex can finish this response while requesting another model step.
		if (response.end_turn === false) {
			yield createApiStreamOutcome({ status: "completed", requiresContinuation: true })
		}
	}

	private async *emitOpenAiResponsesOutputItem(
		item: OpenAI.Responses.ResponseOutputItem,
		outputIndex: number,
		toolCalls: Map<number, OpenAiResponsesToolCallState>,
		textDeltaParts: Set<string>,
	): ApiStream {
		const active = toolCalls.get(outputIndex)
		if (
			active &&
			(item.type !== (active.type === "function" ? "function_call" : "custom_tool_call") ||
				!("call_id" in item) ||
				item.call_id !== active.id ||
				!("name" in item) ||
				item.name !== active.name)
		) {
			// The advertised identity owns the accumulated arguments and terminal receipt.
			throw new Error("OpenAI Responses streamed tool call changed identity")
		}
		if (item.type === "function_call") {
			if (!active) {
				yield { type: "tool_call", id: item.call_id, name: item.name, arguments: item.arguments }
				yield { type: "tool_call_end", id: item.call_id }
				return
			}
			const finalArguments = item.arguments
			if (active.functionArguments && !finalArguments.startsWith(active.functionArguments)) {
				throw new Error("OpenAI Responses function call stream did not match its final arguments")
			}
			const remainder = finalArguments.slice(active.functionArguments.length)
			if (remainder) yield { type: "tool_call_partial", index: outputIndex, arguments: remainder }
			yield { type: "tool_call_end", id: item.call_id }
			toolCalls.delete(outputIndex)
			return
		}

		if (item.type === "custom_tool_call") {
			if (!active || active.type !== "custom") {
				yield {
					type: "tool_call",
					id: item.call_id,
					name: item.name,
					arguments: normalizeOpenAiCustomToolInput(item.name, item.input),
				}
				yield { type: "tool_call_end", id: item.call_id }
				return
			}
			if (!item.input.startsWith(active.customInput)) {
				throw new Error("OpenAI Responses custom tool stream did not match its final input")
			}
			const remainder = item.input.slice(active.customInput.length)
			if (remainder) {
				yield {
					type: "tool_call_partial",
					index: outputIndex,
					arguments: encodeOpenAiCustomToolInputDelta(item.name, remainder),
				}
			}
			if (item.name === "apply_patch") yield { type: "tool_call_partial", index: outputIndex, arguments: '"}' }
			yield { type: "tool_call_end", id: item.call_id }
			toolCalls.delete(outputIndex)
			return
		}

		if (item.type === "reasoning") {
			this.captureOpenAiResponsesReasoningItem(item, outputIndex)
			return
		}

		if (item.type !== "message") return
		for (const [contentIndex, content] of item.content.entries()) {
			const key = `${outputIndex}:${contentIndex}`
			if (content.type === "output_text" && !textDeltaParts.has(key)) {
				textDeltaParts.add(key)
				yield { type: "text", text: content.text }
			} else if (content.type === "refusal" && !textDeltaParts.has(key)) {
				textDeltaParts.add(key)
				yield { type: "text", text: content.refusal }
			}
		}
	}

	private captureOpenAiResponsesState(response: Partial<OpenAI.Responses.Response>): void {
		this.responsesResponseId = response.id
		const reasoningItems = (response.output ?? []).flatMap((item, outputIndex) =>
			item.type === "reasoning" ? [{ item, outputIndex }] : [],
		)
		for (const { item, outputIndex } of reasoningItems) {
			if (typeof item.encrypted_content === "string" && item.encrypted_content) {
				this.responsesReasoningItems.set(outputIndex, {
					id: item.id,
					encrypted_content: item.encrypted_content,
					...(item.summary !== undefined ? { summary: [...item.summary] } : {}),
				})
			}
		}
		const firstEncryptedItem = this.getReasoningItems()[0]
		this.responsesEncryptedContent = firstEncryptedItem
			? { encrypted_content: firstEncryptedItem.encrypted_content, id: firstEncryptedItem.id }
			: undefined
		const responseSummary = reasoningItems.flatMap(({ item }) => item.summary ?? [])
		if (responseSummary.length > 0) this.responsesSummary = responseSummary
	}

	private captureOpenAiResponsesReasoningItem(
		item: OpenAI.Responses.ResponseReasoningItem,
		outputIndex: number,
	): void {
		if (typeof item.encrypted_content === "string" && item.encrypted_content) {
			this.responsesReasoningItems.set(outputIndex, {
				id: item.id,
				encrypted_content: item.encrypted_content,
				...(item.summary !== undefined ? { summary: [...item.summary] } : {}),
			})
			this.responsesEncryptedContent = { encrypted_content: item.encrypted_content, id: item.id }
		}
		if (item.summary?.length) this.responsesSummary = [...(this.responsesSummary ?? []), ...item.summary]
	}

	private processOpenAiResponsesUsage(usage: OpenAI.Responses.ResponseUsage | null | undefined): ApiStreamUsageChunk {
		return {
			type: "usage",
			inputTokens: usage?.input_tokens ?? 0,
			outputTokens: usage?.output_tokens ?? 0,
			cacheReadTokens: usage?.input_tokens_details?.cached_tokens || undefined,
			reasoningTokens: usage?.output_tokens_details?.reasoning_tokens || undefined,
		}
	}

	public getResponseId(): string | undefined {
		return this.responsesResponseId
	}

	public getEncryptedContent(): { encrypted_content: string; id?: string } | undefined {
		return this.responsesEncryptedContent
	}

	public getReasoningItems(): OpenAiResponsesReasoningItem[] {
		return [...this.responsesReasoningItems.entries()]
			.sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
			.map(([, item]) => ({
				...item,
				...(item.summary !== undefined ? { summary: [...item.summary] } : {}),
			}))
	}

	public getSummary(): OpenAI.Responses.ResponseReasoningItem["summary"] | undefined {
		return this.responsesSummary
	}

	/** Apply an ephemeral task token without mutating the saved provider profile. */
	private getRuntimeReasoning(
		fallback: { reasoning_effort: OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"] } | undefined,
	): { reasoning_effort: OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"] } | undefined {
		const value = this.options.taskReasoningCustomEffort
		if (!value || !taskReasoningCustomTokenPattern.test(value)) return fallback
		return { reasoning_effort: value as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"] }
	}

	protected processUsageMetrics(usage: any, _modelInfo?: ModelInfo): ApiStreamUsageChunk {
		return {
			type: "usage",
			inputTokens: usage?.prompt_tokens || 0,
			outputTokens: usage?.completion_tokens || 0,
			cacheWriteTokens: usage?.cache_creation_input_tokens || undefined,
			cacheReadTokens: usage?.cache_read_input_tokens || undefined,
		}
	}

	private *readReasoning(value: unknown): Generator<{ type: "reasoning"; text: string }> {
		if (!value || typeof value !== "object") return
		const record = value as Record<string, unknown>
		if (Array.isArray(record.reasoning_details) && record.reasoning_details.length > 0) {
			this.lastReasoningDetails = [...(this.lastReasoningDetails ?? []), ...record.reasoning_details]
		}
		const text =
			typeof record.reasoning_content === "string" && record.reasoning_content
				? record.reasoning_content
				: record.reasoning
		if (typeof text === "string" && text) yield { type: "reasoning", text }
	}

	override getModel() {
		const id = this.options.openAiModelId ?? ""
		const info: ModelInfo = applyModelToolPreferences(
			{ provider: "openai", id },
			resolveOpenAiCustomModelInfo(this.options.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
		)
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})
		return { id, info, ...params, toolIdentity: { provider: "openai", id } }
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
			const model = this.getModel()
			const modelInfo = model.info
			const effectiveReasoning = this.getRuntimeReasoning(model.reasoning)

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: model.id,
				messages: [{ role: "user", content: prompt }],
				...(effectiveReasoning && effectiveReasoning),
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			const response = await this.client.chat.completions.create(
				requestOptions,
				isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {},
			)

			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}

	private async *handleO3FamilyMessage(
		modelId: string,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const model = this.getModel()
		const modelInfo = model.info
		const effectiveReasoning = this.getRuntimeReasoning(model.reasoning)
		const methodIsAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
		const instructionMessages =
			metadata?.instructionFragments !== undefined
				? toOpenAiReasoningInstructionMessages(metadata.instructionFragments)
				: [{ role: "developer" as const, content: `Formatting re-enabled\n${systemPrompt}` }]

		if (this.options.openAiStreamingEnabled ?? true) {
			const isGrokXAI = this._isGrokXAI(this.options.openAiBaseUrl)

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				messages: [...instructionMessages, ...convertToOpenAiMessages(messages)],
				stream: true,
				...(isGrokXAI ? {} : { stream_options: { include_usage: true } }),
				...(effectiveReasoning && effectiveReasoning),
				temperature: undefined,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			const stream = await this.client.chat.completions.create(requestOptions, {
				...(methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				...(metadata?.signal ? { signal: metadata.signal } : {}),
			})

			yield* this.handleStreamResponse(stream)
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: [...instructionMessages, ...convertToOpenAiMessages(messages)],
				...(effectiveReasoning && effectiveReasoning),
				temperature: undefined,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			const response = await this.client.chat.completions.create(requestOptions, {
				...(methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				...(metadata?.signal ? { signal: metadata.signal } : {}),
			})

			const message = response.choices?.[0]?.message
			const finishReason = response.choices?.[0]?.finish_reason
			const outcome = createOpenAiChatCompletionOutcome(
				finishReason,
				true,
				Boolean(message?.content || message?.tool_calls?.length || hasOpenAiReasoningText(message)),
				Boolean(message?.tool_calls?.length) && finishReason !== "tool_calls",
			)
			if (outcome.status !== "completed") yield outcome

			yield* this.readReasoning(message)
			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
						yield { type: "tool_call_end", id: toolCall.id }
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}
			yield this.processUsageMetrics(response.usage)
			if (outcome.status === "completed") yield outcome
		}
	}

	private async *handleStreamResponse(stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>): ApiStream {
		const activeToolCallIds = new Set<string>()
		let finishReason: string | null | undefined
		let sawTerminalFinishReason = false
		let semanticOutputObserved = false
		let sawToolCallFragment = false

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			const chunkFinishReason = chunk.choices?.[0]?.finish_reason
			if (chunkFinishReason) {
				finishReason = chunkFinishReason
				sawTerminalFinishReason = true
			}

			if (delta) {
				const reasoningChunks = [...this.readReasoning(delta)]
				if (reasoningChunks.length > 0) semanticOutputObserved = true
				for (const reasoningChunk of reasoningChunks) yield reasoningChunk
				if (delta.content) {
					semanticOutputObserved = true
					yield {
						type: "text",
						text: delta.content,
					}
				}

				if (delta.tool_calls?.length) {
					semanticOutputObserved = true
					sawToolCallFragment = true
				}

				yield* this.processToolCalls(delta, chunkFinishReason, activeToolCallIds)
			}

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
			}
		}

		yield createOpenAiChatCompletionOutcome(
			finishReason,
			sawTerminalFinishReason,
			semanticOutputObserved,
			sawToolCallFragment && finishReason !== "tool_calls",
		)
	}

	/**
	 * Helper generator to process tool calls from a stream chunk.
	 * Tracks active tool call IDs and yields tool_call_partial and tool_call_end events.
	 * @param delta - The delta object from the stream chunk
	 * @param finishReason - The finish_reason from the stream chunk
	 * @param activeToolCallIds - Set to track active tool call IDs (mutated in place)
	 */
	private *processToolCalls(
		delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta | undefined,
		finishReason: string | null | undefined,
		activeToolCallIds: Set<string>,
	): Generator<
		| { type: "tool_call_partial"; index: number; id?: string; name?: string; arguments?: string }
		| { type: "tool_call_end"; id: string }
	> {
		if (delta?.tool_calls) {
			for (const toolCall of delta.tool_calls) {
				if (toolCall.id) {
					activeToolCallIds.add(toolCall.id)
				}
				yield {
					type: "tool_call_partial",
					index: toolCall.index,
					id: toolCall.id,
					name: toolCall.function?.name,
					arguments: toolCall.function?.arguments,
				}
			}
		}

		// Emit tool_call_end events when finish_reason is "tool_calls"
		// This ensures tool calls are finalized even if the stream doesn't properly close
		if (finishReason === "tool_calls" && activeToolCallIds.size > 0) {
			for (const id of activeToolCallIds) {
				yield { type: "tool_call_end", id }
			}
			activeToolCallIds.clear()
		}
	}

	protected _getUrlHost(baseUrl?: string): string {
		try {
			return new URL(baseUrl ?? "").host
		} catch (error) {
			return ""
		}
	}

	private _isGrokXAI(baseUrl?: string): boolean {
		const urlHost = this._getUrlHost(baseUrl)
		return urlHost.includes("x.ai")
	}

	protected _isAzureAiInference(baseUrl?: string): boolean {
		const urlHost = this._getUrlHost(baseUrl)
		return urlHost.endsWith(".services.ai.azure.com")
	}

	/**
	 * Adds max_completion_tokens to the request body if needed based on provider configuration
	 * Note: max_tokens is deprecated in favor of max_completion_tokens as per OpenAI documentation
	 * O3 family models handle max_tokens separately in handleO3FamilyMessage
	 */
	protected addMaxTokensIfNeeded(
		requestOptions:
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		modelInfo: ModelInfo,
	): void {
		// Only add max_completion_tokens if includeMaxTokens is true
		if (this.options.includeMaxTokens === true) {
			// Use user-configured modelMaxTokens if available, otherwise fall back to model's default maxTokens
			// Using max_completion_tokens as max_tokens is deprecated
			requestOptions.max_completion_tokens = this.options.modelMaxTokens || modelInfo.maxTokens
		}
	}
}

export async function getOpenAiModels(baseUrl?: string, apiKey?: string, openAiHeaders?: Record<string, string>) {
	try {
		if (!baseUrl) {
			return []
		}

		// Trim whitespace from baseUrl to handle cases where users accidentally include spaces
		const trimmedBaseUrl = baseUrl.trim()

		if (!URL.canParse(trimmedBaseUrl)) {
			return []
		}

		const config: Record<string, any> = {}
		const headers: Record<string, string> = {
			...DEFAULT_HEADERS,
			...(openAiHeaders || {}),
		}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		if (Object.keys(headers).length > 0) {
			config["headers"] = headers
		}

		const response = await axios.get(`${trimmedBaseUrl}/models`, config)
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
