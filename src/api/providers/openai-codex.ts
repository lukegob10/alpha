import * as os from "os"
import { v7 as uuidv7 } from "uuid"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	type ModelInfo,
	openAiCodexDefaultModelId,
	OpenAiCodexModelId,
	openAiCodexModels,
	type ReasoningEffort,
	type ReasoningEffortExtended,
	ApiProviderError,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Package } from "../../shared/package"
import type { ApiHandlerOptions } from "../../shared/api"

import {
	ApiStream,
	ApiStreamChunk,
	ApiStreamUsageChunk,
	createApiStreamError,
	createApiStreamOutcome,
	createLinkedAbortController,
	getApiStreamErrorMessage,
	isApiStreamAbortError,
	isApiStreamSemanticChunk,
	normalizeApiStreamErrorMetadata,
	iterateApiStreamWithAbort,
	raceApiStreamAbort,
	type LinkedAbortController,
	type ApiStreamError,
} from "../transform/stream"
import { getResponsesApiTerminal } from "../transform/responses-api-stream"
import { getModelParams } from "../transform/model-params"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { isMcpTool } from "../../utils/mcp-name"
import { sanitizeOpenAiCallId } from "../../utils/tool-id"
import { openAiCodexOAuthManager } from "../../integrations/openai-codex/oauth"
import { t } from "../../i18n"

export type OpenAiCodexModel = ReturnType<OpenAiCodexHandler["getModel"]>

type PendingToolCallIdentity = {
	callId: string
	name?: string
	outputIndex: number
}

type ProviderTerminalError = Error &
	Partial<ApiStreamError> & {
		reason?: string
		terminal?: boolean
		errorCode?: string
	}

/** Keep canonical provider failure metadata on the Error crossing the stream boundary. */
function withTerminalFailureMetadata(
	error: Error,
	terminal: ApiStreamError | undefined,
	reason?: string,
): ProviderTerminalError {
	if (!terminal) return error as ProviderTerminalError

	const enriched = error as ProviderTerminalError
	Object.assign(enriched, {
		terminal: true,
		reason: reason ?? terminal.message,
		errorCode: terminal.error,
		...(terminal.code !== undefined ? { code: terminal.code } : {}),
		...(terminal.status !== undefined ? { status: terminal.status } : {}),
		...(terminal.statusCode !== undefined ? { statusCode: terminal.statusCode } : {}),
		...(terminal.retryable !== undefined ? { retryable: terminal.retryable } : {}),
		...(terminal.phase !== undefined ? { phase: terminal.phase } : {}),
		...(terminal.requestId !== undefined ? { requestId: terminal.requestId } : {}),
		...(terminal.attemptId !== undefined ? { attemptId: terminal.attemptId } : {}),
		...(terminal.semanticOutputObserved !== undefined
			? { semanticOutputObserved: terminal.semanticOutputObserved }
			: {}),
		...(terminal.metadata !== undefined ? { metadata: terminal.metadata } : {}),
	})
	return enriched
}

/**
 * OpenAI Codex base URL for API requests
 * Per the implementation guide: requests are routed to chatgpt.com/backend-api/codex
 */
const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

/**
 * OpenAiCodexHandler - Uses OpenAI Responses API with OAuth authentication
 *
 * Key differences from OpenAiNativeHandler:
 * - Uses OAuth Bearer tokens instead of API keys
 * - Routes requests to Codex backend (chatgpt.com/backend-api/codex)
 * - Subscription-based pricing (no per-token costs)
 * - Limited model subset
 * - Custom headers for Codex backend
 */
export class OpenAiCodexHandler extends BaseProvider implements SingleCompletionHandler {
	readonly streamCapabilities = { lifecycle: true, cancellation: true } as const
	protected options: ApiHandlerOptions
	private readonly providerName = "OpenAI Codex"
	private client?: OpenAI
	// Complete response output array
	private lastResponseOutput: any[] | undefined
	// Last top-level response id
	private lastResponseId: string | undefined
	// Abort controller for cancelling ongoing requests
	private abortController?: AbortController
	private requestControl?: LinkedAbortController
	private responseTerminalSeen = false
	private semanticOutputObserved = false
	private responseAccepted = false
	private currentMetadata?: ApiHandlerCreateMessageMetadata
	private terminalErrorMessage?: string
	private terminalFailureReason?: string
	private terminalFailureError?: ApiStreamError
	private terminalFailureSurfaced = false
	// Session ID for the Codex API (persists for the lifetime of the handler)
	private readonly sessionId: string
	/** Last observed identity is retained only for legacy streams without correlation fields. */
	private pendingToolCallId: string | undefined
	private pendingToolCallName: string | undefined
	/** Responses deltas identify calls by item_id/output_index, not call_id/name. */
	private pendingToolCallsByItemId = new Map<string, PendingToolCallIdentity>()
	private pendingToolCallsByOutputIndex = new Map<number, PendingToolCallIdentity>()
	// Tracks whether this response already emitted text to avoid duplicate done-event rendering.
	private sawTextOutputInCurrentResponse = false
	// Tracks whether text arrived through delta events so content_part events can be treated as fallback-only.
	private sawTextDeltaInCurrentResponse = false
	// Tracks tool call IDs emitted via streaming partial events to prevent done-event duplicates.
	private streamedToolCallIds = new Set<string>()

	// Event types handled by the shared event processor
	private readonly coreHandledEventTypes = new Set<string>([
		"response.text.delta",
		"response.output_text.delta",
		"response.text.done",
		"response.output_text.done",
		"response.content_part.added",
		"response.content_part.done",
		"response.reasoning.delta",
		"response.reasoning_text.delta",
		"response.reasoning_summary.delta",
		"response.reasoning_summary_text.delta",
		"response.refusal.delta",
		"response.output_item.added",
		"response.output_item.done",
		"response.done",
		"response.completed",
		"response.tool_call_arguments.delta",
		"response.function_call_arguments.delta",
		"response.tool_call_arguments.done",
		"response.function_call_arguments.done",
		"response.failed",
		"response.incomplete",
		"response.error",
		"error",
	])

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		// Generate a new session ID for standalone handler usage (fallback)
		this.sessionId = uuidv7()
	}

	private getToolCallOutputIndex(event: any): number | undefined {
		if (typeof event?.output_index === "number") return event.output_index
		if (typeof event?.index === "number") return event.index
		return undefined
	}

	private rememberToolCallIdentity(event: any, item: any): void {
		const callId = item?.call_id || item?.tool_call_id || item?.id
		if (typeof callId !== "string" || callId.length === 0) return

		const name = item?.name || item?.function?.name || item?.function_name
		const outputIndex = this.getToolCallOutputIndex(event)
		const identity: PendingToolCallIdentity = {
			callId,
			name: typeof name === "string" ? name : undefined,
			outputIndex: outputIndex ?? 0,
		}
		const itemId = item?.id || event?.item_id
		if (typeof itemId === "string" && itemId.length > 0) {
			this.pendingToolCallsByItemId.set(itemId, identity)
		}
		if (outputIndex !== undefined) {
			this.pendingToolCallsByOutputIndex.set(outputIndex, identity)
		}
		this.pendingToolCallId = callId
		this.pendingToolCallName = identity.name
	}

	private resolveToolCallIdentity(event: any): PendingToolCallIdentity | undefined {
		const outputIndex = this.getToolCallOutputIndex(event)
		const itemId = event?.item_id
		const hasCorrelationFields = (typeof itemId === "string" && itemId.length > 0) || outputIndex !== undefined
		const correlated =
			(typeof itemId === "string" ? this.pendingToolCallsByItemId.get(itemId) : undefined) ??
			(outputIndex !== undefined ? this.pendingToolCallsByOutputIndex.get(outputIndex) : undefined)
		const callId =
			event?.call_id ||
			event?.tool_call_id ||
			correlated?.callId ||
			(!hasCorrelationFields ? event?.id || this.pendingToolCallId : undefined)
		const name =
			event?.name ||
			event?.function_name ||
			correlated?.name ||
			(!hasCorrelationFields ? this.pendingToolCallName : undefined)

		if (typeof callId !== "string" || callId.length === 0) return undefined
		return {
			callId,
			name: typeof name === "string" ? name : undefined,
			outputIndex: outputIndex ?? correlated?.outputIndex ?? 0,
		}
	}

	private normalizeUsage(usage: any, model: OpenAiCodexModel): ApiStreamUsageChunk | undefined {
		if (!usage) return undefined

		const inputDetails = usage.input_tokens_details ?? usage.prompt_tokens_details

		const hasCachedTokens = typeof inputDetails?.cached_tokens === "number"
		const hasCacheMissTokens = typeof inputDetails?.cache_miss_tokens === "number"
		const cachedFromDetails = hasCachedTokens ? inputDetails.cached_tokens : 0
		const missFromDetails = hasCacheMissTokens ? inputDetails.cache_miss_tokens : 0

		let totalInputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0
		if (totalInputTokens === 0 && inputDetails && (cachedFromDetails > 0 || missFromDetails > 0)) {
			totalInputTokens = cachedFromDetails + missFromDetails
		}

		const totalOutputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0
		const cacheWriteTokens = usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0
		const cacheReadTokens =
			usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? usage.cached_tokens ?? cachedFromDetails ?? 0

		const reasoningTokens =
			typeof usage.output_tokens_details?.reasoning_tokens === "number"
				? usage.output_tokens_details.reasoning_tokens
				: undefined

		// Subscription-based: no per-token costs
		const out: ApiStreamUsageChunk = {
			type: "usage",
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
			totalCost: 0, // Subscription-based pricing
		}
		return out
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const model = this.getModel()
		yield* this.handleResponsesApiMessage(model, systemPrompt, messages, metadata)
	}

	private async *handleResponsesApiMessage(
		model: OpenAiCodexModel,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Reset state for this request
		this.lastResponseOutput = undefined
		this.lastResponseId = undefined
		this.pendingToolCallId = undefined
		this.pendingToolCallName = undefined
		this.pendingToolCallsByItemId.clear()
		this.pendingToolCallsByOutputIndex.clear()
		this.sawTextOutputInCurrentResponse = false
		this.sawTextDeltaInCurrentResponse = false
		this.streamedToolCallIds.clear()
		this.responseTerminalSeen = false
		this.semanticOutputObserved = false
		this.responseAccepted = false
		this.currentMetadata = metadata
		this.terminalErrorMessage = undefined
		this.terminalFailureReason = undefined
		this.terminalFailureError = undefined
		this.terminalFailureSurfaced = false

		// Get access token from OAuth manager
		let accessToken = await openAiCodexOAuthManager.getAccessToken()
		if (!accessToken) {
			throw new Error(
				t("common:errors.openAiCodex.notAuthenticated", {
					defaultValue:
						"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
				}),
			)
		}

		// Resolve reasoning effort
		const reasoningEffort = this.getReasoningEffort(model)

		// Format conversation
		const formattedInput = this.formatFullConversation(systemPrompt, messages)

		// Build request body
		// Per the implementation guide: Codex backend may reject some parameters
		// Notably: max_output_tokens and prompt_cache_retention may be rejected
		const requestBody = this.buildRequestBody(model, formattedInput, systemPrompt, reasoningEffort, metadata)

		// Make the request with retry on auth failure
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				yield* this.executeRequest(requestBody, model, accessToken, metadata)
				return
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const isAuthFailure = /unauthorized|invalid token|not authenticated|authentication|401/i.test(message)
				const retryable = (error as { retryable?: unknown })?.retryable

				if (
					attempt === 0 &&
					isAuthFailure &&
					retryable !== false &&
					!isApiStreamAbortError(error, metadata?.signal)
				) {
					// Force refresh the token for retry
					const refreshed = await openAiCodexOAuthManager.forceRefreshAccessToken()
					if (!refreshed) {
						throw new Error(
							t("common:errors.openAiCodex.notAuthenticated", {
								defaultValue:
									"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
							}),
						)
					}
					accessToken = refreshed
					continue
				}
				throw error
			}
		}
	}

	private buildRequestBody(
		model: OpenAiCodexModel,
		formattedInput: any,
		systemPrompt: string,
		reasoningEffort: ReasoningEffortExtended | undefined,
		metadata?: ApiHandlerCreateMessageMetadata,
	): any {
		const ensureAdditionalPropertiesFalse = (schema: any): any => {
			if (!schema || typeof schema !== "object" || schema.type !== "object") {
				return schema
			}

			const result = { ...schema }
			if (result.additionalProperties !== false) {
				result.additionalProperties = false
			}

			if (result.properties) {
				const newProps = { ...result.properties }
				for (const key of Object.keys(result.properties)) {
					const prop = newProps[key]
					if (prop && prop.type === "object") {
						newProps[key] = ensureAdditionalPropertiesFalse(prop)
					} else if (prop && prop.type === "array" && prop.items?.type === "object") {
						newProps[key] = {
							...prop,
							items: ensureAdditionalPropertiesFalse(prop.items),
						}
					}
				}
				result.properties = newProps
			}

			return result
		}

		interface ResponsesRequestBody {
			model: string
			input: Array<{ role: "user" | "assistant"; content: any[] } | { type: string; content: string }>
			stream: boolean
			reasoning?: { effort?: ReasoningEffortExtended; summary?: "auto" }
			temperature?: number
			store?: boolean
			instructions?: string
			include?: string[]
			tools?: Array<{
				type: "function"
				name: string
				description?: string
				parameters?: any
				strict?: boolean
			}>
			tool_choice?: any
			parallel_tool_calls?: boolean
		}

		// Per the implementation guide: Codex backend may reject max_output_tokens
		// and prompt_cache_retention, so we omit them
		const body: ResponsesRequestBody = {
			model: model.id,
			input: formattedInput,
			stream: true,
			store: false,
			instructions: systemPrompt,
			// Only include encrypted reasoning content when reasoning effort is set
			...(reasoningEffort ? { include: ["reasoning.encrypted_content"] } : {}),
			...(reasoningEffort
				? {
						reasoning: {
							...(reasoningEffort ? { effort: reasoningEffort } : {}),
							summary: "auto" as const,
						},
					}
				: {}),
			tools: (metadata?.tools ?? [])
				.filter((tool) => tool.type === "function")
				.map((tool) => {
					const isMcp = isMcpTool(tool.function.name)
					return {
						type: "function",
						name: tool.function.name,
						description: tool.function.description,
						parameters: isMcp
							? ensureAdditionalPropertiesFalse(tool.function.parameters)
							: this.convertToolSchemaForOpenAI(tool.function.parameters),
						strict: !isMcp,
					}
				}),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		return body
	}

	private observeStreamChunk(chunk: ApiStreamChunk): void {
		if (isApiStreamSemanticChunk(chunk)) this.semanticOutputObserved = true
	}

	private createErrorChunk(
		error: unknown,
		metadata?: ApiHandlerCreateMessageMetadata,
		phase = "request",
		messageOverride?: string,
	): ApiStreamError {
		const normalized = normalizeApiStreamErrorMetadata(
			error,
			{ requestId: metadata?.requestId, attemptId: metadata?.attemptId },
			{ phase, semanticOutputObserved: this.semanticOutputObserved },
		)
		return createApiStreamError({
			message: messageOverride ?? getApiStreamErrorMessage(error),
			error: normalized.code,
			...normalized,
			semanticOutputObserved: this.semanticOutputObserved,
		})
	}

	private createTerminalFailureError(fallbackMessage?: string, cause?: unknown): ProviderTerminalError {
		const message = this.terminalErrorMessage || fallbackMessage || "Codex API error"
		const error = new Error(message, cause instanceof Error ? { cause } : undefined)
		return withTerminalFailureMetadata(error, this.terminalFailureError, this.terminalFailureReason)
	}

	private async *emitCancelledOutcome(metadata?: ApiHandlerCreateMessageMetadata, phase = "request"): ApiStream {
		if (this.responseTerminalSeen) return
		this.responseTerminalSeen = true
		yield createApiStreamOutcome({
			status: "cancelled",
			terminal: true,
			semanticOutputObserved: this.semanticOutputObserved,
			reason: getApiStreamErrorMessage(this.abortController?.signal.reason, "Request cancelled"),
			retryable: false,
			phase,
			requestId: metadata?.requestId,
			attemptId: metadata?.attemptId,
		})
	}

	private async *executeRequest(
		requestBody: any,
		model: OpenAiCodexModel,
		accessToken: string,
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.requestControl = createLinkedAbortController(metadata)
		this.abortController = this.requestControl.controller
		const taskId = metadata?.taskId

		try {
			if (this.abortController.signal.aborted) {
				yield* this.emitCancelledOutcome(metadata, "request")
				return
			}

			// Prefer OpenAI SDK streaming (same approach as openai-native) so event handling
			// is consistent across providers.
			try {
				// Get ChatGPT account ID for organization subscriptions
				const accountId = await openAiCodexOAuthManager.getAccountId()

				// Build Codex-specific headers. Authorization is provided by the SDK apiKey.
				const codexHeaders: Record<string, string> = {
					originator: "alpha-code",
					session_id: taskId || this.sessionId,
					"User-Agent": `alpha-code/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
					...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
					...(metadata?.requestId ? { "x-alpha-request-id": metadata.requestId } : {}),
					...(metadata?.attemptId ? { "x-alpha-attempt-id": metadata.attemptId } : {}),
				}

				// Allow tests to inject a client. If none is injected, create one for this request.
				const client =
					this.client ??
					new OpenAI({
						apiKey: accessToken,
						baseURL: CODEX_API_BASE_URL,
						defaultHeaders: codexHeaders,
					})

				const stream = (await (client as any).responses.create(requestBody, {
					signal: this.abortController.signal,
					// If the SDK supports per-request overrides, ensure headers are present.
					headers: codexHeaders,
				})) as AsyncIterable<any>

				if (typeof (stream as any)?.[Symbol.asyncIterator] !== "function") {
					throw new Error(
						"OpenAI SDK did not return an AsyncIterable for Responses API streaming. Falling back to SSE.",
					)
				}
				this.responseAccepted = true

				for await (const event of iterateApiStreamWithAbort(stream, this.abortController.signal)) {
					if (this.abortController.signal.aborted) {
						break
					}

					for await (const outChunk of this.processEvent(event, model)) {
						this.observeStreamChunk(outChunk)
						yield outChunk
						if (outChunk.type === "outcome" && outChunk.status === "failed") {
							if (metadata?.streamCapabilities?.lifecycle === true) return
							throw this.createTerminalFailureError(outChunk.reason)
						}
					}
				}

				if (this.abortController.signal.aborted) {
					yield* this.emitCancelledOutcome(metadata, "stream")
				} else if (!this.responseTerminalSeen) {
					yield createApiStreamOutcome({
						status: "incomplete",
						terminal: false,
						semanticOutputObserved: this.semanticOutputObserved,
						reason: "Responses API stream ended without a terminal event",
						retryable: true,
						phase: "stream",
						requestId: metadata?.requestId,
						attemptId: metadata?.attemptId,
					})
				}
			} catch (sdkErr) {
				if (isApiStreamAbortError(sdkErr, this.abortController.signal)) {
					yield* this.emitCancelledOutcome(metadata, "request")
					return
				}
				if (this.terminalFailureSurfaced) {
					throw withTerminalFailureMetadata(
						sdkErr instanceof Error ? sdkErr : new Error(String(sdkErr)),
						this.terminalFailureError,
						this.terminalFailureReason,
					)
				}
				if (this.responseAccepted || this.semanticOutputObserved || this.responseTerminalSeen) {
					const errorChunk = this.createErrorChunk(sdkErr, metadata, "stream")
					yield errorChunk
					yield createApiStreamOutcome({
						status: "failed",
						terminal: true,
						semanticOutputObserved: this.semanticOutputObserved,
						reason: errorChunk.message,
						retryable: errorChunk.retryable,
						phase: errorChunk.phase ?? "stream",
						requestId: metadata?.requestId,
						attemptId: metadata?.attemptId,
					})
					if (metadata?.streamCapabilities?.lifecycle === true) return
					throw sdkErr
				}
				// Only a pre-acceptance SDK failure may replay through manual SSE.
				yield* this.makeCodexRequest(requestBody, model, accessToken, metadata)
			}
		} finally {
			this.abortController = undefined
			this.requestControl?.dispose()
			this.requestControl = undefined
		}
	}

	private formatFullConversation(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): any {
		const formattedInput: any[] = []

		for (const message of messages) {
			// Check if this is a reasoning item
			if ((message as any).type === "reasoning") {
				formattedInput.push(message)
				continue
			}

			if (message.role === "user") {
				const content: any[] = []
				const toolResults: any[] = []

				if (typeof message.content === "string") {
					content.push({ type: "input_text", text: message.content })
				} else if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (block.type === "text") {
							content.push({ type: "input_text", text: block.text })
						} else if (block.type === "image") {
							const image = block as Anthropic.Messages.ImageBlockParam
							const imageUrl = `data:${image.source.media_type};base64,${image.source.data}`
							content.push({ type: "input_image", image_url: imageUrl })
						} else if (block.type === "tool_result") {
							const result =
								typeof block.content === "string"
									? block.content
									: block.content?.map((c) => (c.type === "text" ? c.text : "")).join("") || ""
							toolResults.push({
								type: "function_call_output",
								// Sanitize and truncate call_id to fit OpenAI's 64-char limit
								call_id: sanitizeOpenAiCallId(block.tool_use_id),
								output: result,
							})
						}
					}
				}

				if (content.length > 0) {
					formattedInput.push({ role: "user", content })
				}

				if (toolResults.length > 0) {
					formattedInput.push(...toolResults)
				}
			} else if (message.role === "assistant") {
				const content: any[] = []
				const toolCalls: any[] = []

				if (typeof message.content === "string") {
					content.push({ type: "output_text", text: message.content })
				} else if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (block.type === "text") {
							content.push({ type: "output_text", text: block.text })
						} else if (block.type === "tool_use") {
							toolCalls.push({
								type: "function_call",
								// Sanitize and truncate call_id to fit OpenAI's 64-char limit
								call_id: sanitizeOpenAiCallId(block.id),
								name: block.name,
								arguments: JSON.stringify(block.input),
							})
						}
					}
				}

				if (content.length > 0) {
					formattedInput.push({ role: "assistant", content })
				}

				if (toolCalls.length > 0) {
					formattedInput.push(...toolCalls)
				}
			}
		}

		return formattedInput
	}

	private async *makeCodexRequest(
		requestBody: any,
		model: OpenAiCodexModel,
		accessToken: string,
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Per the implementation guide: route to Codex backend with Bearer token
		const url = `${CODEX_API_BASE_URL}/responses`

		// Get ChatGPT account ID for organization subscriptions
		const accountId = await openAiCodexOAuthManager.getAccountId()

		// Build headers with required Codex-specific fields
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			originator: "alpha-code",
			session_id: metadata?.taskId || this.sessionId,
			"User-Agent": `alpha-code/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
			...(metadata?.requestId ? { "x-alpha-request-id": metadata.requestId } : {}),
			...(metadata?.attemptId ? { "x-alpha-attempt-id": metadata.attemptId } : {}),
		}

		// Add ChatGPT-Account-Id if available (required for organization subscriptions)
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId
		}

		try {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: this.abortController?.signal,
			})

			if (!response.ok) {
				const errorText = await response.text()

				let errorMessage = t("common:errors.api.apiRequestFailed", { status: response.status })
				let errorDetails = ""

				try {
					const errorJson = JSON.parse(errorText)
					if (errorJson.error?.message) {
						errorDetails = errorJson.error.message
					} else if (errorJson.message) {
						errorDetails = errorJson.message
					} else if (errorJson.detail) {
						errorDetails = errorJson.detail
					} else {
						errorDetails = errorText
					}
				} catch {
					errorDetails = errorText
				}

				switch (response.status) {
					case 400:
						errorMessage = t("common:errors.openAiCodex.invalidRequest")
						break
					case 401:
						errorMessage = t("common:errors.openAiCodex.authenticationFailed")
						break
					case 403:
						errorMessage = t("common:errors.openAiCodex.accessDenied")
						break
					case 404:
						errorMessage = t("common:errors.openAiCodex.endpointNotFound")
						break
					case 429:
						errorMessage = t("common:errors.openAiCodex.rateLimitExceeded")
						break
					case 500:
					case 502:
					case 503:
						errorMessage = t("common:errors.openAiCodex.serviceError")
						break
					default:
						errorMessage = t("common:errors.openAiCodex.genericError", { status: response.status })
				}

				if (errorDetails) {
					errorMessage += ` - ${errorDetails}`
				}

				const requestError = new Error(errorMessage) as Error & {
					status?: number
					retryable?: boolean
				}
				requestError.status = response.status
				requestError.retryable =
					response.status === 408 ||
					response.status === 409 ||
					response.status === 425 ||
					response.status === 429 ||
					response.status >= 500
				throw requestError
			}

			if (!response.body) {
				throw new Error(t("common:errors.openAiCodex.noResponseBody"))
			}

			this.responseAccepted = true
			yield* this.handleStreamResponse(response.body, model, metadata)
		} catch (error) {
			if (isApiStreamAbortError(error, this.abortController?.signal)) {
				yield* this.emitCancelledOutcome(metadata, "request")
				return
			}
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model.id, "createMessage")
			TelemetryService.instance.captureException(apiError)
			if (this.terminalFailureSurfaced) {
				throw withTerminalFailureMetadata(
					error instanceof Error ? error : new Error(errorMessage),
					this.terminalFailureError,
					this.terminalFailureReason,
				)
			}
			const errorChunk = this.createErrorChunk(error, metadata, "request")
			yield errorChunk
			yield createApiStreamOutcome({
				status: "failed",
				terminal: true,
				semanticOutputObserved: this.semanticOutputObserved,
				reason: errorChunk.message,
				retryable: errorChunk.retryable,
				phase: "request",
				requestId: metadata?.requestId,
				attemptId: metadata?.attemptId,
			})
			if (metadata?.streamCapabilities?.lifecycle === true) return

			if (error instanceof Error) {
				if (error.message.includes("Codex API")) {
					throw error
				}
				throw new Error(t("common:errors.openAiCodex.connectionFailed", { message: error.message }))
			}
			throw new Error(t("common:errors.openAiCodex.unexpectedConnectionError"))
		}
	}

	private async *handleStreamResponse(
		body: ReadableStream<Uint8Array>,
		model: OpenAiCodexModel,
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let hasContent = false

		try {
			while (true) {
				if (this.abortController?.signal.aborted) {
					break
				}

				const readResult = await raceApiStreamAbort(reader.read(), this.abortController?.signal)
				if (!readResult) break
				const { done, value } = readResult
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim()
						if (data === "[DONE]") {
							continue
						}

						try {
							const parsed = JSON.parse(data)

							// Capture response metadata
							if (parsed.response?.output && Array.isArray(parsed.response.output)) {
								this.lastResponseOutput = parsed.response.output
							}
							if (parsed.response?.id) {
								this.lastResponseId = parsed.response.id as string
							}

							// Delegate standard event types
							if (parsed?.type && this.coreHandledEventTypes.has(parsed.type)) {
								// Capture tool call identity from output_item events so we can
								// emit tool_call_partial for subsequent function_call_arguments.delta events
								if (
									parsed.type === "response.output_item.added" ||
									parsed.type === "response.output_item.done"
								) {
									const item = parsed.item
									if (item && (item.type === "function_call" || item.type === "tool_call")) {
										const callId = item.call_id || item.tool_call_id || item.id
										const name = item.name || item.function?.name || item.function_name
										if (typeof callId === "string" && callId.length > 0) {
											this.pendingToolCallId = callId
											this.pendingToolCallName = typeof name === "string" ? name : undefined
										}
									}
								}

								// Some Codex streams only return tool calls (no text). Treat tool output as content.
								if (
									parsed.type === "response.function_call_arguments.delta" ||
									parsed.type === "response.tool_call_arguments.delta" ||
									parsed.type === "response.output_item.added" ||
									parsed.type === "response.output_item.done"
								) {
									hasContent = true
								}

								for await (const outChunk of this.processEvent(parsed, model)) {
									this.observeStreamChunk(outChunk)
									if (outChunk.type === "text" || outChunk.type === "reasoning") {
										hasContent = true
										if (outChunk.type === "text") {
											this.sawTextOutputInCurrentResponse = true
										}
									}
									yield outChunk
									if (outChunk.type === "outcome" && outChunk.status === "failed") {
										if (metadata?.streamCapabilities?.lifecycle === true) return
										throw this.createTerminalFailureError(outChunk.reason)
									}
								}
								continue
							}

							// Handle complete response
							if (parsed.response && parsed.response.output && Array.isArray(parsed.response.output)) {
								for (const outputItem of parsed.response.output) {
									if (outputItem.type === "text" && outputItem.content) {
										for (const content of outputItem.content) {
											if (content.type === "text" && content.text) {
												hasContent = true
												this.sawTextOutputInCurrentResponse = true
												yield { type: "text", text: content.text }
											}
										}
									}
									if (outputItem.type === "reasoning" && Array.isArray(outputItem.summary)) {
										for (const summary of outputItem.summary) {
											if (summary?.type === "summary_text" && typeof summary.text === "string") {
												hasContent = true
												yield { type: "reasoning", text: summary.text }
											}
										}
									}
								}
								if (parsed.response.usage) {
									const usageData = this.normalizeUsage(parsed.response.usage, model)
									if (usageData) {
										yield usageData
									}
								}
							} else if (
								parsed.type === "response.text.delta" ||
								parsed.type === "response.output_text.delta"
							) {
								if (parsed.delta) {
									hasContent = true
									this.sawTextOutputInCurrentResponse = true
									yield { type: "text", text: parsed.delta }
								}
							} else if (
								(parsed.type === "response.text.done" || parsed.type === "response.output_text.done") &&
								!hasContent
							) {
								const doneText =
									typeof parsed.text === "string"
										? parsed.text
										: typeof parsed.output_text === "string"
											? parsed.output_text
											: typeof parsed.delta === "string"
												? parsed.delta
												: undefined
								if (doneText) {
									hasContent = true
									this.sawTextOutputInCurrentResponse = true
									yield { type: "text", text: doneText }
								}
							} else if (
								parsed.type === "response.reasoning.delta" ||
								parsed.type === "response.reasoning_text.delta"
							) {
								if (parsed.delta) {
									hasContent = true
									yield { type: "reasoning", text: parsed.delta }
								}
							} else if (
								parsed.type === "response.reasoning_summary.delta" ||
								parsed.type === "response.reasoning_summary_text.delta"
							) {
								if (parsed.delta) {
									hasContent = true
									yield { type: "reasoning", text: parsed.delta }
								}
							} else if (parsed.type === "response.refusal.delta") {
								if (parsed.delta) {
									hasContent = true
									this.sawTextOutputInCurrentResponse = true
									yield { type: "text", text: `[Refusal] ${parsed.delta}` }
								}
							} else if (parsed.type === "response.output_item.added") {
								if (parsed.item) {
									if (parsed.item.type === "text" && parsed.item.text) {
										hasContent = true
										this.sawTextOutputInCurrentResponse = true
										yield { type: "text", text: parsed.item.text }
									} else if (parsed.item.type === "reasoning" && parsed.item.text) {
										hasContent = true
										yield { type: "reasoning", text: parsed.item.text }
									} else if (parsed.item.type === "message" && parsed.item.content) {
										for (const content of parsed.item.content) {
											if (content.type === "text" && content.text) {
												hasContent = true
												this.sawTextOutputInCurrentResponse = true
												yield { type: "text", text: content.text }
											}
										}
									}
								}
							} else if (parsed.type === "response.error" || parsed.type === "error") {
								if (parsed.error || parsed.message) {
									throw new Error(
										t("common:errors.openAiCodex.apiError", {
											message: parsed.error?.message || parsed.message || "Unknown error",
										}),
									)
								}
							} else if (parsed.type === "response.failed") {
								if (parsed.error || parsed.message) {
									throw new Error(
										t("common:errors.openAiCodex.responseFailed", {
											message: parsed.error?.message || parsed.message || "Unknown failure",
										}),
									)
								}
							} else if (parsed.type === "response.completed" || parsed.type === "response.done") {
								if (parsed.response?.output && Array.isArray(parsed.response.output)) {
									this.lastResponseOutput = parsed.response.output
								}
								if (parsed.response?.id) {
									this.lastResponseId = parsed.response.id as string
								}

								if (
									!hasContent &&
									parsed.response &&
									parsed.response.output &&
									Array.isArray(parsed.response.output)
								) {
									for (const outputItem of parsed.response.output) {
										if (outputItem.type === "message" && outputItem.content) {
											for (const content of outputItem.content) {
												if (content.type === "output_text" && content.text) {
													hasContent = true
													this.sawTextOutputInCurrentResponse = true
													yield { type: "text", text: content.text }
												}
											}
										}
										if (outputItem.type === "reasoning" && Array.isArray(outputItem.summary)) {
											for (const summary of outputItem.summary) {
												if (
													summary?.type === "summary_text" &&
													typeof summary.text === "string"
												) {
													hasContent = true
													yield { type: "reasoning", text: summary.text }
												}
											}
										}
									}
								}
							} else if (parsed.choices?.[0]?.delta?.content) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: parsed.choices[0].delta.content }
							} else if (
								parsed.item &&
								typeof parsed.item.text === "string" &&
								parsed.item.text.length > 0
							) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: parsed.item.text }
							} else if (parsed.usage) {
								const usageData = this.normalizeUsage(parsed.usage, model)
								if (usageData) {
									yield usageData
								}
							}
						} catch (e) {
							if (!(e instanceof SyntaxError)) {
								throw e
							}
						}
					} else if (line.trim() && !line.startsWith(":")) {
						try {
							const parsed = JSON.parse(line)
							if (parsed.content || parsed.text || parsed.message) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: parsed.content || parsed.text || parsed.message }
							}
						} catch {
							// Not JSON, ignore
						}
					}
				}
			}

			this.semanticOutputObserved ||= hasContent
			if (this.abortController?.signal.aborted) {
				yield* this.emitCancelledOutcome(metadata, "stream")
			} else if (!this.responseTerminalSeen) {
				yield createApiStreamOutcome({
					status: "incomplete",
					terminal: false,
					semanticOutputObserved: this.semanticOutputObserved,
					reason: "Responses API stream ended without a terminal event",
					retryable: true,
					phase: "stream",
					requestId: metadata?.requestId,
					attemptId: metadata?.attemptId,
				})
			}
		} catch (error) {
			if (isApiStreamAbortError(error, this.abortController?.signal)) {
				yield* this.emitCancelledOutcome(metadata, "stream")
				return
			}
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model.id, "createMessage")
			TelemetryService.instance.captureException(apiError)

			if (this.terminalFailureSurfaced) {
				throw withTerminalFailureMetadata(
					error instanceof Error ? error : new Error(errorMessage),
					this.terminalFailureError,
					this.terminalFailureReason,
				)
			}
			if (metadata?.streamCapabilities?.lifecycle === true) {
				const errorChunk = this.createErrorChunk(error, metadata, "stream")
				yield errorChunk
				yield createApiStreamOutcome({
					status: "failed",
					terminal: true,
					semanticOutputObserved: this.semanticOutputObserved,
					reason: errorChunk.message,
					retryable: errorChunk.retryable,
					phase: errorChunk.phase ?? "stream",
					requestId: metadata?.requestId,
					attemptId: metadata?.attemptId,
				})
				return
			}

			if (error instanceof Error) {
				throw new Error(t("common:errors.openAiCodex.streamProcessingError", { message: error.message }))
			}
			throw new Error(t("common:errors.openAiCodex.unexpectedStreamError"))
		} finally {
			reader.releaseLock()
		}
	}

	private async *processEvent(event: any, model: OpenAiCodexModel): ApiStream {
		// The first terminal event owns this response. Ignore duplicate/late
		// events so a repeated done marker cannot emit another outcome or upgrade
		// a non-success response.
		if (this.responseTerminalSeen) return

		const terminal = getResponsesApiTerminal(event)
		if (terminal?.status === "failed") {
			this.responseTerminalSeen = true
			this.terminalFailureSurfaced = true
			this.terminalErrorMessage = `${terminal.eventType === "response.failed" ? "Response failed" : "Codex API error"}: ${terminal.reason || "Unknown error"}`
			const errorChunk = this.createErrorChunk(
				terminal.error && event && typeof event === "object"
					? { ...event, ...(typeof terminal.error === "object" ? terminal.error : {}) }
					: (terminal.error ?? event),
				this.currentMetadata,
				terminal.phase ?? "response",
				terminal.reason,
			)
			this.terminalFailureReason = errorChunk.message
			this.terminalFailureError = errorChunk
			yield errorChunk
			yield createApiStreamOutcome({
				status: "failed",
				terminal: true,
				semanticOutputObserved: this.semanticOutputObserved,
				reason: errorChunk.message,
				retryable: errorChunk.retryable,
				phase: errorChunk.phase ?? "response",
				requestId: this.currentMetadata?.requestId,
				attemptId: this.currentMetadata?.attemptId,
			})
			return
		}
		if (terminal) this.responseTerminalSeen = true
		yield* this.processResponseEvent(event, model)
		if (terminal) {
			yield createApiStreamOutcome({
				status: terminal.status,
				terminal: true,
				semanticOutputObserved: this.semanticOutputObserved,
				reason: terminal.reason,
				phase: terminal.phase ?? "response",
				requestId: this.currentMetadata?.requestId,
				attemptId: this.currentMetadata?.attemptId,
			})
		}
	}

	private async *processResponseEvent(event: any, model: OpenAiCodexModel): ApiStream {
		if (event?.response?.output && Array.isArray(event.response.output)) {
			this.lastResponseOutput = event.response.output
		}
		if (event?.response?.id) {
			this.lastResponseId = event.response.id as string
		}

		// Handle text deltas
		if (event?.type === "response.text.delta" || event?.type === "response.output_text.delta") {
			if (event?.delta) {
				this.sawTextDeltaInCurrentResponse = true
				this.sawTextOutputInCurrentResponse = true
				yield { type: "text", text: event.delta }
			}
			return
		}

		if (event?.type === "response.text.done" || event?.type === "response.output_text.done") {
			const doneText =
				typeof event?.text === "string"
					? event.text
					: typeof event?.output_text === "string"
						? event.output_text
						: typeof event?.delta === "string"
							? event.delta
							: undefined
			if (!this.sawTextOutputInCurrentResponse && doneText) {
				this.sawTextOutputInCurrentResponse = true
				yield { type: "text", text: doneText }
			}
			return
		}

		if (event?.type === "response.content_part.added" || event?.type === "response.content_part.done") {
			const part = event?.part
			if (
				!this.sawTextDeltaInCurrentResponse &&
				(part?.type === "text" || part?.type === "output_text") &&
				(typeof part?.text === "string" || typeof part?.text?.value === "string")
			) {
				const partText = typeof part.text === "string" ? part.text : part.text.value
				if (partText) {
					this.sawTextOutputInCurrentResponse = true
					yield { type: "text", text: partText }
				}
			}
			return
		}

		// Handle reasoning deltas
		if (
			event?.type === "response.reasoning.delta" ||
			event?.type === "response.reasoning_text.delta" ||
			event?.type === "response.reasoning_summary.delta" ||
			event?.type === "response.reasoning_summary_text.delta"
		) {
			if (event?.delta) {
				yield { type: "reasoning", text: event.delta }
			}
			return
		}

		// Handle refusal deltas
		if (event?.type === "response.refusal.delta") {
			if (event?.delta) {
				this.sawTextOutputInCurrentResponse = true
				yield { type: "text", text: `[Refusal] ${event.delta}` }
			}
			return
		}

		// Handle tool/function call deltas
		if (
			event?.type === "response.tool_call_arguments.delta" ||
			event?.type === "response.function_call_arguments.delta"
		) {
			const identity = this.resolveToolCallIdentity(event)
			const callId = identity?.callId
			const name = identity?.name
			const args = event.delta || event.arguments

			// Codex/Responses may stream tool-call arguments, but these delta events are not guaranteed
			// to include a stable id/name. Avoid emitting incomplete tool_call_partial chunks because
			// NativeToolCallParser requires a name to start a call.
			if (
				identity &&
				typeof callId === "string" &&
				callId.length > 0 &&
				typeof name === "string" &&
				name.length > 0
			) {
				this.streamedToolCallIds.add(callId)
				yield {
					type: "tool_call_partial",
					index: identity.outputIndex,
					id: callId,
					name,
					arguments: typeof args === "string" ? args : "",
				}
			}
			return
		}

		// Handle tool/function call completion
		if (
			event?.type === "response.tool_call_arguments.done" ||
			event?.type === "response.function_call_arguments.done"
		) {
			return
		}

		// Handle output item events
		if (event?.type === "response.output_item.added" || event?.type === "response.output_item.done") {
			const item = event?.item
			if (item) {
				// Capture tool identity so subsequent argument deltas can be attributed.
				if (item.type === "function_call" || item.type === "tool_call") {
					this.rememberToolCallIdentity(event, item)
				}

				// For "added" events, yield text/reasoning content (streaming path).
				// For "done" events, normally text was already streamed via deltas, but some models
				// only provide assistant text on done events. Emit fallback text only if none was emitted yet.
				if (event.type === "response.output_item.added") {
					if (item.type === "text" && item.text) {
						this.sawTextOutputInCurrentResponse = true
						yield { type: "text", text: item.text }
					} else if (item.type === "output_text" && item.text) {
						this.sawTextOutputInCurrentResponse = true
						yield { type: "text", text: item.text }
					} else if (item.type === "reasoning" && item.text) {
						yield { type: "reasoning", text: item.text }
					} else if (item.type === "message" && Array.isArray(item.content)) {
						for (const content of item.content) {
							if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: content.text }
							}
						}
					}
				} else if (
					event.type === "response.output_item.done" &&
					(item.type === "function_call" || item.type === "tool_call")
				) {
					const callId = item.call_id || item.tool_call_id || item.id
					const name = item.name || item.function?.name || item.function_name
					const argsRaw = item.arguments || item.function?.arguments || item.input
					const args =
						typeof argsRaw === "string"
							? argsRaw
							: argsRaw && typeof argsRaw === "object"
								? JSON.stringify(argsRaw)
								: ""

					// Fallback for models that only emit a complete function_call in output_item.done.
					// If we already streamed partials for this ID, skip to avoid duplicate tool execution.
					if (
						typeof callId === "string" &&
						callId.length > 0 &&
						typeof name === "string" &&
						name.length > 0 &&
						!this.streamedToolCallIds.has(callId)
					) {
						yield {
							type: "tool_call",
							id: callId,
							name,
							arguments: args,
						}
					}
				} else if (!this.sawTextOutputInCurrentResponse) {
					if ((item.type === "text" || item.type === "output_text") && item.text) {
						this.sawTextOutputInCurrentResponse = true
						yield { type: "text", text: item.text }
					} else if (item.type === "message" && Array.isArray(item.content)) {
						for (const content of item.content) {
							if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: content.text }
							}
						}
					}
				}

				// Note: We intentionally do NOT emit tool_call from response.output_item.done
				// for function_call/tool_call items. The streaming path handles tool calls via:
				// 1. tool_call_partial events during argument deltas
				// 2. NativeToolCallParser.finalizeRawChunks() at stream end emitting tool_call_end
				// 3. NativeToolCallParser.finalizeStreamingToolCall() creating the final ToolUse
				// Emitting tool_call here would cause duplicate tool rendering.
			}
			return
		}

		// Handle completion events
		if (event?.type === "response.done" || event?.type === "response.completed") {
			// Some Codex variants only provide assistant text in the final completed payload.
			if (!this.sawTextOutputInCurrentResponse && Array.isArray(event?.response?.output)) {
				for (const outputItem of event.response.output) {
					if ((outputItem?.type === "text" || outputItem?.type === "output_text") && outputItem?.text) {
						this.sawTextOutputInCurrentResponse = true
						yield { type: "text", text: outputItem.text }
						continue
					}

					if (outputItem?.type === "message" && Array.isArray(outputItem.content)) {
						for (const content of outputItem.content) {
							if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: content.text }
							}
						}
					}
				}
			}

			const usage = event?.response?.usage || event?.usage || undefined
			const usageData = this.normalizeUsage(usage, model)
			if (usageData) {
				yield usageData
			}
			return
		}

		// Fallbacks
		if (event?.choices?.[0]?.delta?.content) {
			this.sawTextDeltaInCurrentResponse = true
			this.sawTextOutputInCurrentResponse = true
			yield { type: "text", text: event.choices[0].delta.content }
			return
		}

		if (event?.usage) {
			const usageData = this.normalizeUsage(event.usage, model)
			if (usageData) {
				yield usageData
			}
		}
	}

	private getReasoningEffort(model: OpenAiCodexModel): ReasoningEffortExtended | undefined {
		const selected = (this.options.reasoningEffort as any) ?? (model.info.reasoningEffort as any)
		return selected && selected !== "disable" && selected !== "none" ? (selected as any) : undefined
	}

	override getModel() {
		const modelId = this.options.apiModelId

		let id = modelId && modelId in openAiCodexModels ? (modelId as OpenAiCodexModelId) : openAiCodexDefaultModelId

		const info: ModelInfo = openAiCodexModels[id]

		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})

		return { id, info, ...params }
	}

	getEncryptedContent(): { encrypted_content: string; id?: string } | undefined {
		if (!this.lastResponseOutput) return undefined

		const reasoningItem = this.lastResponseOutput.find(
			(item) => item.type === "reasoning" && item.encrypted_content,
		)

		if (!reasoningItem?.encrypted_content) return undefined

		return {
			encrypted_content: reasoningItem.encrypted_content,
			...(reasoningItem.id ? { id: reasoningItem.id } : {}),
		}
	}

	getResponseId(): string | undefined {
		return this.lastResponseId
	}

	async completePrompt(prompt: string): Promise<string> {
		this.abortController = new AbortController()

		try {
			const model = this.getModel()

			// Get access token
			const accessToken = await openAiCodexOAuthManager.getAccessToken()
			if (!accessToken) {
				throw new Error(
					t("common:errors.openAiCodex.notAuthenticated", {
						defaultValue:
							"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
					}),
				)
			}

			const reasoningEffort = this.getReasoningEffort(model)

			const requestBody: any = {
				model: model.id,
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: prompt }],
					},
				],
				stream: false,
				store: false,
				...(reasoningEffort ? { include: ["reasoning.encrypted_content"] } : {}),
			}

			if (reasoningEffort) {
				requestBody.reasoning = {
					effort: reasoningEffort,
					summary: "auto" as const,
				}
			}

			const url = `${CODEX_API_BASE_URL}/responses`

			// Get ChatGPT account ID for organization subscriptions
			const accountId = await openAiCodexOAuthManager.getAccountId()

			// Build headers with required Codex-specific fields
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				originator: "alpha-code",
				session_id: this.sessionId,
				"User-Agent": `alpha-code/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
			}

			// Add ChatGPT-Account-Id if available
			if (accountId) {
				headers["ChatGPT-Account-Id"] = accountId
			}

			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: this.abortController.signal,
			})

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(
					t("common:errors.openAiCodex.genericError", { status: response.status }) +
						(errorText ? `: ${errorText}` : ""),
				)
			}

			const responseData = await response.json()

			if (responseData?.output && Array.isArray(responseData.output)) {
				for (const outputItem of responseData.output) {
					if (outputItem.type === "message" && outputItem.content) {
						for (const content of outputItem.content) {
							if (content.type === "output_text" && content.text) {
								return content.text
							}
						}
					}
				}
			}

			if (responseData?.text) {
				return responseData.text
			}

			return ""
		} catch (error) {
			const errorModel = this.getModel()
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, errorModel.id, "completePrompt")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.openAiCodex.completionError", { message: error.message }))
			}
			throw error
		} finally {
			this.abortController = undefined
		}
	}
}
