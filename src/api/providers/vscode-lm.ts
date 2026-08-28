import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import OpenAI from "openai"

import {
	type ModelInfo,
	type ProviderSettings,
	openAiModelInfoSaneDefaults,
	getVscodeLlmModelInfo,
	getVscodeLlmExtendedContextSize,
	mergeVscodeLlmModels,
} from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { SELECTOR_SEPARATOR, stringifyVsCodeLmModelSelector } from "../../shared/vsCodeSelectorUtils"
import { normalizeToolSchema } from "../../utils/json-schema"

import { ApiStream } from "../transform/stream"
import {
	convertToVsCodeLmMessages,
	extractTextCountFromMessage,
	isLanguageModelTextPartLike,
	isLanguageModelToolCallPartLike,
} from "../transform/vscode-lm-format"

import { BaseProvider } from "./base-provider"
import { getApiRequestTimeout, withApiRequestTimeout } from "./utils/timeout-config"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"

/**
 * Converts OpenAI-format tools to VSCode Language Model tools.
 * Normalizes the JSON Schema to draft 2020-12 compliant format required by
 * GitHub Copilot's backend, converting type: ["T", "null"] to anyOf format.
 * @param tools Array of OpenAI ChatCompletionTool definitions
 * @returns Array of VSCode LanguageModelChatTool definitions
 */
function convertToVsCodeLmTools(tools: OpenAI.Chat.ChatCompletionTool[]): vscode.LanguageModelChatTool[] {
	return tools
		.filter((tool) => tool.type === "function")
		.map((tool) => ({
			name: tool.function.name,
			description: tool.function.description || "",
			inputSchema: tool.function.parameters
				? normalizeToolSchema(tool.function.parameters as Record<string, unknown>)
				: undefined,
		}))
}

type VsCodeLmModelConfiguration = {
	reasoningEffort?: Exclude<ProviderSettings["reasoningEffort"], undefined | "disable">
	contextSize?: number
}

const VSCODE_GPT_56_MIN_VERSION = "1.128.0"

function isVersionBefore(version: string, minimum: string): boolean {
	const parse = (value: string) =>
		value
			.match(/^\d+(?:\.\d+){0,2}/)?.[0]
			.split(".")
			.map(Number)
	const currentParts = parse(version)
	const minimumParts = parse(minimum)
	if (!currentParts || !minimumParts) {
		return false
	}

	for (let index = 0; index < 3; index++) {
		const current = currentParts[index] ?? 0
		const required = minimumParts[index] ?? 0
		if (current !== required) {
			return current < required
		}
	}

	return false
}

function isGpt56Selector(selector: vscode.LanguageModelChatSelector): boolean {
	return Object.values(selector).some(
		(value) => typeof value === "string" && value.toLowerCase().replace(/[_\s]/g, "-").includes("gpt-5.6"),
	)
}

function getVsCodeLmReasoningEffortOption(
	model: vscode.LanguageModelChat | vscode.LanguageModelChatSelector,
	enableReasoningEffort: boolean | undefined,
	reasoningEffort: ProviderSettings["reasoningEffort"],
): { reasoningEffort: Exclude<ProviderSettings["reasoningEffort"], undefined | "disable"> } | undefined {
	if (!enableReasoningEffort || !reasoningEffort || reasoningEffort === "disable") {
		return undefined
	}

	const supportsReasoningEffort = getVscodeLlmModelInfo(model)?.supportsReasoningEffort
	if (Array.isArray(supportsReasoningEffort) && !supportsReasoningEffort.includes(reasoningEffort)) {
		return undefined
	}

	if (!supportsReasoningEffort) {
		return undefined
	}

	return {
		reasoningEffort,
	}
}

function getVsCodeLmContextSizeOption(
	model: vscode.LanguageModelChat,
	contextSize: ProviderSettings["vsCodeLmContextSize"],
): Pick<VsCodeLmModelConfiguration, "contextSize"> | undefined {
	const modelInfo = getVscodeLlmModelInfo(model)
	const extendedContextSize = getVscodeLlmExtendedContextSize(model)
	if (!modelInfo?.supportsContextWindowConfiguration || !extendedContextSize || !contextSize) {
		return undefined
	}

	if (contextSize === modelInfo.contextWindow) {
		return { contextSize }
	}

	if (contextSize === extendedContextSize) {
		return { contextSize: extendedContextSize }
	}

	return undefined
}

function getVsCodeLmModelConfiguration(
	model: vscode.LanguageModelChat,
	options: ApiHandlerOptions,
): VsCodeLmModelConfiguration | undefined {
	const configuration = {
		...getVsCodeLmReasoningEffortOption(model, options.enableReasoningEffort, options.reasoningEffort),
		...getVsCodeLmContextSizeOption(model, options.vsCodeLmContextSize),
	}

	return Object.keys(configuration).length > 0 ? configuration : undefined
}

function applyVsCodeLmModelConfiguration(
	requestOptions: vscode.LanguageModelChatRequestOptions,
	configuration: VsCodeLmModelConfiguration | undefined,
): void {
	if (!configuration) {
		return
	}

	requestOptions.modelOptions = {
		...(requestOptions.modelOptions ?? {}),
		...configuration,
	}
}

function getVsCodeLmMetadataMimeType(chunk: unknown): string | undefined {
	if (!chunk || typeof chunk !== "object") {
		return undefined
	}

	const mimeType = (chunk as { mimeType?: unknown }).mimeType
	return typeof mimeType === "string" ? mimeType : undefined
}

type VsCodeLmUsage = {
	inputTokens: number
	outputTokens: number
}

function getFiniteUsageValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined
}

function getVsCodeLmUsage(chunk: unknown): VsCodeLmUsage | undefined {
	if (getVsCodeLmMetadataMimeType(chunk) !== "usage") {
		return undefined
	}

	const data = (chunk as { data?: unknown }).data
	if (!(data instanceof Uint8Array)) {
		return undefined
	}

	try {
		const parsed = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>
		const inputTokens = getFiniteUsageValue(
			parsed.prompt_tokens ?? parsed.input_tokens ?? parsed.promptTokens ?? parsed.inputTokens,
		)
		const outputTokens = getFiniteUsageValue(
			parsed.completion_tokens ?? parsed.output_tokens ?? parsed.completionTokens ?? parsed.outputTokens,
		)

		return inputTokens !== undefined && outputTokens !== undefined ? { inputTokens, outputTokens } : undefined
	} catch {
		return undefined
	}
}

function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0
	}

	// UTF-8 bytes account for non-ASCII text more reliably than UTF-16 length.
	// Three bytes per token intentionally errs above the usual English/code ratio.
	return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3))
}

function isLanguageModelChatMessageLike(value: unknown): value is vscode.LanguageModelChatMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"role" in value &&
		"content" in value &&
		Array.isArray((value as { content?: unknown }).content)
	)
}

function estimateVsCodeLmInputTokens(
	messages: vscode.LanguageModelChatMessage[],
	tools: vscode.LanguageModelChatTool[],
): number {
	const serializedMessages = messages
		.map((message) => `${String(message.role)}:${message.name ?? ""}:${extractTextCountFromMessage(message)}`)
		.join("\n")
	const serializedTools = tools.length > 0 ? JSON.stringify(tools) : ""

	return estimateTokens([serializedMessages, serializedTools].filter(Boolean).join("\n"))
}

function isIgnorableVsCodeLmMetadataChunk(chunk: unknown): boolean {
	return getVsCodeLmMetadataMimeType(chunk) === "stateful_marker"
}

function buildVsCodeLmModelInfo(
	client: vscode.LanguageModelChat,
	configuredContextSize?: ProviderSettings["vsCodeLmContextSize"],
): ModelInfo {
	const staticInfo = getVscodeLlmModelInfo(client)
	const liveContextWindow =
		typeof client.maxInputTokens === "number" && Number.isFinite(client.maxInputTokens) && client.maxInputTokens > 0
			? Math.floor(client.maxInputTokens)
			: undefined
	const selectedContextSize = getVsCodeLmContextSizeOption(client, configuredContextSize)?.contextSize
	const configuredOrStaticContextWindow = selectedContextSize ?? staticInfo?.contextWindow ?? liveContextWindow
	const safeContextWindow =
		typeof configuredOrStaticContextWindow === "number" &&
		Number.isFinite(configuredOrStaticContextWindow) &&
		configuredOrStaticContextWindow > 0
			? Math.floor(configuredOrStaticContextWindow)
			: openAiModelInfoSaneDefaults.contextWindow
	const contextWindow = liveContextWindow ? Math.min(safeContextWindow, liveContextWindow) : safeContextWindow

	return {
		...openAiModelInfoSaneDefaults,
		...staticInfo,
		maxTokens: staticInfo?.maxTokens ?? -1,
		contextWindow,
		supportsImages: staticInfo?.supportsImages ?? false,
		supportsPromptCache: staticInfo?.supportsPromptCache ?? true,
		inputPrice: staticInfo?.inputPrice ?? 0,
		outputPrice: staticInfo?.outputPrice ?? 0,
		description: [client.name, client.vendor, client.family, client.version, client.id].filter(Boolean).join(" - "),
	}
}

/**
 * Handles interaction with VS Code's Language Model API for chat-based operations.
 * This handler extends BaseProvider to provide VS Code LM specific functionality.
 *
 * @extends {BaseProvider}
 *
 * @remarks
 * The handler manages a VS Code language model chat client and provides methods to:
 * - Create and manage chat client instances
 * - Stream messages using VS Code's Language Model API
 * - Retrieve model information
 *
 * @example
 * ```typescript
 * const options = {
 *   vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4" }
 * };
 * const handler = new VsCodeLmHandler(options);
 *
 * // Stream a conversation
 * const systemPrompt = "You are a helpful assistant";
 * const messages = [{ role: "user", content: "Hello!" }];
 * for await (const chunk of handler.createMessage(systemPrompt, messages)) {
 *   console.log(chunk);
 * }
 * ```
 */
export class VsCodeLmHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: vscode.LanguageModelChat | null
	private disposables: vscode.Disposable[]
	private currentRequestCancellation: vscode.CancellationTokenSource | null

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.client = null
		this.disposables = []
		this.currentRequestCancellation = null

		try {
			// Listen for model changes and reset client
			this.disposables.push(
				vscode.workspace.onDidChangeConfiguration((event) => {
					if (event.affectsConfiguration("lm")) {
						try {
							this.resetClient()
						} catch (error) {
							console.error("Error during configuration change cleanup:", error)
						}
					}
				}),
			)

			if (vscode.lm.onDidChangeChatModels) {
				this.disposables.push(
					vscode.lm.onDidChangeChatModels(() => {
						this.resetClient()
					}),
				)
			}
		} catch (error) {
			// Ensure cleanup if constructor fails
			this.dispose()

			throw new Error(
				`Alpha <Language Model API>: Failed to initialize handler: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}
	/**
	 * Initializes the VS Code Language Model client.
	 * This method is called during the constructor to set up the client.
	 * This useful when the client is not created yet and call getModel() before the client is created.
	 * @returns Promise<void>
	 * @throws Error when client initialization fails
	 */
	async initializeClient(): Promise<void> {
		try {
			// Check if the client is already initialized
			if (this.client) {
				console.debug("Alpha <Language Model API>: Client already initialized")
				return
			}
			// Create a new client instance
			this.client = await this.createClient(this.options.vsCodeLmModelSelector || {})
			console.debug("Alpha <Language Model API>: Client initialized successfully")
		} catch (error) {
			// Handle errors during client initialization
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error("Alpha <Language Model API>: Client initialization failed:", errorMessage)
			throw new Error(`Alpha <Language Model API>: Failed to initialize client: ${errorMessage}`)
		}
	}
	/**
	 * Creates a language model chat client based on the provided selector.
	 *
	 * @param selector - Selector criteria to filter language model chat instances
	 * @returns Promise resolving to the first matching language model chat instance
	 * @throws Error when no matching models are found with the given selector
	 *
	 * @example
	 * const selector = { vendor: "copilot", family: "gpt-4o" };
	 * const chatClient = await createClient(selector);
	 */
	async createClient(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
		try {
			if (!vscode.lm?.selectChatModels) {
				throw new Error("VS Code Language Model API is not available in this VS Code build.")
			}

			const models = await withApiRequestTimeout(
				vscode.lm.selectChatModels(selector),
				"VS Code LM model selection",
				getApiRequestTimeout(),
			)

			const selectorEntries = Object.entries(selector).filter(
				(entry): entry is [keyof vscode.LanguageModelChatSelector, string] =>
					typeof entry[1] === "string" && entry[1].length > 0,
			)
			const exactMatches = (models ?? []).filter((model) =>
				selectorEntries.every(([key, value]) => model[key] === value),
			)

			if (exactMatches.length === 1) {
				return exactMatches[0]
			}

			if (exactMatches.length > 1) {
				throw new Error(
					`The VS Code language model selector '${stringifyVsCodeLmModelSelector(selector) || "<all models>"}' is ambiguous and matched ${exactMatches.length} models. Choose a model with a unique id.`,
				)
			}

			if (isGpt56Selector(selector) && isVersionBefore(vscode.version, VSCODE_GPT_56_MIN_VERSION)) {
				throw new Error(
					`GPT-5.6 models through the VS Code Language Model API require VS Code ${VSCODE_GPT_56_MIN_VERSION} or newer (current: ${vscode.version}). Update VS Code, then enable the model with 'Chat: Manage Language Models'.`,
				)
			}

			const hasSpecificSelector = selectorEntries.length > 0
			const availableModels = hasSpecificSelector
				? await withApiRequestTimeout(
						vscode.lm.selectChatModels({}),
						"VS Code LM availability check",
						getApiRequestTimeout(),
					)
				: models

			if (!availableModels?.length) {
				throw new Error(
					"No VS Code language models are available in this window. Sign in to GitHub Copilot in this window and enable a model with 'Chat: Manage Language Models'.",
				)
			}

			throw new Error(
				"The selected VS Code language model is not available in this window. Choose one of the models returned in Alpha settings or enable it with 'Chat: Manage Language Models'.",
			)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			throw new Error(`Alpha <Language Model API>: Failed to select model: ${errorMessage}`)
		}
	}

	/**
	 * Creates and streams a message using the VS Code Language Model API.
	 *
	 * @param systemPrompt - The system prompt to initialize the conversation context
	 * @param messages - An array of message parameters following the Anthropic message format
	 * @param metadata - Optional metadata for the message
	 *
	 * @yields {ApiStream} An async generator that yields either text chunks or tool calls from the model response
	 *
	 * @throws {Error} When vsCodeLmModelSelector option is not provided
	 * @throws {Error} When the response stream encounters an error
	 *
	 * @remarks
	 * This method handles the initialization of the VS Code LM client if not already created,
	 * converts the messages to VS Code LM format, and streams the response chunks.
	 * Tool calls handling is currently a work in progress.
	 */
	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables = []

		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
		}
	}

	/**
	 * Implements the ApiHandler countTokens interface method
	 * Provides token counting for Anthropic content blocks
	 *
	 * @param content The content blocks to count tokens for
	 * @returns A promise resolving to the token count
	 */
	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		const [message] = convertToVsCodeLmMessages([{ role: "user", content }])
		return message ? this.internalCountTokens(message) : 0
	}

	/**
	 * Private implementation of token counting used internally by VsCodeLmHandler
	 */
	private async internalCountTokens(text: string | vscode.LanguageModelChatMessage): Promise<number> {
		const fallbackTokens =
			typeof text === "string"
				? estimateTokens(text)
				: isLanguageModelChatMessageLike(text)
					? estimateTokens(extractTextCountFromMessage(text))
					: 1

		// Check for required dependencies
		if (!this.client) {
			console.warn("Alpha <Language Model API>: No client available for token counting")
			return fallbackTokens
		}

		// Validate input
		if (!text || fallbackTokens === 0) {
			console.debug("Alpha <Language Model API>: Empty text provided for token counting")
			return 0
		}

		if (typeof text !== "string" && !isLanguageModelChatMessageLike(text)) {
			console.warn("Alpha <Language Model API>: Invalid input type for token counting")
			return fallbackTokens
		}

		// Token counting can involve the same provider backend as generation. Keep it cancellable,
		// but isolate count-token cancellation from the main request token.
		let cancellationToken: vscode.CancellationToken
		let tempCancellation: vscode.CancellationTokenSource | null = null
		let linkedCancellation: vscode.Disposable | undefined

		tempCancellation = new vscode.CancellationTokenSource()
		cancellationToken = tempCancellation.token

		if (this.currentRequestCancellation) {
			linkedCancellation = this.currentRequestCancellation.token.onCancellationRequested(() => {
				tempCancellation?.cancel()
			})
		}

		try {
			const tokenCount = await withApiRequestTimeout(
				this.client.countTokens(text, cancellationToken),
				"VS Code LM token counting",
				getApiRequestTimeout(),
				() => tempCancellation?.cancel(),
			)

			// Validate the result
			if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount)) {
				console.warn("Alpha <Language Model API>: Non-numeric token count received:", tokenCount)
				return fallbackTokens
			}

			if (tokenCount <= 0) {
				console.warn("Alpha <Language Model API>: Non-positive token count received:", tokenCount)
				return fallbackTokens
			}

			return Math.ceil(tokenCount)
		} catch (error) {
			// Handle specific error types
			if (error instanceof vscode.CancellationError) {
				console.debug("Alpha <Language Model API>: Token counting cancelled by user")
				return fallbackTokens
			}

			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.warn("Alpha <Language Model API>: Token counting failed:", errorMessage)

			// Log additional error details if available
			if (error instanceof Error && error.stack) {
				console.debug("Token counting error stack:", error.stack)
			}

			return fallbackTokens
		} finally {
			// Clean up temporary cancellation token
			linkedCancellation?.dispose()
			if (tempCancellation) {
				tempCancellation.dispose()
			}
		}
	}

	private ensureCleanState(): void {
		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
			this.currentRequestCancellation = null
		}
	}

	private resetClient(): void {
		this.client = null
		this.ensureCleanState()
	}

	private async getClient(): Promise<vscode.LanguageModelChat> {
		if (!this.client) {
			console.debug("Alpha <Language Model API>: Getting client with options:", {
				vsCodeLmModelSelector: this.options.vsCodeLmModelSelector,
				hasOptions: !!this.options,
				selectorKeys: this.options.vsCodeLmModelSelector ? Object.keys(this.options.vsCodeLmModelSelector) : [],
			})

			try {
				// Use default empty selector if none provided to get all available models
				const selector = this.options?.vsCodeLmModelSelector || {}
				console.debug("Alpha <Language Model API>: Creating client with selector:", selector)
				this.client = await this.createClient(selector)
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error"
				console.error("Alpha <Language Model API>: Client creation failed:", message)
				throw new Error(`Alpha <Language Model API>: Failed to create client: ${message}`)
			}
		}

		return this.client
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Ensure clean state before starting a new request
		this.ensureCleanState()
		const client: vscode.LanguageModelChat = await this.getClient()

		// Convert Anthropic messages to VS Code LM messages
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.User(systemPrompt),
			...convertToVsCodeLmMessages(messages),
		]
		const tools = convertToVsCodeLmTools(metadata?.tools ?? [])
		const totalInputTokens = estimateVsCodeLmInputTokens(vsCodeLmMessages, tools)

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Keep a lightweight fallback estimate for providers that do not report usage metadata.
		let accumulatedText: string = ""
		let reportedUsage: VsCodeLmUsage | undefined

		try {
			// Create the response stream with required options
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Alpha would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
			}

			applyVsCodeLmModelConfiguration(requestOptions, getVsCodeLmModelConfiguration(client, this.options))

			if (tools.length > 0) {
				requestOptions.tools = tools
			}

			const response: vscode.LanguageModelChatResponse = await withApiRequestTimeout(
				client.sendRequest(vsCodeLmMessages, requestOptions, this.currentRequestCancellation.token),
				`VS Code LM request for ${client.name}`,
				getApiRequestTimeout(),
				() => this.currentRequestCancellation?.cancel(),
			)

			// Consume the stream and handle both text and tool call chunks
			const responseIterator = response.stream[Symbol.asyncIterator]()

			while (true) {
				const nextChunk = await withApiRequestTimeout(
					responseIterator.next(),
					`VS Code LM response stream for ${client.name}`,
					getApiRequestTimeout(),
					() => this.currentRequestCancellation?.cancel(),
				)

				if (nextChunk.done) {
					break
				}

				const chunk = nextChunk.value
				if (typeof chunk === "string") {
					accumulatedText += chunk
					reportedUsage = undefined
					yield {
						type: "text",
						text: chunk,
					}
				} else if (isLanguageModelTextPartLike(chunk)) {
					// Validate text part value
					if (typeof chunk.value !== "string") {
						console.warn("Alpha <Language Model API>: Invalid text part value received:", chunk.value)
						continue
					}

					accumulatedText += chunk.value
					reportedUsage = undefined
					yield {
						type: "text",
						text: chunk.value,
					}
				} else if (isLanguageModelToolCallPartLike(chunk)) {
					try {
						// Validate tool call parameters
						if (!chunk.name || typeof chunk.name !== "string") {
							console.warn("Alpha <Language Model API>: Invalid tool name received:", chunk.name)
							continue
						}

						if (!chunk.callId || typeof chunk.callId !== "string") {
							console.warn("Alpha <Language Model API>: Invalid tool callId received:", chunk.callId)
							continue
						}

						// Ensure input is a valid object
						if (!chunk.input || typeof chunk.input !== "object") {
							console.warn("Alpha <Language Model API>: Invalid tool input received:", chunk.input)
							continue
						}

						// Log tool call for debugging
						console.debug("Alpha <Language Model API>: Processing tool call:", {
							name: chunk.name,
							callId: chunk.callId,
							inputSize: JSON.stringify(chunk.input).length,
						})

						// Yield native tool_call chunk when tools are provided
						if (metadata?.tools?.length) {
							const argumentsString = JSON.stringify(chunk.input)
							accumulatedText += argumentsString
							reportedUsage = undefined
							yield {
								type: "tool_call",
								id: chunk.callId,
								name: chunk.name,
								arguments: argumentsString,
							}
						}
					} catch (error) {
						console.error("Alpha <Language Model API>: Failed to process tool call:", error)
						// Continue processing other chunks even if one fails
						continue
					}
				} else if (getVsCodeLmMetadataMimeType(chunk) === "usage") {
					const usage = getVsCodeLmUsage(chunk)
					if (usage) {
						reportedUsage = usage
					} else {
						console.debug("Alpha <Language Model API>: Ignoring malformed usage metadata chunk")
					}
				} else if (isIgnorableVsCodeLmMetadataChunk(chunk)) {
					console.debug(
						"Alpha <Language Model API>: Ignoring metadata chunk:",
						getVsCodeLmMetadataMimeType(chunk),
					)
				} else {
					console.warn("Alpha <Language Model API>: Unknown chunk type received:", chunk)
				}
			}

			// VS Code 1.122.1's Copilot provider reports authoritative usage in a terminal
			// LanguageModelDataPart. Avoid re-tokenizing the completed response here: countTokens
			// can call the provider backend and otherwise delays the visible completion boundary.
			yield {
				type: "usage",
				inputTokens: reportedUsage?.inputTokens ?? totalInputTokens,
				outputTokens: reportedUsage?.outputTokens ?? estimateTokens(accumulatedText),
			}
		} catch (error: unknown) {
			this.ensureCleanState()

			if (error instanceof vscode.CancellationError) {
				throw new Error("Alpha <Language Model API>: Request cancelled by user")
			}

			if (error instanceof Error) {
				console.error("Alpha <Language Model API>: Stream error details:", {
					message: error.message,
					stack: error.stack,
					name: error.name,
				})

				// Return original error if it's already an Error instance
				throw error
			} else if (typeof error === "object" && error !== null) {
				// Handle error-like objects
				const errorDetails = JSON.stringify(error, null, 2)
				console.error("Alpha <Language Model API>: Stream error object:", errorDetails)
				throw new Error(`Alpha <Language Model API>: Response stream error: ${errorDetails}`)
			} else {
				// Fallback for unknown error types
				const errorMessage = String(error)
				console.error("Alpha <Language Model API>: Unknown stream error:", errorMessage)
				throw new Error(`Alpha <Language Model API>: Response stream error: ${errorMessage}`)
			}
		} finally {
			this.ensureCleanState()
		}
	}

	// Return model information based on the current client state
	override getModel(): { id: string; info: ModelInfo } {
		if (this.client) {
			// Validate client properties
			const requiredProps = {
				id: this.client.id,
				vendor: this.client.vendor,
				family: this.client.family,
				version: this.client.version,
				maxInputTokens: this.client.maxInputTokens,
			}

			// Log any missing properties for debugging
			for (const [prop, value] of Object.entries(requiredProps)) {
				if (!value && value !== 0) {
					console.warn(`Alpha <Language Model API>: Client missing ${prop} property`)
				}
			}

			// Construct model ID using available information
			const modelParts = [this.client.vendor, this.client.family, this.client.version].filter(Boolean)

			const modelId = this.client.id || modelParts.join(SELECTOR_SEPARATOR)

			const modelInfo = buildVsCodeLmModelInfo(this.client, this.options.vsCodeLmContextSize)

			return { id: modelId, info: modelInfo }
		}

		// Fallback when no client is available
		const fallbackId = this.options.vsCodeLmModelSelector
			? stringifyVsCodeLmModelSelector(this.options.vsCodeLmModelSelector)
			: "vscode-lm"

		console.debug("Alpha <Language Model API>: No client available, using fallback model info")

		return {
			id: fallbackId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: `VSCode Language Model (Fallback): ${fallbackId}`,
			},
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		let cancellation: vscode.CancellationTokenSource | undefined

		try {
			const client = await this.getClient()
			const requestCancellation = new vscode.CancellationTokenSource()
			cancellation = requestCancellation
			const requestOptions: vscode.LanguageModelChatRequestOptions = {}
			applyVsCodeLmModelConfiguration(requestOptions, getVsCodeLmModelConfiguration(client, this.options))
			const response = await withApiRequestTimeout(
				client.sendRequest(
					[vscode.LanguageModelChatMessage.User(prompt)],
					requestOptions,
					requestCancellation.token,
				),
				`VS Code LM completion request for ${client.name}`,
				getApiRequestTimeout(),
				() => requestCancellation.cancel(),
			)
			let result = ""
			const responseIterator = response.stream[Symbol.asyncIterator]()

			while (true) {
				const nextChunk = await withApiRequestTimeout(
					responseIterator.next(),
					`VS Code LM completion stream for ${client.name}`,
					getApiRequestTimeout(),
					() => requestCancellation.cancel(),
				)

				if (nextChunk.done) {
					break
				}

				const chunk = nextChunk.value
				if (typeof chunk === "string") {
					result += chunk
				} else if (isLanguageModelTextPartLike(chunk)) {
					result += chunk.value
				} else if (isIgnorableVsCodeLmMetadataChunk(chunk)) {
					console.debug(
						"Alpha <Language Model API>: Ignoring completion metadata chunk:",
						getVsCodeLmMetadataMimeType(chunk),
					)
				}
			}
			return result
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`VSCode LM completion error: ${error.message}`)
			}
			throw error
		} finally {
			cancellation?.dispose()
		}
	}
}

export async function getVsCodeLmModels() {
	try {
		const models =
			(await withApiRequestTimeout(
				vscode.lm.selectChatModels({}),
				"VS Code LM model list refresh",
				getApiRequestTimeout(),
			)) || []
		// Live selectors are the authority for account-specific routing. Static
		// catalog entries describe capabilities, but must never become clickable
		// when the current VS Code window did not return them.
		return mergeVscodeLlmModels(
			models.map(({ vendor, family, version, id, name, maxInputTokens }) => ({
				vendor,
				family,
				version,
				id,
				name,
				maxInputTokens,
			})),
		)
	} catch (error) {
		console.error(
			`Error fetching VS Code LM models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
		return []
	}
}
