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

import {
	ApiStream,
	ApiStreamDeadlineError,
	createLinkedAbortController,
	raceApiStreamAbort,
	type LinkedAbortController,
} from "../transform/stream"
import {
	convertToVsCodeLmMessages,
	extractTextCountFromMessage,
	isLanguageModelTextPartLike,
	isLanguageModelToolCallPartLike,
} from "../transform/vscode-lm-format"

import { BaseProvider } from "./base-provider"
import { getApiRequestTimeout, withApiRequestTimeout } from "./utils/timeout-config"
import type { SingleCompletionHandler, ApiHandlerCountTokensMetadata, ApiHandlerCreateMessageMetadata } from "../index"

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

type VsCodeLm122RequestOptions = vscode.LanguageModelChatRequestOptions & {
	/**
	 * VS Code 1.122 forwards this runtime property to Copilot as
	 * `ProvideLanguageModelChatResponseOptions.modelConfiguration`.
	 * Keep `modelOptions` too: it is the stable public request surface.
	 */
	configuration?: VsCodeLmModelConfiguration
}

const VSCODE_GPT_56_MIN_VERSION = "1.128.0"
const VSCODE_LM_STATEFUL_MARKER_MIME_TYPE = "stateful_marker"
const VSCODE_LM_TOKEN_COUNT_TIMEOUT_MS = 5_000
const VSCODE_LM_CLIENT_CACHE_MAX_SETTLED_ENTRIES = 32
const VSCODE_LM_CLIENT_CACHE_MAX_TOTAL_ENTRIES = 64

type VsCodeLmClientCacheEntry = {
	generation: number
	promise: Promise<vscode.LanguageModelChat>
	settled: boolean
}

const vsCodeLmClientCache = new Map<string, VsCodeLmClientCacheEntry>()
let vsCodeLmClientCacheGeneration = 0

function getVsCodeLmClientCacheKey(selector: vscode.LanguageModelChatSelector): string {
	return JSON.stringify([
		selector.vendor ?? null,
		selector.family ?? null,
		selector.version ?? null,
		selector.id ?? null,
	])
}

function invalidateVsCodeLmClientCache(): void {
	vsCodeLmClientCacheGeneration++
	vsCodeLmClientCache.clear()
}

/**
 * Keep selector churn bounded without breaking the single-flight contract. An
 * unresolved selection can still have multiple handlers awaiting it, so pending
 * entries are retained above the settled steady-state cap. A separate hard cap
 * only drops the oldest mapping; it does not cancel or reject existing waiters,
 * which still own the same promise and settle normally.
 */
function trimVsCodeLmClientCache(): void {
	while (vsCodeLmClientCache.size > VSCODE_LM_CLIENT_CACHE_MAX_SETTLED_ENTRIES) {
		const settledEntry = [...vsCodeLmClientCache].find(([, entry]) => entry.settled)
		if (!settledEntry) break
		vsCodeLmClientCache.delete(settledEntry[0])
	}

	while (vsCodeLmClientCache.size > VSCODE_LM_CLIENT_CACHE_MAX_TOTAL_ENTRIES) {
		const oldestKey = vsCodeLmClientCache.keys().next().value
		if (typeof oldestKey !== "string") return
		vsCodeLmClientCache.delete(oldestKey)
	}
}

function getCachedVsCodeLmClient(
	selector: vscode.LanguageModelChatSelector,
	resolve: () => Promise<vscode.LanguageModelChat>,
): Promise<vscode.LanguageModelChat> {
	const key = getVsCodeLmClientCacheKey(selector)
	const cached = vsCodeLmClientCache.get(key)
	if (cached?.generation === vsCodeLmClientCacheGeneration) {
		// Refresh insertion order so settled eviction approximates LRU while an
		// in-flight entry continues to expose the exact same shared promise.
		vsCodeLmClientCache.delete(key)
		vsCodeLmClientCache.set(key, cached)
		return cached.promise
	}

	const generation = vsCodeLmClientCacheGeneration
	let entry: VsCodeLmClientCacheEntry
	let promise: Promise<vscode.LanguageModelChat>
	promise = resolve().then(
		(client) => {
			entry.settled = true
			// VS Code documents that retained clients remain valid until its model-change
			// event. If that event races selection, re-query instead of caching a stale client.
			if (generation !== vsCodeLmClientCacheGeneration) {
				return getCachedVsCodeLmClient(selector, resolve)
			}
			trimVsCodeLmClientCache()
			return client
		},
		(error) => {
			entry.settled = true
			if (vsCodeLmClientCache.get(key)?.promise === promise) {
				vsCodeLmClientCache.delete(key)
			}
			trimVsCodeLmClientCache()
			throw error
		},
	)
	entry = { generation, promise, settled: false }
	vsCodeLmClientCache.set(key, entry)
	trimVsCodeLmClientCache()
	return promise
}

function evictPendingVsCodeLmClient(
	selector: vscode.LanguageModelChatSelector,
	promise: Promise<vscode.LanguageModelChat>,
): void {
	const key = getVsCodeLmClientCacheKey(selector)
	if (vsCodeLmClientCache.get(key)?.promise === promise) {
		vsCodeLmClientCache.delete(key)
	}
}

type VsCodeLmPersistedMessage = Anthropic.Messages.MessageParam & {
	vscodeLmStatefulMarker?: string
}

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

function getVsCodeLmTokenCountTimeout(): number {
	// VS Code 1.122's bundled Copilot provider tokenizes locally in a lazy BPE
	// worker. A multi-second wait is therefore an abnormal bookkeeping stall and
	// must not inherit the much longer generation/stream timeout between turns.
	const configuredTimeout = getApiRequestTimeout()
	return configuredTimeout === undefined
		? VSCODE_LM_TOKEN_COUNT_TIMEOUT_MS
		: Math.min(configuredTimeout, VSCODE_LM_TOKEN_COUNT_TIMEOUT_MS)
}

function getAbsoluteDeadline(value: number | Date | undefined): number | undefined {
	const deadline = value instanceof Date ? value.getTime() : value
	return typeof deadline === "number" && Number.isFinite(deadline) ? deadline : undefined
}

function getAbortSignalReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) {
		return signal.reason
	}

	const error = new Error("The operation was aborted")
	error.name = "AbortError"
	return error
}

type VsCodeLmRequestPhase = "model-selection" | "request-admission" | "first-response-chunk" | "response-stream"

class VsCodeLmRequestDeadlineError extends ApiStreamDeadlineError {
	readonly phase: VsCodeLmRequestPhase

	constructor(phase: VsCodeLmRequestPhase) {
		super(`VS Code LM caller deadline exceeded during ${phase}.`)
		this.phase = phase
	}
}

function getVsCodeLmRequestAbortError(signal: AbortSignal, phase: VsCodeLmRequestPhase): Error {
	return signal.reason instanceof ApiStreamDeadlineError
		? new VsCodeLmRequestDeadlineError(phase)
		: new vscode.CancellationError()
}

function throwIfVsCodeLmRequestAborted(signal: AbortSignal, phase: VsCodeLmRequestPhase): void {
	if (!signal.aborted) {
		return
	}

	throw getVsCodeLmRequestAbortError(signal, phase)
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

	const compatibleRequestOptions = requestOptions as VsCodeLm122RequestOptions
	compatibleRequestOptions.configuration = {
		...(compatibleRequestOptions.configuration ?? {}),
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

type VsCodeLmThinkingPartLike = {
	value: string | string[]
	id?: string
	metadata?: { readonly [key: string]: unknown }
}

/**
 * Thinking parts are still typed as `unknown` on the stable 1.122 response
 * stream, but the bundled Copilot provider emits this exact runtime shape.
 * Check it before the broader `{ value: string }` text-part guard.
 */
function isVsCodeLmThinkingPartLike(chunk: unknown): chunk is VsCodeLmThinkingPartLike {
	if (
		typeof chunk !== "object" ||
		chunk === null ||
		!("value" in chunk) ||
		!("id" in chunk) ||
		!("metadata" in chunk)
	) {
		return false
	}

	const { value, id, metadata } = chunk as { value?: unknown; id?: unknown; metadata?: unknown }
	return (
		(typeof value === "string" || (Array.isArray(value) && value.every((part) => typeof part === "string"))) &&
		(id === undefined || typeof id === "string") &&
		(metadata === undefined || (typeof metadata === "object" && metadata !== null))
	)
}

function getVsCodeLmThinkingText(chunk: VsCodeLmThinkingPartLike): string {
	return typeof chunk.value === "string" ? chunk.value : chunk.value.join("\n")
}

function bridgeAbortSignalToVsCodeCancellation(
	signal: AbortSignal | undefined,
	cancellation: vscode.CancellationTokenSource,
): () => void {
	let disposed = false
	let listenerAttached = false
	const cancelRequest = () => {
		if (!cancellation.token.isCancellationRequested) {
			cancellation.cancel()
		}
	}

	if (signal) {
		if (signal.aborted) {
			cancelRequest()
		} else {
			signal.addEventListener("abort", cancelRequest, { once: true })
			listenerAttached = true
		}
	}

	return () => {
		if (disposed) {
			return
		}
		disposed = true
		if (signal && listenerAttached) {
			signal.removeEventListener("abort", cancelRequest)
		}
	}
}

function closeVsCodeLmResponseIterator(iterator: AsyncIterator<unknown> | undefined): void {
	if (!iterator?.return) {
		return
	}

	try {
		// VS Code 1.122 does not keep request-token RPC cancellation alive after
		// sendRequest resolves. Never await iterator cleanup: a stalled host stream
		// must not delay Task cancellation or follow-up recovery.
		void Promise.resolve(iterator.return()).catch(() => undefined)
	} catch {
		// Cleanup must not mask the request cancellation/error already in flight.
	}
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

/**
 * Token-budget fallback used when the host tokenizer is unavailable. A byte
 * ceiling is deliberately stricter than the usage estimate above: modern
 * tokenizers cannot require more tokens than the UTF-8 byte representation,
 * so this cannot make compaction accept text that the exact counter rejected.
 */
function estimateConservativeTokens(text: string): number {
	if (text.length === 0) return 0
	return Math.max(1, new TextEncoder().encode(text).byteLength)
}

function hasAnthropicImageContent(content: Anthropic.Messages.ContentBlockParam[]): boolean {
	return content.some((block) => {
		if (block.type === "image") {
			return true
		}
		if (block.type !== "tool_result" || !Array.isArray(block.content)) {
			return false
		}
		return block.content.some((part) => part.type === "image")
	})
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

function isVsCodeLmStatefulMarkerChunk(chunk: unknown): boolean {
	return getVsCodeLmMetadataMimeType(chunk) === VSCODE_LM_STATEFUL_MARKER_MIME_TYPE
}

function encodeVsCodeLmStatefulMarker(chunk: unknown): string | undefined {
	if (getVsCodeLmMetadataMimeType(chunk) !== VSCODE_LM_STATEFUL_MARKER_MIME_TYPE) {
		return undefined
	}

	const data = (chunk as { data?: unknown }).data
	return data instanceof Uint8Array && data.length > 0 ? Buffer.from(data).toString("base64") : undefined
}

function decodeVsCodeLmStatefulMarker(value: unknown): Uint8Array | undefined {
	if (typeof value !== "string" || value.length === 0) {
		return undefined
	}

	try {
		const decoded = Buffer.from(value, "base64")
		const normalizedInput = value.replace(/=+$/, "")
		const normalizedDecoded = decoded.toString("base64").replace(/=+$/, "")
		return decoded.length > 0 && normalizedInput === normalizedDecoded ? decoded : undefined
	} catch {
		return undefined
	}
}

function convertToStatefulVsCodeLmMessages(
	messages: Anthropic.Messages.MessageParam[],
): vscode.LanguageModelChatMessage[] {
	return messages.flatMap((message) => {
		const converted = convertToVsCodeLmMessages([message])
		const marker = decodeVsCodeLmStatefulMarker((message as VsCodeLmPersistedMessage).vscodeLmStatefulMarker)

		if (message.role !== "assistant" || !marker || converted.length !== 1) {
			return converted
		}
		const assistantContent = converted[0].content as Array<
			vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
		>

		return [
			vscode.LanguageModelChatMessage.Assistant([
				...assistantContent,
				new vscode.LanguageModelDataPart(marker, VSCODE_LM_STATEFUL_MARKER_MIME_TYPE),
			]),
		]
	})
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
	private currentRequestControl: LinkedAbortController | null
	private currentRequestSignalCleanup: (() => void) | null
	private currentResponseStatefulMarker: string | undefined

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.client = null
		this.disposables = []
		this.currentRequestCancellation = null
		this.currentRequestControl = null
		this.currentRequestSignalCleanup = null
		this.currentResponseStatefulMarker = undefined

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
			await this.getClient()
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
		return this.selectClient(selector, true)
	}

	private async selectClient(
		selector: vscode.LanguageModelChatSelector,
		applyConfiguredTimeout: boolean,
	): Promise<vscode.LanguageModelChat> {
		try {
			if (!vscode.lm?.selectChatModels) {
				throw new Error("VS Code Language Model API is not available in this VS Code build.")
			}

			const selection = vscode.lm.selectChatModels(selector)
			const models = applyConfiguredTimeout
				? await withApiRequestTimeout(selection, "VS Code LM model selection", getApiRequestTimeout())
				: await selection

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
			const availability = hasSpecificSelector ? vscode.lm.selectChatModels({}) : undefined
			const availableModels = availability
				? applyConfiguredTimeout
					? await withApiRequestTimeout(availability, "VS Code LM availability check", getApiRequestTimeout())
					: await availability
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

		this.ensureCleanState()
	}

	/**
	 * Implements the ApiHandler countTokens interface method
	 * Provides token counting for Anthropic content blocks
	 *
	 * @param content The content blocks to count tokens for
	 * @returns A promise resolving to the token count
	 */
	override async countTokens(
		content: Array<Anthropic.Messages.ContentBlockParam>,
		metadata?: ApiHandlerCountTokensMetadata,
	): Promise<number> {
		if (metadata?.signal?.aborted) {
			throw getAbortSignalReason(metadata.signal)
		}

		const [message] = convertToVsCodeLmMessages([{ role: "user", content }])
		// A text fallback can be estimated locally. Media token cost depends on its
		// dimensions, so a failed provider count uses the full selected context as
		// a safety floor rather than silently undercounting and overrunning it.
		const fallbackFloor = hasAnthropicImageContent(content) ? this.getModel().info.contextWindow : 0
		return message ? this.internalCountTokens(message, fallbackFloor, metadata) : 0
	}

	/**
	 * Private implementation of token counting used internally by VsCodeLmHandler
	 */
	private async internalCountTokens(
		text: string | vscode.LanguageModelChatMessage,
		fallbackFloor = 0,
		metadata?: ApiHandlerCountTokensMetadata,
	): Promise<number> {
		const estimatedTokens =
			typeof text === "string"
				? estimateConservativeTokens(text)
				: isLanguageModelChatMessageLike(text)
					? estimateConservativeTokens(extractTextCountFromMessage(text))
					: 1
		const normalizedFallbackFloor =
			Number.isFinite(fallbackFloor) && fallbackFloor > 0 ? Math.ceil(fallbackFloor) : 0
		const fallbackTokens = Math.max(estimatedTokens, normalizedFallbackFloor)
		const useFallback = () => {
			if (metadata?.signal?.aborted) {
				throw getAbortSignalReason(metadata.signal)
			}
			return fallbackTokens
		}

		if (metadata?.signal?.aborted) {
			throw getAbortSignalReason(metadata.signal)
		}

		// Check for required dependencies
		if (!this.client) {
			console.warn("Alpha <Language Model API>: No client available for token counting")
			return useFallback()
		}

		// Validate input
		if (!text || fallbackTokens === 0) {
			console.debug("Alpha <Language Model API>: Empty text provided for token counting")
			return 0
		}

		if (typeof text !== "string" && !isLanguageModelChatMessageLike(text)) {
			console.warn("Alpha <Language Model API>: Invalid input type for token counting")
			return useFallback()
		}

		const remoteDeadline = getAbsoluteDeadline(metadata?.remoteDeadline)
		if (remoteDeadline !== undefined && remoteDeadline <= Date.now()) {
			return useFallback()
		}

		// Token counting can involve the same provider backend as generation. Keep it cancellable,
		// but isolate count-token cancellation from the main request token.
		const tempCancellation = new vscode.CancellationTokenSource()
		const timeoutDeadline = Date.now() + getVsCodeLmTokenCountTimeout()
		const requestControl = createLinkedAbortController({
			signal: metadata?.signal,
			deadline: remoteDeadline === undefined ? timeoutDeadline : Math.min(timeoutDeadline, remoteDeadline),
		})
		const disposeSignalBridge = bridgeAbortSignalToVsCodeCancellation(requestControl.signal, tempCancellation)
		let linkedCancellation: vscode.Disposable | undefined

		if (this.currentRequestCancellation) {
			linkedCancellation = this.currentRequestCancellation.token.onCancellationRequested(() => {
				tempCancellation.cancel()
				if (!requestControl.signal.aborted) {
					requestControl.controller.abort(new vscode.CancellationError())
				}
			})
		}

		try {
			if (metadata?.signal?.aborted) {
				throw getAbortSignalReason(metadata.signal)
			}
			if (remoteDeadline !== undefined && remoteDeadline <= Date.now()) {
				return useFallback()
			}

			const tokenCount = await raceApiStreamAbort(
				this.client.countTokens(text, tempCancellation.token),
				requestControl.signal,
			)

			if (metadata?.signal?.aborted) {
				throw getAbortSignalReason(metadata.signal)
			}
			if (tokenCount === undefined) {
				return useFallback()
			}

			// Validate the result
			if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount)) {
				console.warn("Alpha <Language Model API>: Non-numeric token count received:", tokenCount)
				return useFallback()
			}

			if (tokenCount <= 0) {
				console.warn("Alpha <Language Model API>: Non-positive token count received:", tokenCount)
				return useFallback()
			}

			return Math.ceil(tokenCount)
		} catch (error) {
			if (metadata?.signal?.aborted) {
				throw getAbortSignalReason(metadata.signal)
			}

			// Handle specific error types
			if (error instanceof vscode.CancellationError) {
				console.debug("Alpha <Language Model API>: Token counting cancelled")
				return useFallback()
			}

			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.warn("Alpha <Language Model API>: Token counting failed:", errorMessage)

			// Log additional error details if available
			if (error instanceof Error && error.stack) {
				console.debug("Token counting error stack:", error.stack)
			}

			return useFallback()
		} finally {
			linkedCancellation?.dispose()
			disposeSignalBridge()
			requestControl.dispose()
			tempCancellation.dispose()
		}
	}

	private ensureCleanState(): void {
		const cancellation = this.currentRequestCancellation
		const requestControl = this.currentRequestControl
		const signalCleanup = this.currentRequestSignalCleanup
		this.currentRequestCancellation = null
		this.currentRequestControl = null
		this.currentRequestSignalCleanup = null
		signalCleanup?.()
		if (requestControl) {
			if (!requestControl.signal.aborted) {
				requestControl.controller.abort(new vscode.CancellationError())
			}
			requestControl.dispose()
		}

		if (cancellation) {
			cancellation.cancel()
			cancellation.dispose()
		}
	}

	private resetClient(): void {
		this.client = null
		invalidateVsCodeLmClientCache()
	}

	private resolveConfiguredClient(): Promise<vscode.LanguageModelChat> {
		const selector = this.options.vsCodeLmModelSelector || {}
		// Selection is shared across cold handlers. Each waiter owns its timeout and
		// cancellation below so abandoning one request cannot strand a timer or
		// cancel another handler that is awaiting the same VS Code host operation.
		return getCachedVsCodeLmClient(selector, () => this.selectClient(selector, false))
	}

	private finishRequest(
		cancellation: vscode.CancellationTokenSource,
		requestControl: LinkedAbortController,
		disposeSignalBridge: () => void,
		streamCompleted: boolean,
	): void {
		disposeSignalBridge()
		requestControl.dispose()

		// A superseding request may already have cancelled and disposed this source.
		// Its predecessor must never clear or cancel the new request's source.
		if (this.currentRequestCancellation !== cancellation) {
			return
		}

		this.currentRequestCancellation = null
		this.currentRequestControl = null
		this.currentRequestSignalCleanup = null
		if (!streamCompleted && !cancellation.token.isCancellationRequested) {
			cancellation.cancel()
		}
		cancellation.dispose()
	}

	private async getClient(signal?: AbortSignal): Promise<vscode.LanguageModelChat> {
		if (signal) {
			throwIfVsCodeLmRequestAborted(signal, "model-selection")
		}

		if (!this.client) {
			console.debug("Alpha <Language Model API>: Getting client with options:", {
				vsCodeLmModelSelector: this.options.vsCodeLmModelSelector,
				hasOptions: !!this.options,
				selectorKeys: this.options.vsCodeLmModelSelector ? Object.keys(this.options.vsCodeLmModelSelector) : [],
			})

			// Use default empty selector if none provided to get all available models
			const selector = this.options?.vsCodeLmModelSelector || {}
			const pendingClient = this.resolveConfiguredClient()
			try {
				console.debug("Alpha <Language Model API>: Creating client with selector:", selector)
				const client = await withApiRequestTimeout(
					raceApiStreamAbort(pendingClient, signal),
					"VS Code LM model selection",
					getApiRequestTimeout(),
				)
				if (signal) {
					throwIfVsCodeLmRequestAborted(signal, "model-selection")
				}
				if (!client) {
					throw new vscode.CancellationError()
				}
				this.client = client
			} catch (error) {
				evictPendingVsCodeLmClient(selector, pendingClient)
				if (signal?.aborted) {
					throw getVsCodeLmRequestAbortError(signal, "model-selection")
				}
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
		this.currentResponseStatefulMarker = undefined

		// Own cancellation locally. A previous generator can finish after this one
		// starts, so its cleanup must not dereference and cancel this request.
		const requestControl = createLinkedAbortController(metadata)
		const callerDeadline = getAbsoluteDeadline(metadata?.deadline)
		if (callerDeadline !== undefined && callerDeadline <= Date.now() && !requestControl.signal.aborted) {
			requestControl.controller.abort(new ApiStreamDeadlineError())
		}
		const requestCancellation = new vscode.CancellationTokenSource()
		this.currentRequestCancellation = requestCancellation
		this.currentRequestControl = requestControl
		const disposeSignalBridge = bridgeAbortSignalToVsCodeCancellation(requestControl.signal, requestCancellation)
		this.currentRequestSignalCleanup = disposeSignalBridge
		let streamCompleted = false
		let responseStatefulMarker: string | undefined
		let responseIterator: AsyncIterator<unknown> | undefined
		let requestPhase: VsCodeLmRequestPhase = "model-selection"

		// Keep response parts for providers that do not report terminal usage metadata.
		// Joining once avoids quadratic concatenation during long streamed responses.
		const accumulatedText: string[] = []
		let reportedUsage: VsCodeLmUsage | undefined

		try {
			throwIfVsCodeLmRequestAborted(requestControl.signal, requestPhase)

			const client: vscode.LanguageModelChat = await this.getClient(requestControl.signal)
			throwIfVsCodeLmRequestAborted(requestControl.signal, requestPhase)

			// Convert Anthropic messages to VS Code LM messages
			const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
				vscode.LanguageModelChatMessage.User(systemPrompt),
				...convertToStatefulVsCodeLmMessages(messages),
			]
			const tools = convertToVsCodeLmTools(metadata?.tools ?? [])
			// Create the response stream with required options
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Alpha would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
			}

			applyVsCodeLmModelConfiguration(requestOptions, getVsCodeLmModelConfiguration(client, this.options))

			if (tools.length > 0) {
				requestOptions.tools = tools
			}

			requestPhase = "request-admission"
			throwIfVsCodeLmRequestAborted(requestControl.signal, requestPhase)
			const response = await withApiRequestTimeout(
				raceApiStreamAbort(
					client.sendRequest(vsCodeLmMessages, requestOptions, requestCancellation.token),
					requestControl.signal,
				),
				`VS Code LM request for ${client.name}`,
				getApiRequestTimeout(),
				() => requestCancellation.cancel(),
			)
			throwIfVsCodeLmRequestAborted(requestControl.signal, requestPhase)
			if (!response) {
				throw new vscode.CancellationError()
			}

			// Consume the stream and handle both text and tool call chunks
			responseIterator = response.stream[Symbol.asyncIterator]()
			requestPhase = "first-response-chunk"

			while (true) {
				throwIfVsCodeLmRequestAborted(requestControl.signal, requestPhase)
				const nextChunk = await withApiRequestTimeout(
					raceApiStreamAbort(responseIterator.next(), requestControl.signal),
					`VS Code LM response stream for ${client.name}`,
					getApiRequestTimeout(),
					() => requestCancellation.cancel(),
				)
				throwIfVsCodeLmRequestAborted(requestControl.signal, requestPhase)
				if (!nextChunk) {
					throw new vscode.CancellationError()
				}

				if (nextChunk.done) {
					streamCompleted = true
					break
				}

				const chunk = nextChunk.value
				requestPhase = "response-stream"
				if (typeof chunk === "string") {
					accumulatedText.push(chunk)
					reportedUsage = undefined
					yield {
						type: "text",
						text: chunk,
					}
				} else if (isVsCodeLmThinkingPartLike(chunk)) {
					const thinkingText = getVsCodeLmThinkingText(chunk)
					if (thinkingText.length === 0) {
						continue
					}

					accumulatedText.push(thinkingText)
					reportedUsage = undefined
					yield {
						type: "reasoning",
						text: thinkingText,
					}
				} else if (isLanguageModelTextPartLike(chunk)) {
					// Validate text part value
					if (typeof chunk.value !== "string") {
						console.warn("Alpha <Language Model API>: Invalid text part value received:", chunk.value)
						continue
					}

					accumulatedText.push(chunk.value)
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
							accumulatedText.push(argumentsString)
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
				} else if (isVsCodeLmStatefulMarkerChunk(chunk)) {
					const marker = encodeVsCodeLmStatefulMarker(chunk)
					if (marker) {
						responseStatefulMarker = marker
						console.debug("Alpha <Language Model API>: Preserving stateful response marker")
					} else {
						console.debug("Alpha <Language Model API>: Ignoring malformed stateful response marker")
					}
				} else {
					console.warn("Alpha <Language Model API>: Unknown chunk type received:", chunk)
				}
			}

			throwIfVsCodeLmRequestAborted(requestControl.signal, requestPhase)
			if (this.currentRequestCancellation === requestCancellation) {
				this.currentResponseStatefulMarker = responseStatefulMarker
			}

			// VS Code 1.122.1's Copilot provider reports authoritative usage in a terminal
			// LanguageModelDataPart. Avoid re-tokenizing the completed response here: countTokens
			// can call the provider backend and otherwise delays the visible completion boundary.
			yield {
				type: "usage",
				inputTokens: reportedUsage?.inputTokens ?? estimateVsCodeLmInputTokens(vsCodeLmMessages, tools),
				outputTokens: reportedUsage?.outputTokens ?? estimateTokens(accumulatedText.join("")),
			}
		} catch (error: unknown) {
			if (requestControl.signal.aborted) {
				const abortError = getVsCodeLmRequestAbortError(requestControl.signal, requestPhase)
				if (abortError instanceof vscode.CancellationError) {
					throw new Error("Alpha <Language Model API>: Request cancelled by user")
				}
				throw abortError
			}

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
			if (!streamCompleted) {
				closeVsCodeLmResponseIterator(responseIterator)
			}
			this.finishRequest(requestCancellation, requestControl, disposeSignalBridge, streamCompleted)
		}
	}

	/**
	 * Returns the opaque continuation marker emitted for the latest response.
	 * Task persistence stores it on the matching assistant message so VS Code can
	 * reconnect subsequent tool outputs to the server-side function calls.
	 */
	getStatefulMarker(): string | undefined {
		return this.currentResponseStatefulMarker
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
				} else if (isVsCodeLmThinkingPartLike(chunk)) {
					// Single-completion callers request answer text only.
					continue
				} else if (isLanguageModelTextPartLike(chunk)) {
					result += chunk.value
				} else if (isVsCodeLmStatefulMarkerChunk(chunk)) {
					console.debug("Alpha <Language Model API>: Ignoring completion stateful response marker")
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
