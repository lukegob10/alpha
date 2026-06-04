import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import OpenAI from "openai"

import { type ModelInfo, type ProviderSettings, openAiModelInfoSaneDefaults, vscodeLlmModels } from "@alpha-code/types"

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

function getVsCodeLmReasoningEffortModelOptions(
	enableReasoningEffort: boolean | undefined,
	reasoningEffort: ProviderSettings["reasoningEffort"],
): vscode.LanguageModelChatRequestOptions["modelOptions"] | undefined {
	if (!enableReasoningEffort || !reasoningEffort || reasoningEffort === "disable") {
		return undefined
	}

	return {
		reasoningEffort,
	}
}

function getVsCodeLmMetadataMimeType(chunk: unknown): string | undefined {
	if (!chunk || typeof chunk !== "object") {
		return undefined
	}

	const mimeType = (chunk as { mimeType?: unknown }).mimeType
	return typeof mimeType === "string" ? mimeType : undefined
}

function isIgnorableVsCodeLmMetadataChunk(chunk: unknown): boolean {
	const mimeType = getVsCodeLmMetadataMimeType(chunk)
	return mimeType === "stateful_marker" || mimeType === "usage"
}

function includesCompleteModelId(value: string, modelId: string): boolean {
	let searchFromIndex = 0

	while (searchFromIndex < value.length) {
		const matchIndex = value.indexOf(modelId, searchFromIndex)
		if (matchIndex === -1) {
			return false
		}

		const nextCharacter = value[matchIndex + modelId.length]
		if (!nextCharacter || !/[a-z0-9.-]/i.test(nextCharacter)) {
			return true
		}

		searchFromIndex = matchIndex + modelId.length
	}

	return false
}

function findStaticVsCodeLmModelInfo(
	model: vscode.LanguageModelChat | vscode.LanguageModelChatSelector,
): ModelInfo | undefined {
	const searchableValues = [model.family, model.id, model.version]
		.filter(Boolean)
		.map((value) => value!.toLowerCase())

	for (const [modelId, modelInfo] of Object.entries(vscodeLlmModels)) {
		if (searchableValues.some((value) => value === modelId)) {
			return modelInfo
		}
	}

	const longestModelIdsFirst = Object.entries(vscodeLlmModels).sort(
		([leftModelId], [rightModelId]) => rightModelId.length - leftModelId.length,
	)

	for (const [modelId, modelInfo] of longestModelIdsFirst) {
		if (searchableValues.some((value) => includesCompleteModelId(value, modelId))) {
			return modelInfo
		}
	}

	return undefined
}

function buildVsCodeLmModelInfo(client: vscode.LanguageModelChat): ModelInfo {
	const staticInfo = findStaticVsCodeLmModelInfo(client)

	return {
		...openAiModelInfoSaneDefaults,
		...staticInfo,
		maxTokens: staticInfo?.maxTokens ?? -1,
		contextWindow:
			typeof client.maxInputTokens === "number"
				? Math.max(0, client.maxInputTokens)
				: (staticInfo?.contextWindow ?? openAiModelInfoSaneDefaults.contextWindow),
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

			if (models && Array.isArray(models) && models.length > 0) {
				return models[0]
			}

			throw new Error(
				"No VS Code language models matched the selected provider/model. Open 'Chat: Manage Language Models' and select an available model.",
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
		// Convert Anthropic content blocks to a string for VSCode LM token counting
		let textContent = ""

		for (const block of content) {
			if (block.type === "text") {
				textContent += block.text || ""
			} else if (block.type === "image") {
				// VSCode LM doesn't support images directly, so we'll just use a placeholder
				textContent += "[IMAGE]"
			}
		}

		return this.internalCountTokens(textContent)
	}

	/**
	 * Private implementation of token counting used internally by VsCodeLmHandler
	 */
	private async internalCountTokens(text: string | vscode.LanguageModelChatMessage): Promise<number> {
		// Check for required dependencies
		if (!this.client) {
			console.warn("Alpha <Language Model API>: No client available for token counting")
			return 0
		}

		// Validate input
		if (!text) {
			console.debug("Alpha <Language Model API>: Empty text provided for token counting")
			return 0
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
			// Handle different input types
			let tokenCount: number

			if (typeof text === "string") {
				tokenCount = await withApiRequestTimeout(
					this.client.countTokens(text, cancellationToken),
					"VS Code LM token counting",
					getApiRequestTimeout(),
					() => tempCancellation?.cancel(),
				)
			} else if (text instanceof vscode.LanguageModelChatMessage) {
				// For chat messages, ensure we have content
				if (!text.content || (Array.isArray(text.content) && text.content.length === 0)) {
					console.debug("Alpha <Language Model API>: Empty chat message content")
					return 0
				}
				const countMessage = extractTextCountFromMessage(text)
				tokenCount = await withApiRequestTimeout(
					this.client.countTokens(countMessage, cancellationToken),
					"VS Code LM token counting",
					getApiRequestTimeout(),
					() => tempCancellation?.cancel(),
				)
			} else {
				console.warn("Alpha <Language Model API>: Invalid input type for token counting")
				return 0
			}

			// Validate the result
			if (typeof tokenCount !== "number") {
				console.warn("Alpha <Language Model API>: Non-numeric token count received:", tokenCount)
				return 0
			}

			if (tokenCount < 0) {
				console.warn("Alpha <Language Model API>: Negative token count received:", tokenCount)
				return 0
			}

			return tokenCount
		} catch (error) {
			// Handle specific error types
			if (error instanceof vscode.CancellationError) {
				console.debug("Alpha <Language Model API>: Token counting cancelled by user")
				return 0
			}

			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.warn("Alpha <Language Model API>: Token counting failed:", errorMessage)

			// Log additional error details if available
			if (error instanceof Error && error.stack) {
				console.debug("Token counting error stack:", error.stack)
			}

			return 0 // Fallback to prevent stream interruption
		} finally {
			// Clean up temporary cancellation token
			linkedCancellation?.dispose()
			if (tempCancellation) {
				tempCancellation.dispose()
			}
		}
	}

	private async calculateTotalInputTokens(vsCodeLmMessages: vscode.LanguageModelChatMessage[]): Promise<number> {
		const messageTokens: number[] = await Promise.all(vsCodeLmMessages.map((msg) => this.internalCountTokens(msg)))

		return messageTokens.reduce((sum: number, tokens: number): number => sum + tokens, 0)
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

	private cleanMessageContent(content: any): any {
		if (!content) {
			return content
		}

		if (typeof content === "string") {
			return content
		}

		if (Array.isArray(content)) {
			return content.map((item) => this.cleanMessageContent(item))
		}

		if (typeof content === "object") {
			const cleaned: any = {}
			for (const [key, value] of Object.entries(content)) {
				cleaned[key] = this.cleanMessageContent(value)
			}
			return cleaned
		}

		return content
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Ensure clean state before starting a new request
		this.ensureCleanState()
		const client: vscode.LanguageModelChat = await this.getClient()

		// Process messages
		const cleanedMessages = messages.map((msg) => ({
			...msg,
			content: this.cleanMessageContent(msg.content),
		}))

		// Convert Anthropic messages to VS Code LM messages
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.Assistant(systemPrompt),
			...convertToVsCodeLmMessages(cleanedMessages),
		]

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Calculate input tokens before starting the stream
		const totalInputTokens: number = await this.calculateTotalInputTokens(vsCodeLmMessages)

		// Accumulate the text and count at the end of the stream to reduce token counting overhead.
		let accumulatedText: string = ""

		try {
			// Create the response stream with required options
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Alpha would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
			}
			const modelOptions = getVsCodeLmReasoningEffortModelOptions(
				this.options.enableReasoningEffort,
				this.options.reasoningEffort,
			)
			const tools = convertToVsCodeLmTools(metadata?.tools ?? [])

			if (modelOptions) {
				requestOptions.modelOptions = modelOptions
			}

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
				} else if (isIgnorableVsCodeLmMetadataChunk(chunk)) {
					console.debug(
						"Alpha <Language Model API>: Ignoring metadata chunk:",
						getVsCodeLmMetadataMimeType(chunk),
					)
				} else {
					console.warn("Alpha <Language Model API>: Unknown chunk type received:", chunk)
				}
			}

			// Count tokens in the accumulated text after stream completion
			const totalOutputTokens: number = await this.internalCountTokens(accumulatedText)

			// Report final usage after stream completion
			yield {
				type: "usage",
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
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

			const modelInfo = buildVsCodeLmModelInfo(this.client)

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
			const modelOptions = getVsCodeLmReasoningEffortModelOptions(
				this.options.enableReasoningEffort,
				this.options.reasoningEffort,
			)
			if (modelOptions) {
				requestOptions.modelOptions = modelOptions
			}
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

// Static blacklist of VS Code Language Model IDs that should be excluded from the model list e.g. because they will never work
const VSCODE_LM_STATIC_BLACKLIST: string[] = ["claude-3.7-sonnet", "claude-3.7-sonnet-thought"]

export async function getVsCodeLmModels() {
	try {
		const models =
			(await withApiRequestTimeout(
				vscode.lm.selectChatModels({}),
				"VS Code LM model list refresh",
				getApiRequestTimeout(),
			)) || []
		return models.filter((model) => !VSCODE_LM_STATIC_BLACKLIST.includes(model.id))
	} catch (error) {
		console.error(
			`Error fetching VS Code LM models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
		return []
	}
}
