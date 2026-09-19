import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { type ProviderSettings, type ModelInfo, vertexDefaultModelId } from "@alpha-code/types"

import { ApiStream, type ApiStreamCapabilities, type ApiStreamRequestMetadata } from "./transform/stream"

import {
	VertexHandler,
	AnthropicVertexHandler,
	VertexOpenAiHandler,
	OpenAiHandler,
	VsCodeLmHandler,
	StellarHandler,
} from "./providers"
import { assertSupportedApiProvider } from "../shared/api"
import { FakeAIHandler } from "./providers/fake-ai"

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
}

export interface ApiHandlerCreateMessageMetadata extends ApiStreamRequestMetadata {
	/**
	 * Task ID used for tracking and provider-specific features.
	 */
	taskId: string
	/** Current mode slug for provider-specific tracking. */
	mode?: string
	suppressPreviousResponseId?: boolean
	/**
	 * Controls whether the response should be stored for 30 days in OpenAI's Responses API.
	 * When true (default), responses are stored and can be referenced in future requests
	 * using the previous_response_id for efficient conversation continuity.
	 * Set to false to opt out of response storage for privacy or compliance reasons.
	 * @default true
	 */
	store?: boolean
	/**
	 * Optional array of tool definitions to pass to the model.
	 * For OpenAI-compatible providers, these are ChatCompletionTool definitions.
	 */
	tools?: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * Controls which (if any) tool is called by the model.
	 * Can be "none", "auto", "required", or a specific tool choice.
	 */
	tool_choice?: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]
	/**
	 * Controls whether the model can return multiple tool calls in a single response.
	 * When true (default), parallel tool calls are enabled (OpenAI's parallel_tool_calls=true).
	 * When false, only one tool call is returned per response.
	 */
	parallelToolCalls?: boolean
	/**
	 * Optional array of tool names that the model is allowed to call.
	 * When provided, all tool definitions are passed to the model (so it can reference
	 * historical tool calls), but only the specified tools can actually be invoked.
	 * This is used when switching modes to prevent model errors from missing tool
	 * definitions while still restricting callable tools to the current mode's permissions.
	 * Only applies to providers that support function calling restrictions (e.g., Gemini).
	 */
	allowedFunctionNames?: string[]
	/**
	 * Optional provider capability override. Legacy callers/providers omit this
	 * and retain the historical throw/no-terminal behavior; canonical adapters
	 * advertise lifecycle and cancellation explicitly.
	 */
	streamCapabilities?: ApiStreamCapabilities
}

/**
 * Operation-scoped controls for provider token counting. `signal` is terminal:
 * providers must reject when the caller cancels. `remoteDeadline` bounds only
 * native/remote tokenizer waiting, so providers may use a conservative local
 * estimate after it expires without converting caller cancellation to success.
 */
export interface ApiHandlerCountTokensMetadata {
	signal?: AbortSignal
	remoteDeadline?: number | Date
}

export interface ApiHandler {
	/** Additive capability declaration; absent means legacy stream semantics. */
	readonly streamCapabilities?: ApiStreamCapabilities

	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	getModel(): { id: string; info: ModelInfo }

	/** Resolve and retain a dynamic model before a new step captures capabilities and tools. Retries reuse it. */
	prepareModel?(metadata?: ApiStreamRequestMetadata): Promise<void>

	/**
	 * Counts tokens for content blocks
	 * All providers extend BaseProvider which provides a default tiktoken implementation,
	 * but they can override this to use their native token counting endpoints
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	countTokens(
		content: Array<Anthropic.Messages.ContentBlockParam>,
		metadata?: ApiHandlerCountTokensMetadata,
	): Promise<number>
}

export function buildApiHandler(configuration: ProviderSettings): ApiHandler {
	const { apiProvider, ...options } = configuration
	assertSupportedApiProvider(apiProvider)

	// A missing provider is the only configuration that gets a default. Persisted
	// provider identifiers must never silently fall through to a different
	// adapter: doing so can send credentials or requests to an unintended service.
	switch (apiProvider ?? "vertex") {
		case "vertex": {
			const vertexModelId = (options.apiModelId?.trim() || vertexDefaultModelId).toLowerCase()
			if (vertexModelId.includes("claude")) {
				return new AnthropicVertexHandler(options)
			}
			if (vertexModelId.startsWith("gemini")) {
				return new VertexHandler(options)
			}
			return new VertexOpenAiHandler(options)
		}
		case "openai":
			return new OpenAiHandler(options)
		case "vscode-lm":
			return new VsCodeLmHandler(options)
		case "fake-ai":
			return new FakeAIHandler(options)
		case "stellar":
			return new StellarHandler(options)
		default:
			throw new Error(`Unsupported API provider: ${String(apiProvider)}`)
	}
}
