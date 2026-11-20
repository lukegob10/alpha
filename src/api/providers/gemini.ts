import { assertNativeVertexSettings } from "./utils/native-vertex-settings"
import type { Anthropic } from "@anthropic-ai/sdk"
import {
	GoogleGenAI,
	type GenerateContentResponse,
	type GenerateContentResponseUsageMetadata,
	type GenerateContentParameters,
	type GenerateContentConfig,
	type GroundingMetadata,
	FunctionCallingConfigMode,
} from "@google/genai"
import type { JWTInput } from "google-auth-library"

import {
	type ModelInfo,
	resolveModelParameterApplicability,
	validateOptionalOutputTokenLimit,
	snapshotGeminiResponse,
	MAX_GEMINI_RESPONSE_PARTS,
	MAX_GEMINI_RESPONSE_CHARACTERS,
	type GeminiResponse,
} from "@alpha-code/types"
import { safeJsonParse } from "@alpha-code/core"

import { DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS, type ApiHandlerOptions } from "../../shared/api"

import { convertAnthropicMessagesToGemini } from "../transform/gemini-format"
import { getLifecycleHookDeveloperContext } from "../transform/lifecycle-hook-context"
import { t } from "i18next"
import {
	ApiStreamDeadlineError,
	createLinkedAbortController,
	createApiStreamOutcome,
	raceApiStreamAbort,
	type ApiStream,
	type ApiStreamUsageChunk,
	type GroundingSource,
} from "../transform/stream"
import type { GeminiReasoningParams } from "../transform/reasoning"

import type {
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	ApiHandlerSingleCompletionMetadata,
} from "../index"
import { awaitSingleCompletion, throwIfSingleCompletionAborted } from "../transform/single-completion"
import { BaseProvider } from "./base-provider"
import {
	ApiRequestIdleTimeout,
	ApiRequestTimeoutError,
	getApiRequestTimeout,
	withApiRequestTimeout,
} from "./utils/timeout-config"

type GeminiRequestContext = {
	client: GoogleGenAI
	model: string
}

function createGenAiAbortSignal(signal: AbortSignal): AbortSignal {
	// GenAI 1.47 registers its transport abort listener after async request preparation.
	// Stop a cancelled request at registration if the event already fired.
	const transportSignal = AbortSignal.any([signal])
	const addEventListener = transportSignal.addEventListener.bind(transportSignal)
	transportSignal.addEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	) => {
		if (type === "abort") transportSignal.throwIfAborted()
		addEventListener(type, listener, options)
	}
	return transportSignal
}

function closeGeminiIterator(iterator: AsyncIterator<GenerateContentResponse>): void {
	// A blocked SDK read may keep return() pending even after transport cancellation.
	void Promise.resolve()
		.then(() => iterator.return?.())
		.catch(() => undefined)
}

type ProviderInstructionParts = {
	systemInstructions: string
	userContext: string
}

function getProviderInstructionParts(
	systemPrompt: string,
	instructionFragments: ApiHandlerCreateMessageMetadata["instructionFragments"],
): ProviderInstructionParts {
	if (instructionFragments === undefined) {
		return { systemInstructions: systemPrompt, userContext: "" }
	}

	const systemParts: string[] = []
	const userParts: string[] = []
	for (const fragment of instructionFragments) {
		const targetParts = fragment.role === "user" ? userParts : systemParts
		targetParts.push(fragment.content)
	}

	return {
		systemInstructions: systemParts.join(""),
		userContext: userParts.join(""),
	}
}

function prependUserInstructionContext(
	messages: Anthropic.Messages.MessageParam[],
	userContext: string,
): Anthropic.Messages.MessageParam[] {
	if (!userContext) return messages

	const firstMessage = messages[0]
	// Validate hook provenance before prefixing any project text; changing its
	// recorded body would erase the origin used by the provider-role fallback.
	if (firstMessage?.role !== "user" || getLifecycleHookDeveloperContext(firstMessage) !== undefined) {
		return [{ role: "user", content: userContext }, ...messages]
	}

	const content =
		typeof firstMessage.content === "string"
			? `${userContext}${userContext.endsWith("\n") ? "" : "\n\n"}${firstMessage.content}`
			: [
					{
						type: "text" as const,
						text: `${userContext}${userContext.endsWith("\n") ? "" : "\n\n"}`,
					},
					...firstMessage.content,
				]

	return [{ ...firstMessage, content }, ...messages.slice(1)]
}

function getGeminiStopReason(response: GenerateContentResponse): string | undefined {
	const blockReason = response.promptFeedback?.blockReason?.replace(/^BLOCK(?:ED)?_REASON_/, "")
	if (blockReason && blockReason !== "UNSPECIFIED") return blockReason

	const finishReason = response.candidates?.[0]?.finishReason?.replace(/^FINISH_REASON_/, "")
	return finishReason && finishReason !== "UNSPECIFIED" ? finishReason : undefined
}

function createGeminiOutcome(
	finishReason: string | undefined,
	semanticOutputObserved: boolean,
	metadata?: ApiHandlerCreateMessageMetadata,
	hasContent = true,
) {
	const terminal = Boolean(finishReason)
	let reason: string | undefined
	if (!finishReason) {
		reason = "Gemini response ended before a terminal finish reason."
	} else if (finishReason === "MAX_TOKENS") {
		reason = "Gemini response reached the output token limit (finishReason=MAX_TOKENS)."
	} else if (finishReason !== "STOP") {
		reason = `Gemini response stopped with finish reason ${finishReason}.`
	} else if (!hasContent) {
		reason = "Gemini response completed without visible content or tool calls."
	}

	return createApiStreamOutcome({
		status: reason ? "incomplete" : "completed",
		terminal,
		semanticOutputObserved,
		...(reason ? { reason, retryable: !terminal && !semanticOutputObserved } : {}),
		requestId: metadata?.requestId,
		attemptId: metadata?.attemptId,
	})
}

class GeminiResponseCapture {
	private readonly parts: GeminiResponse["parts"] = []
	private characters = 0
	private hasFunctionCall = false

	constructor(
		private readonly modelId: string,
		private readonly requireFunctionCallSignature: boolean,
	) {}

	add(parts: unknown[] | undefined): void {
		if (!parts?.length) return
		const snapshot = snapshotGeminiResponse({ modelId: this.modelId, parts })
		if (!snapshot) throw new Error("Gemini returned invalid response replay state.")
		this.characters += JSON.stringify(snapshot.parts).length
		if (
			this.parts.length + snapshot.parts.length > MAX_GEMINI_RESPONSE_PARTS ||
			this.characters > MAX_GEMINI_RESPONSE_CHARACTERS
		) {
			throw new Error("Gemini response replay state exceeded the output limit.")
		}
		for (const part of snapshot.parts) {
			if (part.functionCall && !this.hasFunctionCall) {
				if (this.requireFunctionCallSignature && !part.thoughtSignature)
					throw new Error("Gemini returned a function call without its thought signature.")
				this.hasFunctionCall = true
			}
			this.parts.push(part)
		}
	}

	snapshot(): GeminiResponse | undefined {
		if (this.parts.length === 0) return undefined
		const result = snapshotGeminiResponse({ modelId: this.modelId, parts: this.parts })
		if (!result) throw new Error("Gemini returned invalid response replay state.")
		return result
	}
}

type GeminiTransport = { provider: "vertex" } | { provider: "gemini"; apiKey: string }

/** Google protocol handling shared by explicitly selected direct and Vertex routes. */
export abstract class GeminiTransportHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	readonly streamCapabilities = { lifecycle: true, cancellation: true } as const
	private readonly transportProvider: GeminiTransport["provider"]

	private client: GoogleGenAI
	private lastThoughtSignature?: string
	private lastResponseId?: string
	private readonly providerName = "Gemini"

	constructor(options: ApiHandlerOptions, transport: GeminiTransport) {
		super()

		this.options = options
		this.transportProvider = transport.provider
		if (transport.provider === "gemini") {
			// Pin the native route independently of Vertex settings and SDK environment defaults.
			this.client = new GoogleGenAI({
				apiKey: transport.apiKey,
				vertexai: false,
				httpOptions: { baseUrl: "https://generativelanguage.googleapis.com", apiVersion: "v1beta" },
			})
			return
		}
		assertNativeVertexSettings(options)
		const project = this.getConfiguredProjectId() ?? "not-provided"
		const location = this.getConfiguredLocation() ?? "not-provided"

		this.client = this.options.vertexJsonCredentials
			? new GoogleGenAI({
					vertexai: true,
					project,
					location,
					googleAuthOptions: {
						credentials: safeJsonParse<JWTInput>(this.options.vertexJsonCredentials, undefined),
					},
				})
			: this.options.vertexKeyFile
				? new GoogleGenAI({
						vertexai: true,
						project,
						location,
						googleAuthOptions: { keyFile: this.options.vertexKeyFile },
					})
				: new GoogleGenAI({ vertexai: true, project, location })
	}

	private getConfiguredProjectId(): string | undefined {
		const value = this.options.projectId ?? this.options.vertexProjectId
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private getConfiguredLocation(): string | undefined {
		const value = this.options.location ?? this.options.vertexRegion
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private async getRequestContext(
		model: string,
		metadata?: ApiHandlerSingleCompletionMetadata,
	): Promise<GeminiRequestContext> {
		throwIfSingleCompletionAborted(metadata)
		return { client: this.client, model }
	}

	private extractStatusCode(error: unknown): number | undefined {
		if (!error || typeof error !== "object") {
			return undefined
		}

		const errorRecord = error as Record<string, unknown>
		const nestedResponse =
			errorRecord.response && typeof errorRecord.response === "object"
				? (errorRecord.response as Record<string, unknown>)
				: undefined

		const possibleStatusValues = [
			errorRecord.status,
			errorRecord.statusCode,
			errorRecord.code,
			nestedResponse?.status,
		]

		for (const value of possibleStatusValues) {
			if (typeof value === "number" && Number.isFinite(value)) {
				return value
			}

			if (typeof value === "string") {
				const parsed = Number.parseInt(value, 10)
				if (Number.isFinite(parsed)) {
					return parsed
				}
			}
		}

		return undefined
	}

	private formatProviderError(translationKey: string, fallbackPrefix: string, errorMessage: string): string {
		const translated = t(translationKey, { error: errorMessage })
		if (typeof translated === "string" && translated.trim().length > 0) {
			return translated
		}

		return `${fallbackPrefix}: ${errorMessage}`
	}

	private wrapProviderError(error: Error, translationKey: string, fallbackPrefix: string): Error {
		const wrapped = new Error(this.formatProviderError(translationKey, fallbackPrefix, error.message))
		const source = error as Error & {
			status?: unknown
			statusCode?: unknown
			code?: unknown
			errorDetails?: unknown
			retryAfterMs?: unknown
			retryable?: unknown
			retryCategory?: unknown
		}
		const target = wrapped as Error & Record<string, unknown>

		for (const key of ["code", "errorDetails", "retryAfterMs", "retryable", "retryCategory"] as const) {
			if (source[key] !== undefined) target[key] = source[key]
		}

		const status = this.extractStatusCode(error)
		if (status !== undefined) {
			target.status = status
			target.statusCode = status
		}

		if (status === 429) {
			target.retryable = source.retryable === false ? false : true
			target.retryCategory = "rate-limit"
		}

		return wrapped
	}

	private getNoVisibleContentMessage(finishReason: string): string {
		switch (finishReason) {
			case "MAX_TOKENS":
				return t("common:errors.gemini.thinking_complete_truncated")
			case "SAFETY":
			case "IMAGE_SAFETY":
			case "PROHIBITED_CONTENT":
			case "SPII":
			case "BLOCKLIST":
			case "IMAGE_PROHIBITED_CONTENT":
				return t("common:errors.gemini.thinking_complete_safety")
			case "RECITATION":
				return t("common:errors.gemini.thinking_complete_recitation")
			case "STOP":
				return t("common:errors.gemini.thinking_complete_no_output")
			default:
				return `${t("common:errors.gemini.thinking_complete_no_output")} Finish reason: ${finishReason}.`
		}
	}

	private resolveMaxOutputTokens(
		info: ModelInfo,
		maxTokens: number | undefined,
		thinkingConfig: GenerateContentConfig["thinkingConfig"],
	): number | undefined {
		// Budget models consume their configured cap; other models ignore stale budget preferences.
		const isHybridReasoningModel = info.supportsReasoningBudget || info.requiredReasoningBudget
		return isHybridReasoningModel
			? (validateOptionalOutputTokenLimit(this.options.modelMaxTokens) ??
					validateOptionalOutputTokenLimit(maxTokens) ??
					(thinkingConfig ? DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS : undefined))
			: validateOptionalOutputTokenLimit(maxTokens)
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: model, info, reasoning: thinkingConfig, maxTokens } = this.getModel()
		const { systemInstructions, userContext } = getProviderInstructionParts(
			systemInstruction,
			metadata?.instructionFragments,
		)
		// Reset per-request metadata that we persist into apiConversationHistory.
		this.lastThoughtSignature = undefined
		this.lastResponseId = undefined

		const maxOutputTokens = this.resolveMaxOutputTokens(info, maxTokens, thinkingConfig)

		// Gemini 3 validates thought signatures for tool/function calling steps.
		// We must round-trip the signature when tools are in use, even if the user chose
		// a minimal thinking level (or thinkingConfig is otherwise absent).
		const includeThoughtSignatures = Boolean(thinkingConfig) || Boolean(metadata?.tools?.length)

		// The message list can include provider-specific meta entries such as
		// `{ type: "reasoning", ... }` that are intended only for providers like
		// openai-native. Gemini should never see those; they are not valid
		// Anthropic.MessageParam values and will cause failures (e.g. missing
		// `content` for the converter). Filter them out here.
		type ReasoningMetaLike = { type?: string }

		const geminiMessages = messages.filter((message): message is Anthropic.Messages.MessageParam => {
			const meta = message as ReasoningMetaLike
			if (meta.type === "reasoning") {
				return false
			}
			return true
		})
		const requestMessages = prependUserInstructionContext(geminiMessages, userContext)

		const contents = convertAnthropicMessagesToGemini(requestMessages, { includeThoughtSignatures, modelId: model })

		// Google built-in tools (Grounding, URL Context) are mutually exclusive
		// with function declarations in the Gemini API, so we always use
		// function declarations when tools are provided.
		const tools: GenerateContentConfig["tools"] = metadata?.tools?.length
			? [
					{
						functionDeclarations: metadata.tools.map((tool) => {
							if (tool.type !== "function")
								throw new Error("Gemini accepts only function tool definitions.")
							return {
								name: tool.function.name,
								description: tool.function.description,
								parametersJsonSchema: tool.function.parameters,
							}
						}),
					},
				]
			: []

		const { supportsTemperature } = resolveModelParameterApplicability({
			provider: this.transportProvider,
			modelId: model,
			model: info,
			settings: this.options,
		})
		const temperatureConfig = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: undefined

		const config: GenerateContentConfig = {
			systemInstruction: systemInstructions,
			thinkingConfig,
			maxOutputTokens,
			...(temperatureConfig !== undefined ? { temperature: temperatureConfig } : {}),
			...(tools.length > 0 ? { tools } : {}),
		}

		// Handle allowedFunctionNames for mode-restricted tool access.
		// When provided, all tool definitions are passed to the model (so it can reference
		// historical tool calls in conversation), but only the specified tools can be invoked.
		// This takes precedence over tool_choice to ensure mode restrictions are honored.
		if (metadata?.tool_choice === "none" || metadata?.allowedFunctionNames?.length === 0) {
			config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } }
		} else if (metadata?.allowedFunctionNames && metadata.allowedFunctionNames.length > 0) {
			config.toolConfig = {
				functionCallingConfig: {
					// VALIDATED restricts function calls to the allowed set while still
					// allowing natural-language responses when a tool is not appropriate.
					mode: FunctionCallingConfigMode.VALIDATED,
					allowedFunctionNames: metadata.allowedFunctionNames,
				},
			}
		} else if (metadata?.tool_choice) {
			const choice = metadata.tool_choice
			let mode: FunctionCallingConfigMode
			let allowedFunctionNames: string[] | undefined

			if (choice === "auto") {
				mode = FunctionCallingConfigMode.AUTO
			} else if (choice === "required") {
				// "required" means the model must call at least one tool; Gemini uses ANY for this.
				mode = FunctionCallingConfigMode.ANY
			} else if (typeof choice === "object" && "function" in choice && choice.type === "function") {
				mode = FunctionCallingConfigMode.ANY
				allowedFunctionNames = [choice.function.name]
			} else {
				// Fall back to AUTO for unknown values to avoid unintentionally broadening tool access.
				mode = FunctionCallingConfigMode.AUTO
			}

			config.toolConfig = {
				functionCallingConfig: {
					mode,
					...(allowedFunctionNames ? { allowedFunctionNames } : {}),
				},
			}
		}
		const requestTimeoutMs = getApiRequestTimeout()

		metadata?.signal?.throwIfAborted()
		const requestContext = await this.getRequestContext(model)
		metadata?.signal?.throwIfAborted()
		// Both Google routes require original signed Part boundaries on replay.
		// Custom/older Vertex models can return unsigned calls; the curated native models require a signature.
		// https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures (2026-10-26)
		const responseCapture = new GeminiResponseCapture(model, this.transportProvider === "gemini")
		const requestControl = createLinkedAbortController({
			signal: metadata?.signal,
			deadline: metadata?.deadline,
			deadlineScope: metadata?.deadlineScope,
		})
		const requestAbortController = requestControl.controller
		const throwIfRequestAborted = () => {
			if (!requestControl.signal.aborted) return
			const reason = requestControl.signal.reason
			if (reason instanceof ApiStreamDeadlineError) throw reason
			requestControl.signal.throwIfAborted()
		}
		const awaitRequest = async <T>(operation: PromiseLike<T>, operationName: string): Promise<T> => {
			// Stop or an explicit deadline must settle the read's timer even if the SDK stalls.
			// Codex 16280e19 also drops its per-read idle timeout when the response consumer closes.
			const result = await withApiRequestTimeout(
				raceApiStreamAbort(operation, requestControl.signal),
				operationName,
				requestTimeoutMs,
				() => requestAbortController.abort(new ApiRequestTimeoutError(operationName, requestTimeoutMs ?? 0)),
			)
			throwIfRequestAborted()
			return result as T
		}
		let resultIterator: AsyncIterator<GenerateContentResponse> | undefined
		let streamIteratorCompleted = false
		const streamIdleTimeout = new ApiRequestIdleTimeout(
			`${this.providerName} stream response for ${requestContext.model}`,
			requestTimeoutMs,
			(error) => requestAbortController.abort(error),
		)
		// @google/genai 1.47 retains httpOptions.timeout for the entire SSE body.
		// The owned admission/read timers above and below enforce inactivity;
		// the linked signal preserves explicit caller deadlines and Stop.
		const params: GenerateContentParameters = {
			model: requestContext.model,
			contents,
			config: {
				...config,
				abortSignal: createGenAiAbortSignal(requestControl.signal),
			},
		}

		let emittedAnyStreamChunk = false
		let semanticOutputObserved = false
		let pendingUsage: ApiStreamUsageChunk | undefined
		const captureUsage = (usage: GenerateContentResponseUsageMetadata | undefined) => {
			if (!usage) return
			const inputTokens = usage.promptTokenCount ?? 0
			const candidateTokens = usage.candidatesTokenCount ?? 0
			const cacheReadTokens = usage.cachedContentTokenCount
			const reasoningTokens = usage.thoughtsTokenCount
			pendingUsage = {
				type: "usage",
				inputTokens,
				outputTokens: candidateTokens + (reasoningTokens ?? 0),
				cacheReadTokens,
				reasoningTokens,
				totalCost: this.calculateCost({
					info,
					inputTokens,
					outputTokens: candidateTokens,
					cacheReadTokens,
					reasoningTokens,
				}),
			}
		}
		const takeUsage = () => {
			const usage = pendingUsage
			pendingUsage = undefined
			return usage
		}

		try {
			throwIfRequestAborted()
			if (this.transportProvider === "vertex" && this.options.vertexStreamingEnabled === false) {
				const result = await awaitRequest(
					requestContext.client.models.generateContent(params),
					`${this.providerName} request for ${requestContext.model}`,
				)
				captureUsage(result.usageMetadata)

				let toolCallCounter = 0
				let hasContent = false
				const candidate = result.candidates?.[0]
				const finishReason = getGeminiStopReason(result)

				if (result.responseId) {
					this.lastResponseId = result.responseId
				}

				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts as Array<{
						thought?: boolean
						text?: string
						thoughtSignature?: string
						functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
					}>) {
						throwIfRequestAborted()
						responseCapture.add([part])
						const thoughtSignature = part.thoughtSignature
						if (includeThoughtSignatures && thoughtSignature) {
							this.lastThoughtSignature = thoughtSignature
						}

						if (part.thought) {
							if (part.text) {
								semanticOutputObserved = true
								yield { type: "reasoning", text: part.text }
							}
						} else if (part.functionCall) {
							hasContent = true
							semanticOutputObserved = true
							const callId = part.functionCall.id || `${part.functionCall.name}-${toolCallCounter}`
							const geminiResponse = responseCapture.snapshot()
							yield {
								type: "tool_call",
								id: callId,
								name: part.functionCall.name,
								arguments: JSON.stringify(part.functionCall.args ?? {}),
								...(geminiResponse ? { geminiResponse } : {}),
							}
							throwIfRequestAborted()
							yield { type: "tool_call_end", id: callId }
							toolCallCounter++
						} else if (part.text) {
							hasContent = true
							semanticOutputObserved = true
							yield { type: "text", text: part.text }
						}
					}
				} else if (result.text) {
					hasContent = true
					semanticOutputObserved = true
					yield { type: "text", text: result.text }
				}

				if (candidate?.groundingMetadata) {
					const sources = this.extractGroundingSources(candidate.groundingMetadata)
					if (sources.length > 0) {
						yield { type: "grounding", sources }
					}
				}

				const usage = takeUsage()
				if (usage) yield usage

				if (!hasContent && finishReason) {
					yield { type: "text", text: this.getNoVisibleContentMessage(finishReason) }
				}

				throwIfRequestAborted()
				const geminiResponse = responseCapture.snapshot()
				if (geminiResponse) yield { type: "reasoning", text: "", geminiResponse }
				throwIfRequestAborted()
				yield createGeminiOutcome(finishReason, semanticOutputObserved, metadata, hasContent)
				return
			}

			const admission = Promise.resolve(requestContext.client.models.generateContentStream(params)).then(
				(result) => {
					const iterator = result[Symbol.asyncIterator]()
					if (requestControl.signal.aborted) {
						closeGeminiIterator(iterator)
						requestControl.signal.throwIfAborted()
					}
					resultIterator = iterator
					return iterator
				},
			)
			const iterator = await awaitRequest(
				admission,
				`${this.providerName} stream request for ${requestContext.model}`,
			)

			let pendingGroundingMetadata: GroundingMetadata | undefined
			let finalResponse: { responseId?: string } | undefined
			let finishReason: string | undefined

			let toolCallCounter = 0
			let hasContent = false

			while (true) {
				throwIfRequestAborted()
				const nextChunk = await streamIdleTimeout.wait(
					raceApiStreamAbort(iterator.next(), requestControl.signal),
				)
				throwIfRequestAborted()

				if (!nextChunk || nextChunk.done) {
					streamIteratorCompleted = true
					break
				}

				const chunk = nextChunk.value
				emittedAnyStreamChunk = true
				// Capture billing before yielding any part: cancellation can interrupt delivery of this same chunk.
				captureUsage(chunk.usageMetadata)

				const stopReason = getGeminiStopReason(chunk)
				if (stopReason) {
					finalResponse = chunk
					finishReason = stopReason
				}
				// Process candidates and their parts to separate thoughts from content
				if (chunk.candidates && chunk.candidates.length > 0) {
					const candidate = chunk.candidates[0]

					if (candidate.groundingMetadata) {
						pendingGroundingMetadata = candidate.groundingMetadata
					}

					if (candidate.content && candidate.content.parts) {
						for (const part of candidate.content.parts as Array<{
							thought?: boolean
							text?: string
							thoughtSignature?: string
							functionCall?: { id?: string; name: string; args: Record<string, unknown> }
						}>) {
							throwIfRequestAborted()
							responseCapture.add([part])
							// Capture thought signatures so they can be persisted into API history.
							const thoughtSignature = part.thoughtSignature
							// Persist thought signatures so they can be round-tripped in the next step.
							// Gemini 3 requires this during tool calling; other Gemini thinking models
							// benefit from it for continuity.
							if (includeThoughtSignatures && thoughtSignature) {
								this.lastThoughtSignature = thoughtSignature
							}

							if (part.thought) {
								// This is a thinking/reasoning part
								if (part.text) {
									semanticOutputObserved = true
									yield { type: "reasoning", text: part.text }
								}
							} else if (part.functionCall) {
								hasContent = true
								semanticOutputObserved = true
								// Gemini sends complete function calls in a single chunk
								// Emit as partial chunks for consistent handling with NativeToolCallParser
								const callId = part.functionCall.id || `${part.functionCall.name}-${toolCallCounter}`
								const args = JSON.stringify(part.functionCall.args ?? {})

								// Emit name first
								yield {
									type: "tool_call_partial",
									index: toolCallCounter,
									id: callId,
									name: part.functionCall.name,
									arguments: undefined,
								}
								throwIfRequestAborted()

								// Then emit arguments
								yield {
									type: "tool_call_partial",
									index: toolCallCounter,
									id: callId,
									name: undefined,
									arguments: args,
								}
								throwIfRequestAborted()
								const geminiResponse = responseCapture.snapshot()
								yield {
									type: "tool_call_end",
									id: callId,
									...(geminiResponse ? { geminiResponse } : {}),
								}

								toolCallCounter++
							} else {
								// This is regular content
								if (part.text) {
									hasContent = true
									semanticOutputObserved = true
									yield { type: "text", text: part.text }
								}
							}
						}
					}
				}

				// Fallback to the original text property if no candidates structure
				else if (chunk.text) {
					hasContent = true
					semanticOutputObserved = true
					yield { type: "text", text: chunk.text }
				}
			}

			if (finalResponse?.responseId) {
				// Capture responseId so Task.addToApiConversationHistory can store it
				// alongside the assistant message in api_history.json.
				this.lastResponseId = finalResponse.responseId
			}

			if (pendingGroundingMetadata) {
				const sources = this.extractGroundingSources(pendingGroundingMetadata)
				if (sources.length > 0) {
					yield { type: "grounding", sources }
				}
			}

			const usage = takeUsage()
			if (usage) yield usage

			if (!hasContent && finishReason) {
				yield { type: "text", text: this.getNoVisibleContentMessage(finishReason) }
			}

			// EOF is transport closure; only STOP is successful provider completion.
			throwIfRequestAborted()
			const geminiResponse = responseCapture.snapshot()
			if (geminiResponse) yield { type: "reasoning", text: "", geminiResponse }
			throwIfRequestAborted()
			yield createGeminiOutcome(finishReason, semanticOutputObserved, metadata, hasContent)
			return
		} catch (error) {
			// Flush observed usage on failure/cancellation, never from finally: consumer return must stay terminal.
			const usage = takeUsage()
			if (usage) yield usage
			if (metadata?.signal?.aborted) {
				throwIfRequestAborted()
				throw error
			}

			if (error instanceof ApiStreamDeadlineError || error instanceof ApiRequestTimeoutError) throw error

			if (error instanceof Error) {
				throw this.wrapProviderError(error, "common:errors.gemini.generate_stream", "Gemini stream error")
			}

			throw error
		} finally {
			streamIdleTimeout.dispose()
			if (resultIterator && !streamIteratorCompleted) {
				// GenAI 1.47.0 releases its reader lock on return without cancelling the SSE body.
				requestAbortController.abort()
				closeGeminiIterator(resultIterator)
			}
			requestControl.dispose()
		}
	}

	abstract override getModel(): {
		id: string
		info: ModelInfo
		maxTokens: number | undefined
		reasoning: GeminiReasoningParams | undefined
	}

	private extractGroundingSources(groundingMetadata?: GroundingMetadata): GroundingSource[] {
		const chunks = groundingMetadata?.groundingChunks

		if (!chunks) {
			return []
		}

		return chunks
			.map((chunk): GroundingSource | null => {
				const uri = chunk.web?.uri
				const title = chunk.web?.title || uri || "Unknown Source"

				if (uri) {
					return {
						title,
						url: uri,
					}
				}
				return null
			})
			.filter((source): source is GroundingSource => source !== null)
	}

	private extractCitationsOnly(groundingMetadata?: GroundingMetadata): string | null {
		const sources = this.extractGroundingSources(groundingMetadata)

		if (sources.length === 0) {
			return null
		}

		const citationLinks = sources.map((source, i) => `[${i + 1}](${source.url})`)
		return citationLinks.join(", ")
	}

	async completePrompt(prompt: string, metadata?: ApiHandlerSingleCompletionMetadata): Promise<string> {
		throwIfSingleCompletionAborted(metadata)
		const { id: model, info, maxTokens, reasoning: thinkingConfig } = this.getModel()
		const requestedMaxOutputTokens = this.resolveMaxOutputTokens(info, maxTokens, thinkingConfig)
		// Argon's single non-streaming GenerateContent hop is capped at 32K. Auxiliary
		// completions do not opt into the SDK's automatic long-decode continuation.
		const maxOutputTokens =
			this.transportProvider === "gemini" && model === "gemini-4-argon" && requestedMaxOutputTokens !== undefined
				? Math.min(requestedMaxOutputTokens, 32_768)
				: requestedMaxOutputTokens
		const requestTimeoutMs = getApiRequestTimeout()

		throwIfSingleCompletionAborted(metadata)
		const requestContext = await awaitSingleCompletion(this.getRequestContext(model, metadata), metadata)
		const requestControl = createLinkedAbortController({ signal: metadata?.signal })

		const { supportsTemperature } = resolveModelParameterApplicability({
			provider: this.transportProvider,
			modelId: model,
			model: info,
			settings: this.options,
		})
		const temperatureConfig = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: undefined

		const promptConfig: GenerateContentConfig = {
			...(this.transportProvider === "gemini" ? { thinkingConfig } : {}),
			httpOptions: requestTimeoutMs ? { timeout: requestTimeoutMs } : undefined,
			abortSignal: createGenAiAbortSignal(requestControl.signal),
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(temperatureConfig !== undefined ? { temperature: temperatureConfig } : {}),
		}

		const request = {
			model: requestContext.model,
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			config: promptConfig,
		}

		try {
			throwIfSingleCompletionAborted(metadata)
			const result = await withApiRequestTimeout(
				awaitSingleCompletion(requestContext.client.models.generateContent(request), {
					signal: requestControl.signal,
				}),
				`${this.providerName} completion request for ${requestContext.model}`,
				requestTimeoutMs,
				() => requestControl.controller.abort(),
			)

			let text = result.text ?? ""

			const candidate = result.candidates?.[0]
			if (
				this.transportProvider === "gemini" &&
				(candidate?.finishReason?.replace(/^FINISH_REASON_/, "") !== "STOP" || !text)
			) {
				throw new Error(
					`Gemini completion did not finish successfully (${candidate?.finishReason ?? "missing finish reason"}).`,
				)
			}
			if (candidate?.groundingMetadata) {
				const citations = this.extractCitationsOnly(candidate.groundingMetadata)
				if (citations) {
					text += `\n\n${t("common:errors.gemini.sources")} ${citations}`
				}
			}

			return text
		} catch (error) {
			throwIfSingleCompletionAborted(metadata)

			if (error instanceof Error) {
				throw this.wrapProviderError(
					error,
					"common:errors.gemini.generate_complete_prompt",
					"Gemini completion error",
				)
			}

			throw error
		} finally {
			requestControl.dispose()
		}
	}

	public getThoughtSignature(): string | undefined {
		return this.lastThoughtSignature
	}

	public getResponseId(): string | undefined {
		return this.lastResponseId
	}

	public calculateCost({
		info,
		inputTokens,
		outputTokens,
		cacheReadTokens = 0,
		reasoningTokens = 0,
	}: {
		info: ModelInfo
		inputTokens: number
		outputTokens: number
		cacheReadTokens?: number
		reasoningTokens?: number
	}) {
		// For models with tiered pricing, prices might only be defined in tiers
		let inputPrice = info.inputPrice
		let outputPrice = info.outputPrice
		let cacheReadsPrice = info.cacheReadsPrice

		// If there's tiered pricing then adjust the input and output token prices
		// based on the input tokens used.
		if (info.tiers) {
			const tier = info.tiers.find((tier) => inputTokens <= tier.contextWindow)

			if (tier) {
				inputPrice = tier.inputPrice ?? inputPrice
				outputPrice = tier.outputPrice ?? outputPrice
				cacheReadsPrice = tier.cacheReadsPrice ?? cacheReadsPrice
			}
		}

		// Check if we have the required prices after considering tiers
		if (!inputPrice || !outputPrice) {
			return undefined
		}

		// cacheReadsPrice is optional - if not defined, treat as 0
		if (!cacheReadsPrice) {
			cacheReadsPrice = 0
		}

		// Subtract the cached input tokens from the total input tokens.
		const uncachedInputTokens = inputTokens - cacheReadTokens

		// Bill both completion and reasoning ("thoughts") tokens as output.
		const billedOutputTokens = outputTokens + reasoningTokens

		let cacheReadCost = cacheReadTokens > 0 ? cacheReadsPrice * (cacheReadTokens / 1_000_000) : 0

		const inputTokensCost = inputPrice * (uncachedInputTokens / 1_000_000)
		const outputTokensCost = outputPrice * (billedOutputTokens / 1_000_000)
		const totalCost = inputTokensCost + outputTokensCost + cacheReadCost

		const trace: Record<string, { price: number; tokens: number; cost: number }> = {
			input: { price: inputPrice, tokens: uncachedInputTokens, cost: inputTokensCost },
			output: { price: outputPrice, tokens: billedOutputTokens, cost: outputTokensCost },
		}

		if (cacheReadTokens > 0) {
			trace.cacheRead = { price: cacheReadsPrice, tokens: cacheReadTokens, cost: cacheReadCost }
		}

		return totalCost
	}
}
