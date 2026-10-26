import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"
import type { ResponseCreateParamsBase } from "openai/resources/responses/responses"
import axios from "axios"
import { isDeepStrictEqual } from "node:util"

import {
	type ModelInfo,
	type AssistantMessageMetadata,
	normalizeAssistantMessageMetadata,
	taskReasoningCustomTokenPattern,
	azureOpenAiDefaultApiVersion,
	openAiModelInfoSaneDefaults,
	resolveOpenAiCustomModelInfo,
	OPENAI_AZURE_AI_INFERENCE_PATH,
	resolveModelParameterApplicability,
	resolveOptionalOutputTokenLimit,
	isCuratedProvider,
	usesOpenAiReasoningFamilyChat,
	usesOpenAiResponsesApi,
} from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { TagMatcher } from "../../utils/tag-matcher"
import type { AgentRetryCategory } from "../../core/agent/AgentRetryPolicy"
import { readRetryAfterMs } from "../../core/agent/RequestPacing"

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
	isApiStreamSemanticChunk,
} from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"

import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import type {
	ApiInstructionFragment,
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	ApiHandlerSingleCompletionMetadata,
} from "../index"
import { awaitSingleCompletion, throwIfSingleCompletionAborted } from "../transform/single-completion"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { handleOpenAIError } from "./utils/error-handler"
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

function providerTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
		? value
		: undefined
}

function providerRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function hasOpenAiResponsesUsage(usage: unknown): boolean {
	const source = providerRecord(usage)
	return (
		providerTokenCount(source?.input_tokens) !== undefined &&
		providerTokenCount(source?.output_tokens) !== undefined
	)
}

/** Normalize native SSE failures before the generic provider wrapper sees them. */
function createOpenAiResponsesError(error: unknown, fallbackMessage = "OpenAI Responses request failed") {
	const envelope = providerRecord(error)
	const source = providerRecord(envelope?.error) ?? envelope
	const code = typeof source?.code === "string" ? source.code : undefined
	const message = typeof source?.message === "string" && source.message.trim() ? source.message : fallbackMessage
	const rateLimited = code === "rate_limit_exceeded" || code === "slow_down"
	const contextExceeded = code === "context_length_exceeded"
	const permanent =
		code !== undefined &&
		[
			"insufficient_quota",
			"credit_balance_exhausted",
			"organization_spend_limit_exceeded",
			"project_spend_limit_exceeded",
			"usage_not_included",
			"cyber_policy",
			"bio_policy",
			"misalignment_policy_violation",
			"invalid_prompt",
			"invalid_request_error",
			"flex_unavailable",
		].includes(code)
	let retryAfterMs = readRetryAfterMs(source?.headers)
	// Only a native rate-limit code authorizes plaintext delay advice.
	if (retryAfterMs === undefined && rateLimited) {
		const match = message.match(/try again in\s*(\d+(?:\.\d+)?)\s*(ms|s(?:econds?)?)/i)
		if (match) {
			const delay = Number(match[1]) * (match[2].toLowerCase() === "ms" ? 1 : 1_000)
			if (Number.isFinite(delay) && delay >= 0 && delay <= Number.MAX_SAFE_INTEGER) {
				retryAfterMs = Math.ceil(delay)
			}
		}
	}
	const retryCategory: AgentRetryCategory = contextExceeded ? "context" : rateLimited ? "rate-limit" : "transport"
	return Object.assign(new Error(message), {
		...(code !== undefined ? { code } : {}),
		retryCategory,
		// Context failures retain Alpha's bounded compaction recovery.
		...(!contextExceeded
			? { retryable: !permanent && (code !== "server_is_overloaded" || retryAfterMs !== undefined) }
			: {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	})
}

function createOpenAiResponsesIncompleteError(reason: string) {
	return Object.assign(new Error(`OpenAI Responses request is incomplete: ${reason}`), {
		code: "response_incomplete",
		retryable: false,
	})
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

interface OpenAiResponsesMessageTextState {
	parts: Map<number, { type: "output_text" | "refusal"; text: string }>
	lastContentIndex: number
}

interface OpenAiResponsesReasoningTextState {
	parts: Map<number, string>
	lastSummaryIndex: number
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
	// Message IDs are optional in the protocol and may arrive only at completion.
	// Their stable index owns the boundary; the metadata map validates known IDs.
	if (item.type === "message") return JSON.stringify([item.type])
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
	protected readonly providerName: string = "OpenAI"
	protected readonly providerId: string = "openai"
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
			...(!this.shouldUseResponsesApi(modelId) || this.reportsResponsesLifecycle() ? { lifecycle: true } : {}),
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
				maxRetries: 0,
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
				maxRetries: 0,
			})
		} else {
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				timeout,
				// Shared retry policy owns attempt budgets and server delay advice.
				maxRetries: 0,
			})
		}
	}

	protected shouldUseResponsesApi(modelId = this.options.openAiModelId ?? ""): boolean {
		return usesOpenAiResponsesApi(modelId, this.options)
	}

	/** Explicit opt-in preserves the established compatible-provider stream contract. */
	protected reportsResponsesLifecycle(): boolean {
		return false
	}

	protected usesResponsesForSingleCompletion(): boolean {
		return false
	}

	protected supportsResponsesReasoningSummary(): boolean {
		return this.options.enableResponsesReasoningSummary !== false
	}

	protected convertMessages(messages: Anthropic.Messages.MessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
		return convertToOpenAiMessages(messages)
	}

	protected customizeChatRequest<T extends OpenAI.Chat.Completions.ChatCompletionCreateParams>(request: T): T {
		return request
	}

	protected customizeResponsesRequest<T extends ResponseCreateParamsBase>(request: T): T {
		return request
	}

	protected validateChatSingleCompletion(_response: OpenAI.Chat.Completions.ChatCompletion): void {}

	protected onChatFinishReason(_finishReason: string | null | undefined): void {}

	protected preserveResponsesReasoningIds(): boolean {
		return false
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.lastReasoningDetails = undefined
		const control =
			metadata && (metadata.signal || metadata.deadline) ? createLinkedAbortController(metadata) : undefined
		const reportsLifecycle = this.reportsResponsesLifecycle()
		let terminalOutcomeObserved = false
		let semanticOutputObserved = false
		try {
			control?.signal.throwIfAborted()
			const stream = this.createMessageInternal(
				systemPrompt,
				messages,
				control && metadata ? { ...metadata, signal: control.signal } : metadata,
			)
			for await (const chunk of control ? iterateApiStreamWithAbort(stream, control.signal) : stream) {
				terminalOutcomeObserved ||= chunk.type === "outcome"
				semanticOutputObserved ||= isApiStreamSemanticChunk(chunk)
				yield chunk
			}
			control?.signal.throwIfAborted()
			if (reportsLifecycle && !terminalOutcomeObserved) {
				yield createApiStreamOutcome({ status: "completed", semanticOutputObserved })
			}
		} catch (error) {
			const cancelled = isApiStreamAbortError(error, control?.signal ?? metadata?.signal)
			if (reportsLifecycle && !terminalOutcomeObserved) {
				yield createApiStreamOutcome({
					status: cancelled ? "cancelled" : "failed",
					semanticOutputObserved,
				})
			}
			if (cancelled) throw error
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
		const { info: modelInfo, reasoning, temperature } = this.getModel()
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

		if (usesOpenAiReasoningFamilyChat(modelId)) {
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
				const historyMessages = this.convertMessages(messages)
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
				...(temperature !== undefined ? { temperature } : {}),
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

			const stream = await this.client.chat.completions.create(this.customizeChatRequest(requestOptions), {
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

			try {
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
					this.onChatFinishReason(chunkFinishReason)

					if (delta.tool_calls?.length) {
						semanticOutputObserved = true
						sawToolCallFragment = true
					}

					yield* this.processToolCalls(delta, chunkFinishReason, activeToolCallIds)

					if (chunk.usage) {
						lastUsage = chunk.usage
					}
				}
			} catch (error) {
				if (lastUsage) yield this.processUsageMetrics(lastUsage, modelInfo)
				throw error
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
				...(temperature !== undefined ? { temperature } : {}),
				messages: deepseekReasoner
					? convertToR1Format([...toR1InstructionMessages(systemPrompt, instructionFragments), ...messages])
					: [
							...(instructionFragments !== undefined
								? toOpenAiInstructionMessages(instructionFragments, "system")
								: [systemMessage]),
							...this.convertMessages(messages),
						],
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
				...(effectiveReasoning && effectiveReasoning),
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			const response = await this.client.chat.completions.create(this.customizeChatRequest(requestOptions), {
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
			this.onChatFinishReason(finishReason)

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
		const commonOptions = this.buildResponsesRequest(
			modelId,
			systemPrompt,
			messages,
			modelInfo,
			effectiveReasoning,
			tools,
			freeformApplyPatch,
			metadata,
		)

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

	private buildResponsesRequest(
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
	): ResponseCreateParamsBase {
		const summaryEnabled = this.supportsResponsesReasoningSummary()
		const store = metadata?.store ?? false
		const reasoning = {
			...(effectiveReasoning?.reasoning_effort !== undefined
				? { effort: effectiveReasoning.reasoning_effort }
				: {}),
			...(summaryEnabled ? { summary: "auto" as const } : {}),
		}
		const applicability = resolveModelParameterApplicability({
			provider: this.providerId,
			modelId,
			model: modelInfo,
			settings: this.options,
		})
		const { supportsVerbosity, supportsTemperature } = applicability
		const maxOutputTokens = resolveOptionalOutputTokenLimit({
			model: modelInfo,
			settings: this.options,
			route: applicability.route,
			enforceModelMaximum: isCuratedProvider(this.providerId),
		})
		const temperature = this.getModel().temperature
		return this.customizeResponsesRequest({
			model: modelId,
			input: buildOpenAiResponsesInput(
				systemPrompt,
				metadata?.instructionFragments,
				messages,
				store,
				freeformApplyPatch,
				{ preserveReasoningIds: this.preserveResponsesReasoningIds() },
			),
			...(tools !== undefined ? { tools } : {}),
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			include: ["reasoning.encrypted_content" as const],
			...(metadata?.tool_choice !== undefined
				? { tool_choice: toOpenAiResponsesToolChoice(metadata.tool_choice, freeformApplyPatch) }
				: {}),
			store,
			...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
			...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
			...(supportsTemperature && temperature !== undefined ? { temperature } : {}),
			...(supportsVerbosity && this.options.verbosity !== undefined
				? { text: { verbosity: this.options.verbosity } }
				: {}),
		})
	}

	private async *handleOpenAiResponsesStream(stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>): ApiStream {
		const toolCalls = new Map<number, OpenAiResponsesToolCallState>()
		const messageMetadata = new Map<number, AssistantMessageMetadata>()
		const handledOutputIdentities = new Map<number, string>()
		const messageText = new Map<number, OpenAiResponsesMessageTextState>()
		const reasoningText = new Map<number, OpenAiResponsesReasoningTextState>()
		let receivedTerminalEvent = false
		let incompleteOutputItemObserved = false

		for await (const event of stream) {
			switch (event.type) {
				case "response.output_item.added": {
					const item = event.item
					if (item.type === "message") {
						yield {
							type: "message_metadata",
							...this.captureOpenAiResponsesMessageMetadata(item, event.output_index, messageMetadata),
						}
					} else if (item.type === "function_call") {
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
				case "response.output_text.delta":
				case "response.refusal.delta": {
					const metadata = this.captureOpenAiResponsesMessageMetadata(
						{ id: event.item_id },
						event.output_index,
						messageMetadata,
					)
					const text = this.reconcileOpenAiResponsesTextPart(
						event.output_index,
						event.content_index,
						event.type === "response.output_text.delta" ? "output_text" : "refusal",
						event.delta,
						messageText,
					)
					if (text !== undefined) yield { type: "text", text, ...metadata }
					break
				}
				case "response.reasoning_summary_text.delta":
				case "response.reasoning_summary_text.done": {
					const text = this.reconcileOpenAiResponsesReasoningSummary(
						event.output_index,
						event.summary_index,
						event.type === "response.reasoning_summary_text.delta" ? event.delta : event.text,
						reasoningText,
						event.type === "response.reasoning_summary_text.done",
					)
					if (text !== undefined) yield { type: "reasoning", text, outputIndex: event.output_index }
					break
				}
				case "response.output_item.done": {
					if (!Number.isSafeInteger(event.output_index) || event.output_index < 0) {
						throw new Error("OpenAI Responses output item has an invalid index")
					}
					const isToolCall = event.item.type === "function_call" || event.item.type === "custom_tool_call"
					if ("status" in event.item && event.item.status === "incomplete") {
						// Wait for the terminal envelope so billed usage and interruption state survive.
						incompleteOutputItemObserved = true
						if (isToolCall) break
					}
					// Output indexes remain stable through completion even when an item has no provider ID.
					const identity = openAiResponsesOutputIdentity(event.item)
					const handled = handledOutputIdentities.get(event.output_index)
					if (handled !== undefined) {
						if (handled !== identity) throw new Error("OpenAI Responses output item changed identity")
						if (event.item.type !== "message") break
					}
					handledOutputIdentities.set(event.output_index, identity)
					yield* this.emitOpenAiResponsesOutputItem(
						event.item,
						event.output_index,
						toolCalls,
						messageText,
						messageMetadata,
						reasoningText,
					)
					break
				}
				case "response.incomplete":
				case "response.completed": {
					receivedTerminalEvent = true
					yield* this.finishOpenAiResponsesResult(
						event.response,
						toolCalls,
						handledOutputIdentities,
						messageText,
						messageMetadata,
						reasoningText,
						event.type === "response.incomplete" ? "incomplete" : "completed",
						incompleteOutputItemObserved,
					)
					break
				}
				case "response.failed": {
					yield* this.rejectOpenAiResponsesResult(
						event.response,
						createOpenAiResponsesError(event.response.error),
						"failed",
					)
					return
				}
				case "error":
					throw createOpenAiResponsesError(event, "OpenAI Responses stream error")
				default:
					break
			}
			if (receivedTerminalEvent) return
		}

		if (!receivedTerminalEvent) throw new Error("OpenAI Responses stream ended without a terminal event")
	}

	private async *handleOpenAiResponsesResult(response: OpenAI.Responses.Response): ApiStream {
		const toolCalls = new Map<number, OpenAiResponsesToolCallState>()
		const messageText = new Map<number, OpenAiResponsesMessageTextState>()
		yield* this.finishOpenAiResponsesResult(response, toolCalls, new Map(), messageText, new Map(), new Map())
	}

	private async *finishOpenAiResponsesResult(
		response: Partial<OpenAI.Responses.Response> & { end_turn?: boolean },
		toolCalls: Map<number, OpenAiResponsesToolCallState>,
		handledOutputIdentities: Map<number, string>,
		messageText: Map<number, OpenAiResponsesMessageTextState>,
		messageMetadata: Map<number, AssistantMessageMetadata>,
		reasoningText: Map<number, OpenAiResponsesReasoningTextState>,
		terminalEvent?: "completed" | "incomplete",
		incompleteOutputItemObserved = false,
	): ApiStream {
		const incomplete = terminalEvent === "incomplete" || (!terminalEvent && response.status === "incomplete")
		// The pinned SDK predates Codex's interrupted terminal reason.
		const reportedReason = providerRecord(response.incomplete_details)?.reason
		const incompleteReason = typeof reportedReason === "string" ? reportedReason : "unknown reason"
		const interrupted = incomplete && incompleteReason === "interrupted"
		if (incomplete && !interrupted) {
			yield* this.rejectOpenAiResponsesResult(
				response,
				createOpenAiResponsesIncompleteError(incompleteReason),
				"incomplete",
			)
			return
		}
		if (!terminalEvent && response.status === "failed") {
			yield* this.rejectOpenAiResponsesResult(response, createOpenAiResponsesError(response.error), "failed")
			return
		}
		if (
			!interrupted &&
			response.status !== "completed" &&
			(terminalEvent !== "completed" || response.status !== undefined)
		) {
			throw new Error(`OpenAI Responses request ended with status ${response.status}`)
		}
		if (interrupted) {
			if (typeof response.id === "string" && response.id) this.responsesResponseId = response.id
			if (hasOpenAiResponsesUsage(response.usage)) yield this.processOpenAiResponsesUsage(response.usage)
		}
		if (typeof response.id !== "string" || !response.id) {
			throw new Error("OpenAI Responses completed without a response id")
		}
		if (response.output !== undefined && !Array.isArray(response.output)) {
			throw new Error("OpenAI Responses completed with invalid output")
		}
		if (!terminalEvent && !interrupted && response.output === undefined) {
			throw new Error("OpenAI Responses result did not include output")
		}
		const output = response.output ?? []
		if (
			!interrupted &&
			(incompleteOutputItemObserved || output.some((item) => "status" in item && item.status === "incomplete"))
		) {
			yield* this.rejectOpenAiResponsesResult(
				response,
				Object.assign(new Error("OpenAI Responses output item is incomplete"), {
					code: "response_incomplete",
					retryable: false,
				}),
				"incomplete",
			)
			return
		}
		// A minimal completion can omit output; otherwise its items must agree with streamed receipts.
		if (response.output !== undefined) {
			for (const [index, identity] of handledOutputIdentities) {
				const item = output[index]
				if (!item && interrupted) continue
				if (!item || openAiResponsesOutputIdentity(item) !== identity) {
					throw new Error("OpenAI Responses completed item did not match its final output")
				}
			}
			for (const index of messageText.keys()) {
				if (!output[index] && interrupted) continue
				if (output[index]?.type !== "message") {
					throw new Error("OpenAI Responses streamed message did not match its final output")
				}
			}
		}
		for (const [index, item] of output.entries()) {
			// An interrupted terminal is not a completion receipt for an unfinished tool.
			if (
				interrupted &&
				(item.type === "function_call" || item.type === "custom_tool_call") &&
				!handledOutputIdentities.has(index) &&
				(!("status" in item) || item.status !== "completed")
			) {
				continue
			}
			if (handledOutputIdentities.has(index) && item.type !== "message") {
				if (item.type !== "reasoning" || !item.encrypted_content) continue
				const streamed = this.responsesReasoningItems.get(index)
				if (
					streamed?.encrypted_content === item.encrypted_content &&
					streamed.id === item.id &&
					isDeepStrictEqual(streamed.summary, item.summary)
				) {
					continue
				}
			}
			yield* this.emitOpenAiResponsesOutputItem(
				item,
				index,
				toolCalls,
				messageText,
				messageMetadata,
				reasoningText,
			)
		}
		if (toolCalls.size > 0 && !interrupted) {
			throw new Error("OpenAI Responses completed before its streamed tool call was complete")
		}

		this.captureOpenAiResponsesState(response)
		if (!interrupted) yield this.processOpenAiResponsesUsage(response.usage)
		// Codex can finish this response while requesting another model step.
		if (interrupted || response.end_turn === false) {
			yield createApiStreamOutcome({ status: "completed", requiresContinuation: true })
		}
	}

	private async *rejectOpenAiResponsesResult(
		response: Partial<OpenAI.Responses.Response>,
		error: Error & { retryable?: boolean },
		status: "failed" | "incomplete",
	): ApiStream {
		if (typeof response.id === "string" && response.id) this.responsesResponseId = response.id
		if (hasOpenAiResponsesUsage(response.usage)) yield this.processOpenAiResponsesUsage(response.usage)
		// Failed requests retain the throw-only boundary consumed by Task's retry/compaction policy.
		if (status === "incomplete") {
			yield createApiStreamOutcome({ status, terminal: true, reason: error.message, retryable: error.retryable })
		}
		throw error
	}

	private async *emitOpenAiResponsesOutputItem(
		item: OpenAI.Responses.ResponseOutputItem,
		outputIndex: number,
		toolCalls: Map<number, OpenAiResponsesToolCallState>,
		messageText: Map<number, OpenAiResponsesMessageTextState>,
		messageMetadata: Map<number, AssistantMessageMetadata>,
		reasoningText: Map<number, OpenAiResponsesReasoningTextState>,
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
				yield {
					type: "tool_call",
					id: item.call_id,
					name: item.name,
					arguments: item.arguments,
					outputIndex,
				}
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
					outputIndex,
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
			for (const [summaryIndex, part] of (item.summary ?? []).entries()) {
				const text = this.reconcileOpenAiResponsesReasoningSummary(
					outputIndex,
					summaryIndex,
					part.text,
					reasoningText,
					true,
				)
				if (text !== undefined) yield { type: "reasoning", text, outputIndex }
			}
			this.captureOpenAiResponsesReasoningItem(item, outputIndex)
			if (typeof item.encrypted_content === "string" && item.encrypted_content) {
				yield {
					type: "reasoning",
					text: "",
					encryptedContent: item.encrypted_content,
					id: item.id,
					...(item.summary !== undefined ? { summary: structuredClone(item.summary) } : {}),
					outputIndex,
				}
			}
			return
		}

		if (item.type !== "message") return
		const metadata = this.captureOpenAiResponsesMessageMetadata(item, outputIndex, messageMetadata)
		const previous = messageText.get(outputIndex)
		for (const [contentIndex, part] of previous?.parts ?? []) {
			if (item.content[contentIndex]?.type !== part.type) {
				throw new Error("OpenAI Responses streamed text part did not match its final content")
			}
		}
		// Some providers attach phase only when the item or response completes.
		// Update prior deltas without emitting the same visible text a second time.
		yield { type: "message_metadata", ...metadata }
		if (item.content.length === 0 && !previous) {
			messageText.set(outputIndex, { parts: new Map(), lastContentIndex: -1 })
			yield { type: "text", text: "", ...metadata }
		}
		for (const [contentIndex, content] of item.content.entries()) {
			const text = this.reconcileOpenAiResponsesTextPart(
				outputIndex,
				contentIndex,
				content.type,
				content.type === "output_text" ? content.text : content.refusal,
				messageText,
				true,
			)
			if (text !== undefined) yield { type: "text", text, ...metadata }
		}
	}

	private reconcileOpenAiResponsesReasoningSummary(
		outputIndex: number,
		summaryIndex: number,
		text: string,
		items: Map<number, OpenAiResponsesReasoningTextState>,
		complete = false,
	): string | undefined {
		if (
			!Number.isSafeInteger(outputIndex) ||
			outputIndex < 0 ||
			!Number.isSafeInteger(summaryIndex) ||
			summaryIndex < 0
		) {
			throw new Error("OpenAI Responses reasoning summary has an invalid index")
		}
		if (typeof text !== "string") throw new Error("OpenAI Responses reasoning summary has invalid text")
		const item = items.get(outputIndex) ?? { parts: new Map<number, string>(), lastSummaryIndex: -1 }
		const previous = item.parts.get(summaryIndex)
		if (complete && previous !== undefined && !text.startsWith(previous)) {
			throw new Error("OpenAI Responses reasoning summary did not match its streamed text")
		}
		const remainder = complete ? text.slice(previous?.length ?? 0) : text
		if (remainder && summaryIndex < item.lastSummaryIndex) {
			throw new Error("OpenAI Responses reasoning summary changed its emitted content order")
		}
		// Visible summaries stream independently of the sealed encrypted item. Preserve
		// the same output index and reconcile final receipts without duplicating text.
		// Codex 970111f6cb62cc02fe36a82ea7d71b37a2889c97, codex-api/src/sse/responses.rs (2026-10-26).
		const separator = remainder && summaryIndex > item.lastSummaryIndex && item.lastSummaryIndex >= 0 ? "\n" : ""
		items.set(outputIndex, item)
		item.parts.set(summaryIndex, complete ? text : (previous ?? "") + text)
		if (remainder) item.lastSummaryIndex = summaryIndex
		return remainder ? separator + remainder : undefined
	}

	private reconcileOpenAiResponsesTextPart(
		outputIndex: number,
		contentIndex: number,
		type: "output_text" | "refusal",
		text: string,
		messages: Map<number, OpenAiResponsesMessageTextState>,
		complete = false,
	): string | undefined {
		if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) {
			throw new Error("OpenAI Responses text part has an invalid index")
		}
		if (typeof text !== "string") throw new Error("OpenAI Responses text part has invalid text")
		const message: OpenAiResponsesMessageTextState = messages.get(outputIndex) ?? {
			parts: new Map(),
			lastContentIndex: -1,
		}
		const previous = message.parts.get(contentIndex)
		if (previous && (previous.type !== type || (complete && !text.startsWith(previous.text)))) {
			throw new Error("OpenAI Responses streamed text part did not match its final content")
		}
		const remainder = complete ? text.slice(previous?.text.length ?? 0) : text
		// Text chunks append to one source message. An earlier part cannot be
		// extended after a later part without corrupting its canonical order.
		if (remainder && contentIndex < message.lastContentIndex) {
			throw new Error("OpenAI Responses text part changed its emitted content order")
		}
		messages.set(outputIndex, message)
		message.parts.set(contentIndex, { type, text: complete ? text : (previous?.text ?? "") + text })
		if (remainder) message.lastContentIndex = contentIndex
		return remainder || previous === undefined ? remainder : undefined
	}

	private captureOpenAiResponsesMessageMetadata(
		item: unknown,
		outputIndex: number,
		messages: Map<number, AssistantMessageMetadata>,
	): AssistantMessageMetadata {
		if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
			throw new Error("OpenAI Responses message has an invalid index")
		}
		const previous = messages.get(outputIndex)
		const incoming = normalizeAssistantMessageMetadata(item)
		if (previous?.id !== undefined && incoming.id !== undefined && previous.id !== incoming.id) {
			throw new Error("OpenAI Responses streamed message changed identity")
		}
		const metadata = { ...previous, ...incoming, outputIndex }
		messages.set(outputIndex, metadata)
		return metadata
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

	protected processOpenAiResponsesUsage(usage: unknown): ApiStreamUsageChunk {
		const source = providerRecord(usage)
		return {
			type: "usage",
			inputTokens: providerTokenCount(source?.input_tokens) ?? 0,
			outputTokens: providerTokenCount(source?.output_tokens) ?? 0,
			cacheWriteTokens: providerTokenCount(providerRecord(source?.input_tokens_details)?.cache_write_tokens),
			cacheReadTokens: providerTokenCount(providerRecord(source?.input_tokens_details)?.cached_tokens),
			reasoningTokens: providerTokenCount(providerRecord(source?.output_tokens_details)?.reasoning_tokens),
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

	protected processUsageMetrics(usage: unknown, _modelInfo?: ModelInfo): ApiStreamUsageChunk {
		const source = providerRecord(usage)
		return {
			type: "usage",
			inputTokens: providerTokenCount(source?.prompt_tokens) ?? 0,
			outputTokens: providerTokenCount(source?.completion_tokens) ?? 0,
			cacheWriteTokens: providerTokenCount(source?.cache_creation_input_tokens),
			// A valid legacy counter, including zero, takes precedence on compatible endpoints.
			cacheReadTokens:
				providerTokenCount(source?.cache_read_input_tokens) ??
				providerTokenCount(providerRecord(source?.prompt_tokens_details)?.cached_tokens),
			// Reasoning is already included in completion_tokens; report it as a subset only.
			reasoningTokens: providerTokenCount(providerRecord(source?.completion_tokens_details)?.reasoning_tokens),
		}
	}

	protected *readReasoning(value: unknown): Generator<{ type: "reasoning"; text: string }> {
		if (!value || typeof value !== "object") return
		const record = value as Record<string, unknown>
		if (Array.isArray(record.reasoning_details)) this.captureReasoningDetails(record.reasoning_details)
		const text =
			typeof record.reasoning_content === "string" && record.reasoning_content
				? record.reasoning_content
				: record.reasoning
		if (typeof text === "string" && text) yield { type: "reasoning", text }
	}

	/** Compatible endpoints retain their historical accumulation unless a route defines delta semantics. */
	protected captureReasoningDetails(details: unknown[]): void {
		if (details.length > 0) this.lastReasoningDetails = [...(this.lastReasoningDetails ?? []), ...details]
	}

	override getModel() {
		const id = this.options.openAiModelId ?? ""
		const info: ModelInfo = applyModelToolPreferences(
			{ provider: this.providerId, id },
			resolveOpenAiCustomModelInfo(this.options.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
		)
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature:
				id.includes("deepseek-reasoner") || this.options.openAiR1FormatEnabled
					? DEEP_SEEK_DEFAULT_TEMPERATURE
					: 0,
		})
		const applicability = resolveModelParameterApplicability({
			provider: this.providerId,
			modelId: id,
			model: info,
			settings: this.options,
		})
		return {
			id,
			info,
			...params,
			temperature:
				applicability.fixedTemperature ?? (applicability.supportsTemperature ? params.temperature : undefined),
			verbosity: applicability.supportsVerbosity ? params.verbosity : undefined,
			toolIdentity: { provider: this.providerId, id },
		}
	}

	async completePrompt(prompt: string, metadata?: ApiHandlerSingleCompletionMetadata): Promise<string> {
		throwIfSingleCompletionAborted(metadata)
		try {
			const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
			const model = this.getModel()
			const modelInfo = model.info
			const effectiveReasoning = this.getRuntimeReasoning(model.reasoning)
			if (this.usesResponsesForSingleCompletion()) {
				const response = await awaitSingleCompletion(
					this.client.responses.create(
						{
							...this.buildResponsesRequest(
								model.id,
								"",
								[{ role: "user", content: prompt }],
								modelInfo,
								effectiveReasoning,
								undefined,
								false,
							),
							stream: false,
						},
						{ ...(metadata?.signal ? { signal: metadata.signal } : {}) },
					),
					metadata,
				)
				throwIfSingleCompletionAborted(metadata)
				return this.readResponsesSingleCompletion(response)
			}
			const applicability = resolveModelParameterApplicability({
				provider: this.providerId,
				modelId: model.id,
				model: modelInfo,
				settings: this.options,
				requestKind: "single-completion",
			})

			const temperature =
				applicability.fixedTemperature ?? (applicability.supportsTemperature ? model.temperature : undefined)
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: model.id,
				messages: [{ role: "user", content: prompt }],
				...(temperature !== undefined ? { temperature } : {}),
				...(effectiveReasoning && effectiveReasoning),
				...(applicability.supportsVerbosity && this.options.verbosity !== undefined
					? { verbosity: this.options.verbosity }
					: {}),
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			const response = await awaitSingleCompletion(
				this.client.chat.completions.create(this.customizeChatRequest(requestOptions), {
					...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
					...(metadata?.signal ? { signal: metadata.signal } : {}),
				}),
				metadata,
			)

			this.validateChatSingleCompletion(response)
			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			throwIfSingleCompletionAborted(metadata)
			throw handleOpenAIError(error, this.providerName)
		}
	}

	/** Auxiliary requests never alter the retained state of a concurrent task stream. */
	private readResponsesSingleCompletion(response: OpenAI.Responses.Response & { end_turn?: boolean }): string {
		if (response.status === "failed") throw createOpenAiResponsesError(response.error)
		if (response.status === "incomplete") {
			const reason = providerRecord(response.incomplete_details)?.reason
			throw createOpenAiResponsesIncompleteError(typeof reason === "string" ? reason : "unknown reason")
		}
		if (response.status !== "completed" || response.end_turn === false) {
			throw Object.assign(new Error("Auxiliary Responses request did not finish with a final text answer"), {
				retryable: false,
			})
		}
		if (!response.id || !Array.isArray(response.output)) {
			throw new Error("Auxiliary Responses request completed with an invalid response envelope")
		}
		let text = ""
		for (const item of response.output) {
			if (
				("status" in item && item.status === "incomplete") ||
				item.type === "function_call" ||
				item.type === "custom_tool_call"
			) {
				throw new Error("Auxiliary Responses request did not finish with a final text answer")
			}
			if (item.type === "message") {
				for (const part of item.content) text += part.type === "output_text" ? part.text : part.refusal
			}
		}
		if (!text) throw new Error("Auxiliary Responses request completed without text")
		return text
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
				messages: [...instructionMessages, ...this.convertMessages(messages)],
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

			const stream = await this.client.chat.completions.create(this.customizeChatRequest(requestOptions), {
				...(methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				...(metadata?.signal ? { signal: metadata.signal } : {}),
			})

			yield* this.handleStreamResponse(stream)
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: [...instructionMessages, ...this.convertMessages(messages)],
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

			const response = await this.client.chat.completions.create(this.customizeChatRequest(requestOptions), {
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
			this.onChatFinishReason(finishReason)
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
		let lastUsage: OpenAI.CompletionUsage | undefined
		let finishReason: string | null | undefined
		let sawTerminalFinishReason = false
		let semanticOutputObserved = false
		let sawToolCallFragment = false

		try {
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
					this.onChatFinishReason(chunkFinishReason)
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
					lastUsage = chunk.usage
				}
			}
		} catch (error) {
			if (lastUsage) yield this.processUsageMetrics(lastUsage)
			throw error
		}
		if (lastUsage) yield this.processUsageMetrics(lastUsage)

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
		const maxOutputTokens = resolveOptionalOutputTokenLimit({
			model: modelInfo,
			settings: this.options,
			enforceModelMaximum: isCuratedProvider(this.providerId),
		})
		if (maxOutputTokens !== undefined) {
			requestOptions.max_completion_tokens = maxOutputTokens
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
