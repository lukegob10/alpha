import { Anthropic } from "@anthropic-ai/sdk"

import { ANTHROPIC_DEFAULT_MAX_TOKENS, type ModelInfo, type ReasoningEffortExtended } from "@alpha-code/types"
import type { ApiHandlerOptions } from "../../shared/api"
import { ApiStream, type ApiStreamUsageChunk, createApiStreamOutcome, isApiStreamAbortError } from "../transform/stream"
import { addCacheBreakpoints } from "../transform/caching/vertex"
import { filterNonAnthropicBlocks } from "../transform/anthropic-filter"
import {
	convertOpenAIToolsToAnthropic,
	convertOpenAIToolChoiceToAnthropic,
} from "../../core/prompts/tools/native-tools/converters"
import { BaseProvider } from "./base-provider"
import type {
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	ApiHandlerSingleCompletionMetadata,
} from "../index"
import { awaitSingleCompletion, throwIfSingleCompletionAborted } from "../transform/single-completion"
import type { ModelToolIdentity } from "./utils/router-tool-preferences"

/** Stable Messages wire additions not yet represented by the pinned SDK. */
export type AnthropicMessageThinking =
	| Anthropic.Messages.ThinkingConfigParam
	| {
			type: "adaptive"
			display: "summarized"
			block_binding: { prefix_mismatch_behavior: "drop_block" }
	  }

export type AnthropicMessageModel = {
	id: string
	info: ModelInfo
	temperature?: number
	maxTokens?: number
	reasoning?: AnthropicMessageThinking
	betas?: string[]
	outputConfig?: { effort: ReasoningEffortExtended }
	toolIdentity?: ModelToolIdentity
	verbosity?: undefined
}

export type AnthropicMessageToolParams = {
	tools?: Anthropic.Tool[]
	tool_choice?: Anthropic.ToolChoice | { type: "none" }
}

export type AnthropicRequestContext = {
	client: { messages: Pick<Anthropic["messages"], "create"> }
	model: string
	requestOptions?: Anthropic.RequestOptions
}

type ProviderInstructionParts = {
	systemInstructions: string
	userContext: string
}

type AnthropicUsageCounters = Pick<
	Anthropic.Usage,
	"input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
>

function createAnthropicUsageAccumulator() {
	const totals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
	return (usage: Partial<AnthropicUsageCounters>): ApiStreamUsageChunk => {
		const delta = (key: keyof AnthropicUsageCounters): number | undefined => {
			const total = usage[key]
			if (typeof total !== "number" || !Number.isSafeInteger(total) || total < totals[key]) return undefined
			const increment = total - totals[key]
			totals[key] = total
			return increment
		}
		// Anthropic message_delta counters are cumulative, including optional
		// input/cache updates. Task and the canonical usage ledger consume deltas;
		// repeated or stale snapshots must not debit usage or lower the baseline.
		return {
			type: "usage",
			inputTokens: delta("input_tokens") ?? 0,
			outputTokens: delta("output_tokens") ?? 0,
			cacheWriteTokens: delta("cache_creation_input_tokens"),
			cacheReadTokens: delta("cache_read_input_tokens"),
		}
	}
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
	if (firstMessage?.role !== "user") {
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

function createAnthropicOutcome(
	stopReason: string | null | undefined,
	terminal: boolean,
	semanticOutputObserved: boolean,
	metadata?: ApiHandlerCreateMessageMetadata,
	hasUnterminatedToolCall = false,
	hasIncompleteThinking = false,
) {
	let reason: string | undefined
	if (!terminal) {
		reason = "Anthropic response ended before message_stop."
	} else if (stopReason === "max_tokens") {
		reason = "Anthropic response reached the output token limit (stop_reason=max_tokens)."
	} else if (stopReason === "model_context_window_exceeded") {
		reason = "Anthropic response reached the model context window limit."
	} else if (hasUnterminatedToolCall) {
		reason = "Anthropic response stopped before its streamed tool call was complete."
	} else if (hasIncompleteThinking) {
		reason = "Anthropic response stopped before its thinking block was complete and signed."
	} else if (!stopReason) {
		reason = "Anthropic response did not include a terminal stop reason."
	} else if (
		stopReason !== "end_turn" &&
		stopReason !== "stop_sequence" &&
		stopReason !== "tool_use" &&
		stopReason !== "refusal" &&
		stopReason !== "pause_turn"
	) {
		reason = `Anthropic response ended with an unrecognized stop reason (${stopReason}).`
	}

	return createApiStreamOutcome({
		status: reason ? "incomplete" : "completed",
		terminal,
		semanticOutputObserved,
		...(reason ? { reason, retryable: !terminal && !semanticOutputObserved } : {}),
		...(!reason && stopReason === "pause_turn" ? { requiresContinuation: true } : {}),
		requestId: metadata?.requestId,
		attemptId: metadata?.attemptId,
	})
}

/** Shared Messages protocol; transport adapters own authentication and model capabilities. */
export abstract class AnthropicMessageHandler extends BaseProvider implements SingleCompletionHandler {
	readonly streamCapabilities = { lifecycle: true } as const
	private lastThoughtSignature?: string

	constructor(protected options: ApiHandlerOptions) {
		super()
	}

	abstract override getModel(): AnthropicMessageModel

	protected abstract getRequestContext(
		model: string,
		metadata?: ApiHandlerSingleCompletionMetadata,
	): Promise<AnthropicRequestContext>

	protected shouldRetryWithRefreshedGatewayToken(_error: unknown): Promise<boolean> {
		return Promise.resolve(false)
	}

	protected getToolChoiceForRequest(
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiHandlerCreateMessageMetadata["tool_choice"] {
		return metadata?.tool_choice
	}

	protected isStreamingEnabled(): boolean {
		return true
	}

	protected getNativeToolParams(metadata?: ApiHandlerCreateMessageMetadata): AnthropicMessageToolParams {
		return {
			tools: convertOpenAIToolsToAnthropic(metadata?.tools ?? []),
			tool_choice: convertOpenAIToolChoiceToAnthropic(
				this.getToolChoiceForRequest(metadata),
				metadata?.parallelToolCalls,
			),
		}
	}

	protected getCompletionError(error: Error): Error {
		return error
	}

	protected getCompletionText(response: Anthropic.Messages.Message): string {
		return response.content
			.filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
			.map((block) => block.text)
			.join("")
	}

	getThoughtSignature(): string | undefined {
		return this.lastThoughtSignature
	}

	private mergeRequestOptions(
		baseRequestOptions: Anthropic.RequestOptions | undefined,
		overrideRequestOptions: Anthropic.RequestOptions | undefined,
		signal?: AbortSignal,
	): Anthropic.RequestOptions | undefined {
		if (!baseRequestOptions && !overrideRequestOptions && !signal) {
			return undefined
		}

		const mergedHeaders =
			baseRequestOptions?.headers || overrideRequestOptions?.headers
				? {
						...(baseRequestOptions?.headers ?? {}),
						...(overrideRequestOptions?.headers ?? {}),
					}
				: undefined

		return {
			...(baseRequestOptions ?? {}),
			...(overrideRequestOptions ?? {}),
			...(mergedHeaders ? { headers: mergedHeaders } : {}),
			...(signal ? { signal } : {}),
		}
	}

	private removeCacheControlFromMessages(
		messages: Anthropic.Messages.MessageParam[],
	): Anthropic.Messages.MessageParam[] {
		return messages.map((message) => {
			if (typeof message.content === "string" || !Array.isArray(message.content)) {
				return message
			}

			return {
				...message,
				content: message.content.map((content) => {
					if (!content || typeof content !== "object" || !("cache_control" in content)) {
						return content
					}

					const { cache_control: _cacheControl, ...rest } = content as unknown as Record<string, unknown>
					return rest as unknown as (typeof message.content)[number]
				}),
			}
		})
	}

	private isPromptCachingDisabledError(error: unknown): boolean {
		const message = this.extractErrorMessage(error)
		return (
			/prompt caching has been disabled/i.test(message) ||
			(/cache_control/i.test(message) && /prompt caching/i.test(message))
		)
	}

	private extractErrorMessage(error: unknown): string {
		if (typeof error === "string") {
			return error
		}

		if (error instanceof Error && typeof error.message === "string") {
			return error.message
		}

		try {
			return JSON.stringify(error)
		} catch {
			return String(error)
		}
	}

	private stringifyInitialToolInput(input: unknown): string | undefined {
		if (input == null) {
			return undefined
		}

		if (typeof input === "string") {
			return input.trim() ? input : undefined
		}

		if (typeof input === "object") {
			if (!Array.isArray(input) && Object.keys(input).length === 0) {
				return undefined
			}

			try {
				return JSON.stringify(input)
			} catch {
				return undefined
			}
		}

		return undefined
	}

	private stringifyToolArguments(input: unknown): string {
		return this.stringifyInitialToolInput(input) ?? "{}"
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.lastThoughtSignature = undefined
		let { id, info, temperature, maxTokens, reasoning: thinking, betas, outputConfig } = this.getModel()

		const { supportsPromptCache } = info
		const { systemInstructions, userContext } = getProviderInstructionParts(
			systemPrompt,
			metadata?.instructionFragments,
		)

		// Filter out non-Anthropic blocks (reasoning, thoughtSignature, etc.) before sending to the API
		const sanitizedMessages = filterNonAnthropicBlocks(messages)
		const requestMessages = prependUserInstructionContext(sanitizedMessages, userContext)

		const nativeToolParams = this.getNativeToolParams(metadata)
		const uncachedMessages = this.removeCacheControlFromMessages(requestMessages)

		const betaRequestOptions: Anthropic.RequestOptions | undefined = betas?.length
			? { headers: { "anthropic-beta": betas.join(",") } }
			: undefined
		let didRetryForGatewayAuth = false
		let didRetryWithoutPromptCache = false
		let usePromptCache = supportsPromptCache

		while (true) {
			const requestContext = await this.getRequestContext(id)

			/**
			 * Vertex API has specific limitations for prompt caching:
			 * 1. Maximum of 4 blocks can have cache_control
			 * 2. Only text blocks can be cached (images and other content types cannot)
			 * 3. Cache control can only be applied to user messages, not assistant messages
			 *
			 * Our caching strategy:
			 * - Cache privileged system instructions (1 block)
			 * - Cache the last text block of the second-to-last user message (1 block)
			 * - Cache the last text block of the last user message (1 block)
			 * This ensures we stay under the 4-block limit while maintaining effective caching
			 * for the most relevant context.
			 */
			const params = {
				model: id,
				max_tokens: maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
				...(temperature !== undefined ? { temperature } : {}),
				thinking,
				...(outputConfig ? { output_config: outputConfig } : {}),
				system: usePromptCache
					? [{ text: systemInstructions, type: "text" as const, cache_control: { type: "ephemeral" } }]
					: systemInstructions,
				messages: usePromptCache ? addCacheBreakpoints(requestMessages) : uncachedMessages,
				...nativeToolParams,
			}

			const requestParams = {
				...params,
				model: requestContext.model,
				stream: this.isStreamingEnabled(),
			}
			const requestOptions = this.mergeRequestOptions(
				betaRequestOptions,
				requestContext.requestOptions,
				metadata?.signal,
			)
			let emittedAnyStreamChunk = false
			let semanticOutputObserved = false
			let stopReason: string | null | undefined
			const accumulateUsage = createAnthropicUsageAccumulator()
			const activeThinkingBlocks = new Map<
				number,
				{ type: "thinking"; signature?: string } | { type: "redacted_thinking"; data: string }
			>()
			let hasIncompleteThinking = false
			let lastCompletedThoughtSignature: string | undefined
			const activeToolUseBlocks = new Map<
				number,
				{
					id: string
					initialArguments?: string
					sawInputJsonDelta: boolean
				}
			>()

			try {
				if (requestParams.stream === false) {
					const response = await requestContext.client.messages.create(
						requestParams as Anthropic.Messages.MessageCreateParamsNonStreaming,
						requestOptions,
					)

					if (response.usage) {
						yield accumulateUsage(response.usage)
					}

					for (const [index, block] of response.content.entries()) {
						switch (block.type) {
							case "text": {
								semanticOutputObserved ||= Boolean(block.text)
								yield { type: "text", text: block.text, outputIndex: index }
								break
							}
							case "thinking": {
								semanticOutputObserved = true
								hasIncompleteThinking ||= !block.signature
								lastCompletedThoughtSignature = block.signature || undefined
								yield {
									type: "reasoning",
									text: block.thinking,
									signature: block.signature,
									outputIndex: index,
								}
								break
							}
							case "redacted_thinking": {
								semanticOutputObserved = true
								yield { type: "reasoning", text: "", redactedData: block.data, outputIndex: index }
								break
							}
							case "tool_use": {
								semanticOutputObserved = true
								const toolUseBlock = block as Anthropic.Messages.ToolUseBlock & { input?: unknown }
								yield {
									type: "tool_call",
									id: toolUseBlock.id,
									name: toolUseBlock.name,
									arguments: this.stringifyToolArguments(toolUseBlock.input),
									outputIndex: index,
								}
								yield { type: "tool_call_end", id: toolUseBlock.id }
								break
							}
						}
					}

					const outcome = createAnthropicOutcome(
						response.stop_reason,
						true,
						semanticOutputObserved,
						metadata,
						false,
						hasIncompleteThinking,
					)
					if (outcome.status === "completed") this.lastThoughtSignature = lastCompletedThoughtSignature
					yield outcome
					return
				}

				const stream = await requestContext.client.messages.create(
					requestParams as Anthropic.Messages.MessageCreateParamsStreaming,
					requestOptions,
				)

				for await (const chunk of stream) {
					emittedAnyStreamChunk = true

					switch (chunk.type) {
						case "message_start": {
							yield accumulateUsage(chunk.message.usage)
							break
						}
						case "message_delta": {
							stopReason = chunk.delta?.stop_reason ?? stopReason
							yield accumulateUsage(chunk.usage)

							break
						}
						case "message_stop": {
							metadata?.signal?.throwIfAborted()
							const outcome = createAnthropicOutcome(
								stopReason,
								true,
								semanticOutputObserved,
								metadata,
								activeToolUseBlocks.size > 0,
								hasIncompleteThinking || activeThinkingBlocks.size > 0,
							)
							if (outcome.status === "completed")
								this.lastThoughtSignature = lastCompletedThoughtSignature
							yield outcome
							return
						}
						case "content_block_start": {
							switch (chunk.content_block!.type) {
								case "text": {
									semanticOutputObserved ||= Boolean(chunk.content_block.text)
									yield { type: "text", text: chunk.content_block.text, outputIndex: chunk.index }
									break
								}
								case "thinking": {
									semanticOutputObserved = true
									activeThinkingBlocks.set(chunk.index, {
										type: "thinking",
										signature: chunk.content_block.signature || undefined,
									})
									yield {
										type: "reasoning",
										text: chunk.content_block.thinking,
										outputIndex: chunk.index,
									}
									break
								}
								case "redacted_thinking": {
									semanticOutputObserved = true
									activeThinkingBlocks.set(chunk.index, {
										type: "redacted_thinking",
										data: chunk.content_block.data,
									})
									break
								}
								case "tool_use": {
									semanticOutputObserved = true
									const toolUseBlock = chunk.content_block as Anthropic.Messages.ToolUseBlock & {
										input?: unknown
									}
									const index = chunk.index!
									activeToolUseBlocks.set(index, {
										id: toolUseBlock.id,
										initialArguments: this.stringifyInitialToolInput(toolUseBlock.input),
										sawInputJsonDelta: false,
									})

									// Emit initial tool call partial with id and name
									yield {
										type: "tool_call_partial",
										index,
										id: toolUseBlock.id,
										name: toolUseBlock.name,
										arguments: undefined,
									}
									break
								}
							}

							break
						}
						case "content_block_delta": {
							switch (chunk.delta!.type) {
								case "text_delta": {
									semanticOutputObserved ||= Boolean(chunk.delta.text)
									yield { type: "text", text: chunk.delta.text, outputIndex: chunk.index }
									break
								}
								case "thinking_delta": {
									semanticOutputObserved ||= Boolean(chunk.delta.thinking)
									yield { type: "reasoning", text: chunk.delta.thinking, outputIndex: chunk.index }
									break
								}
								case "signature_delta": {
									const block = activeThinkingBlocks.get(chunk.index)
									if (block?.type === "thinking") block.signature = chunk.delta.signature
									break
								}
								case "input_json_delta": {
									semanticOutputObserved ||= Boolean(chunk.delta.partial_json)
									const activeToolUseBlock = activeToolUseBlocks.get(chunk.index!)
									if (activeToolUseBlock) {
										activeToolUseBlock.sawInputJsonDelta = true
									}

									// Emit tool call partial chunks as arguments stream in
									yield {
										type: "tool_call_partial",
										index: chunk.index,
										id: undefined,
										name: undefined,
										arguments: chunk.delta.partial_json,
									}
									break
								}
							}

							break
						}
						case "content_block_stop": {
							const thinkingBlock = activeThinkingBlocks.get(chunk.index)
							if (thinkingBlock?.type === "thinking") {
								if (thinkingBlock.signature) {
									lastCompletedThoughtSignature = thinkingBlock.signature
									yield {
										type: "thinking_complete",
										signature: thinkingBlock.signature,
										outputIndex: chunk.index,
									}
								} else {
									hasIncompleteThinking = true
								}
							} else if (thinkingBlock?.type === "redacted_thinking") {
								yield {
									type: "reasoning",
									text: "",
									redactedData: thinkingBlock.data,
									outputIndex: chunk.index,
								}
							}
							activeThinkingBlocks.delete(chunk.index)
							const activeToolUseBlock = activeToolUseBlocks.get(chunk.index!)
							if (activeToolUseBlock) {
								if (!activeToolUseBlock.sawInputJsonDelta && activeToolUseBlock.initialArguments) {
									yield {
										type: "tool_call_partial",
										index: chunk.index,
										id: undefined,
										name: undefined,
										arguments: activeToolUseBlock.initialArguments,
									}
								}

								yield {
									type: "tool_call_end",
									id: activeToolUseBlock.id,
								}
								activeToolUseBlocks.delete(chunk.index!)
							}

							break
						}
					}
				}

				metadata?.signal?.throwIfAborted()
				// A stop reason alone cannot replace the protocol's final message_stop event.
				yield createAnthropicOutcome(stopReason, false, semanticOutputObserved, metadata)
				return
			} catch (error) {
				if (isApiStreamAbortError(error, metadata?.signal)) {
					throw error
				}

				if (
					!didRetryForGatewayAuth &&
					!emittedAnyStreamChunk &&
					(await this.shouldRetryWithRefreshedGatewayToken(error))
				) {
					didRetryForGatewayAuth = true
					continue
				}

				if (
					!didRetryWithoutPromptCache &&
					!emittedAnyStreamChunk &&
					usePromptCache &&
					this.isPromptCachingDisabledError(error)
				) {
					didRetryWithoutPromptCache = true
					usePromptCache = false
					continue
				}

				throw error
			}
		}
	}

	async completePrompt(prompt: string, metadata?: ApiHandlerSingleCompletionMetadata) {
		throwIfSingleCompletionAborted(metadata)
		try {
			let {
				id,
				info: { supportsPromptCache },
				temperature,
				maxTokens = ANTHROPIC_DEFAULT_MAX_TOKENS,
				reasoning: thinking,
				betas,
				outputConfig,
			} = this.getModel()

			let didRetryForGatewayAuth = false
			let didRetryWithoutPromptCache = false
			let usePromptCache = supportsPromptCache

			while (true) {
				throwIfSingleCompletionAborted(metadata)
				const requestContext = await awaitSingleCompletion(this.getRequestContext(id, metadata), metadata)

				const params = {
					model: id,
					max_tokens: maxTokens,
					...(temperature !== undefined ? { temperature } : {}),
					thinking,
					...(outputConfig ? { output_config: outputConfig } : {}),
					messages: [
						{
							role: "user",
							content: usePromptCache
								? [{ type: "text" as const, text: prompt, cache_control: { type: "ephemeral" } }]
								: prompt,
						},
					],
					stream: false,
				}

				const requestParams = {
					...params,
					model: requestContext.model,
				}

				try {
					throwIfSingleCompletionAborted(metadata)
					const response = await awaitSingleCompletion(
						requestContext.client.messages.create(
							requestParams as Anthropic.Messages.MessageCreateParamsNonStreaming,
							this.mergeRequestOptions(
								betas?.length ? { headers: { "anthropic-beta": betas.join(",") } } : undefined,
								requestContext.requestOptions,
								metadata?.signal,
							),
						),
						metadata,
					)
					return this.getCompletionText(response)
				} catch (error) {
					throwIfSingleCompletionAborted(metadata)
					if (
						!didRetryForGatewayAuth &&
						(await awaitSingleCompletion(this.shouldRetryWithRefreshedGatewayToken(error), metadata))
					) {
						didRetryForGatewayAuth = true
						continue
					}

					if (!didRetryWithoutPromptCache && usePromptCache && this.isPromptCachingDisabledError(error)) {
						didRetryWithoutPromptCache = true
						usePromptCache = false
						continue
					}

					throw error
				}
			}
		} catch (error) {
			throwIfSingleCompletionAborted(metadata)
			if (error instanceof Error) {
				throw this.getCompletionError(error)
			}

			throw error
		}
	}
}
