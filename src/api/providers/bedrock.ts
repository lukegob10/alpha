import { Anthropic } from "@anthropic-ai/sdk"
import type { ResponseCreateParamsBase } from "openai/resources/responses/responses"
import { getTokenProvider } from "@aws/bedrock-token-generator"
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers"

import {
	bedrockDefaultModelId,
	bedrockDefaultRegion,
	bedrockRegionPattern,
	getBedrockModelRoute,
	getCuratedModelInfo,
	resolveOptionalOutputTokenLimit,
	type BedrockModelRoute,
	type ModelInfo,
	type ProviderSettings,
} from "@alpha-code/types"

import type { ApiHandlerCreateMessageMetadata, ApiHandlerSingleCompletionMetadata } from "../index"
import type { ApiHandlerOptions } from "../../shared/api"
import { awaitSingleCompletion, throwIfSingleCompletionAborted } from "../transform/single-completion"
import { createLinkedAbortController, iterateApiStreamWithAbort, type ApiStream } from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import {
	AnthropicMessageHandler,
	type AnthropicMessageModel,
	type AnthropicMessageToolParams,
	type AnthropicRequestContext,
} from "./anthropic-messages"
import { OpenAiHandler } from "./openai"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"
import { getApiRequestTimeout } from "./utils/timeout-config"

type BedrockConnection = {
	id: string
	family: string
	info: ModelInfo
	region: string
	requestModel: string
	fetch: typeof fetch
}

function resolveInferenceProfile(
	selectedModel: string,
	override: string | undefined,
	region: string,
	route: BedrockModelRoute,
): string {
	const profile = override?.trim()
	if (!profile) return selectedModel
	const model = selectedModel.replace(/^global\./, "")
	const matchesSelectedModel = (value: string) =>
		/^(?:global|us|eu|au|jp)\./.test(value) && value.replace(/^[^.]+\./, "") === model
	if (matchesSelectedModel(profile)) return profile

	const arn =
		/^arn:aws:bedrock:([a-z0-9-]+):\d{12}:(inference-profile|application-inference-profile)\/([A-Za-z0-9.:-]+)$/.exec(
			profile,
		)
	if (!arn || arn[1] !== region) {
		throw new Error("Use an inference profile for the selected Bedrock model in the configured AWS region.")
	}
	if (arn[2] === "application-inference-profile") {
		if (route === "openai-responses") {
			throw new Error("Bedrock Responses does not support application inference profiles.")
		}
		// Application profiles have opaque IDs. The selected catalog model is the
		// user's declared underlying model; resolving that mapping must not scan AWS.
		return profile
	}
	if (!matchesSelectedModel(arn[3])) {
		throw new Error("The Bedrock inference profile must match the selected model.")
	}
	return profile
}

function applyInferenceProfilePricing(info: ModelInfo, requestModel: string): ModelInfo {
	const profile = requestModel.startsWith("arn:") ? /:inference-profile\/(.+)$/.exec(requestModel)?.[1] : requestModel
	if (!profile || !/^(?:us|eu|au|jp)\./.test(profile)) return info
	// Catalog prices are Global Standard. Verified geographic profiles add 10%
	// to every token category; opaque application profiles retain the base estimate.
	const regionalPrice = (price: number | undefined) => (price === undefined ? undefined : price * 1.1)
	return {
		...info,
		inputPrice: regionalPrice(info.inputPrice),
		outputPrice: regionalPrice(info.outputPrice),
		cacheWritesPrice: regionalPrice(info.cacheWritesPrice),
		cacheReadsPrice: regionalPrice(info.cacheReadsPrice),
	}
}

function createBedrockFetch(options: ApiHandlerOptions, region: string): typeof fetch {
	if (options.awsUseApiKey && options.awsUseProfile) {
		throw new Error("Select one Bedrock authentication method.")
	}
	const apiKey = options.awsUseApiKey ? options.awsApiKey?.trim() : undefined
	const profile = options.awsUseProfile ? options.awsProfile?.trim() : undefined
	if (options.awsUseApiKey && !apiKey) throw new Error("A Bedrock API key is required.")
	if (options.awsUseProfile && !profile) throw new Error("An AWS credential profile is required.")
	const accessKeyId = options.awsAccessKey?.trim()
	const secretAccessKey = options.awsSecretKey?.trim()
	const sessionToken = options.awsSessionToken?.trim()
	if (!options.awsUseApiKey && !options.awsUseProfile) {
		if (Boolean(accessKeyId) !== Boolean(secretAccessKey) || (sessionToken && !accessKeyId)) {
			throw new Error("AWS access key and secret key must be provided together.")
		}
	}
	let provideToken: ReturnType<typeof getTokenProvider> | undefined
	return async (input, init) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
		const metadata = signal ? { signal } : undefined
		throwIfSingleCompletionAborted(metadata)
		let token = apiKey
		if (!token) {
			if (!provideToken) {
				// Reuse official AWS credential providers and mint a fresh short-lived token.
				// Construct credential providers only on invocation, never in settings.
				// AWS credentials providers have no AbortSignal API; bound their network
				// attempts and race the wait against the SDK's request signal below.
				const clientConfig = {
					region,
					maxAttempts: 1,
					requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 },
				}
				const credentials = profile
					? fromIni({ profile, clientConfig })
					: accessKeyId && secretAccessKey
						? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
						: fromNodeProviderChain({ clientConfig, timeout: 1_000, maxRetries: 0 })
				provideToken = getTokenProvider({ region, credentials })
			}
			token = await awaitSingleCompletion(provideToken(), metadata)
		}
		throwIfSingleCompletionAborted(metadata)
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
		headers.delete("x-api-key")
		headers.delete("openai-organization")
		headers.delete("openai-project")
		headers.set("authorization", `Bearer ${token}`)
		return globalThis.fetch(input, { ...init, headers })
	}
}

/** Route only verified catalog entries; credential/model access failures occur on invocation. */
export function buildBedrockHandler(options: ApiHandlerOptions): BedrockAnthropicHandler | BedrockResponsesHandler {
	const id = options.apiModelId === undefined ? bedrockDefaultModelId : options.apiModelId.trim()
	const route = getBedrockModelRoute(id)
	const info = getCuratedModelInfo("bedrock", id)
	if (!route || !info) throw new Error("Unsupported Bedrock model. Select a model from the supported catalog.")
	const region = options.awsRegion === undefined ? bedrockDefaultRegion : options.awsRegion.trim()
	if (!bedrockRegionPattern.test(region)) throw new Error("A valid AWS region is required.")
	const requestModel = resolveInferenceProfile(id, options.awsCustomArn, region, route)
	const connection: BedrockConnection = {
		id,
		family: id.replace(/^global\.(?:anthropic|openai)\./, ""),
		info: applyInferenceProfilePricing(info, requestModel),
		region,
		requestModel,
		fetch: createBedrockFetch(options, region),
	}
	return route === "anthropic-messages"
		? new BedrockAnthropicHandler(options, connection)
		: new BedrockResponsesHandler(options, connection)
}

/** AWS native Messages uses the shared signed-thinking, tool, usage and lifecycle normalizer. */
class BedrockAnthropicHandler extends AnthropicMessageHandler {
	override readonly streamCapabilities = { lifecycle: true, cancellation: true } as const
	private client?: Anthropic

	constructor(
		options: ApiHandlerOptions,
		private readonly connection: BedrockConnection,
	) {
		super({ ...options })
	}

	protected override async getRequestContext(
		_model: string,
		metadata?: ApiHandlerSingleCompletionMetadata,
	): Promise<AnthropicRequestContext> {
		throwIfSingleCompletionAborted(metadata)
		this.client ??= new Anthropic({
			apiKey: null,
			authToken: "bedrock-request-token",
			baseURL: `https://bedrock-runtime.${this.connection.region}.amazonaws.com/anthropic`,
			fetch: this.connection.fetch,
			maxRetries: 0,
			timeout: getApiRequestTimeout(),
		})
		return { client: this.client, model: this.connection.requestModel }
	}

	protected override getNativeToolParams(metadata?: ApiHandlerCreateMessageMetadata): AnthropicMessageToolParams {
		if (metadata?.tool_choice === "required" || typeof metadata?.tool_choice === "object") {
			throw new Error(
				"This Bedrock Claude model supports automatic or disabled tool selection; forced tool use is unsupported.",
			)
		}
		if (!metadata?.tools?.length) return {}
		const params = super.getNativeToolParams(metadata)
		return metadata.tool_choice === "none" ? { ...params, tool_choice: { type: "none" } } : params
	}

	override getModel() {
		const { id, family } = this.connection
		const toolIdentity = { provider: "bedrock", id, family }
		const info = applyModelToolPreferences(toolIdentity, this.connection.info)
		const params = getModelParams({
			format: "anthropic",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})
		const maxTokens =
			resolveOptionalOutputTokenLimit({
				model: info,
				settings: this.options,
				route: "anthropic-messages",
				enforceModelMaximum: true,
			}) ??
			params.maxTokens ??
			info.maxTokens ??
			undefined
		return {
			...params,
			id,
			info,
			instructionModelId: family,
			toolIdentity,
			maxTokens,
			temperature: undefined,
			verbosity: undefined,
			// Bedrock implements the same preserved-thinking binding controls. Alpha
			// may compact or rebuild prefixes, so only invalidated signed blocks drop.
			// AWS claude-messages-thinking-block-binding.html, verified 2026-10-28.
			reasoning: {
				type: "adaptive",
				display: "summarized",
				block_binding: { prefix_mismatch_behavior: "drop_block" },
			},
			betas: ["thinking-binding-controls-2026-08-01"],
			outputConfig: params.reasoningEffort ? { effort: params.reasoningEffort } : undefined,
		} satisfies AnthropicMessageModel & { instructionModelId: string }
	}

	setReasoningOptions(settings: Pick<ProviderSettings, "enableReasoningEffort" | "reasoningEffort">): void {
		this.options = {
			...this.options,
			enableReasoningEffort: settings.enableReasoningEffort,
			reasoningEffort: settings.reasoningEffort,
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const control = createLinkedAbortController(metadata)
		try {
			control.signal.throwIfAborted()
			yield* iterateApiStreamWithAbort(
				super.createMessage(systemPrompt, messages, {
					...metadata,
					taskId: metadata?.taskId ?? "",
					signal: control.signal,
				}),
				control.signal,
			)
			control.signal.throwIfAborted()
		} finally {
			control.dispose()
		}
	}

	protected override getCompletionText(response: Anthropic.Messages.Message): string {
		if (response.stop_reason !== "end_turn" && response.stop_reason !== "stop_sequence") {
			throw new Error("Bedrock Claude completion did not finish with a complete text response.")
		}
		return super.getCompletionText(response)
	}
}

/** AWS's native OpenAI route shares Responses ordering and encrypted-reasoning replay. */
class BedrockResponsesHandler extends OpenAiHandler {
	protected override readonly providerId: string = "bedrock"
	protected override readonly providerName: string = "Amazon Bedrock"

	constructor(
		options: ApiHandlerOptions,
		private readonly connection: BedrockConnection,
	) {
		super({
			...options,
			openAiBaseUrl: `https://bedrock-runtime.${connection.region}.amazonaws.com/openai/v1`,
			openAiApiKey: "bedrock-request-token",
			openAiModelId: connection.id,
			openAiCustomModelInfo: connection.info,
			openAiHeaders: undefined,
			openAiHostHeader: undefined,
			openAiUseAzure: false,
			openAiR1FormatEnabled: false,
			openAiStreamingEnabled: true,
			azureApiVersion: undefined,
			taskReasoningCustomEffort: undefined,
		})
		this.client = this.client.withOptions({ fetch: connection.fetch, organization: null, project: null })
	}

	protected override shouldUseResponsesApi(): boolean {
		return true
	}

	protected override reportsResponsesLifecycle(): boolean {
		return true
	}

	protected override usesResponsesForSingleCompletion(): boolean {
		return true
	}

	protected override preserveResponsesReasoningIds(): boolean {
		// AWS uses the Responses input format, including opaque reasoning items.
		// Keep original item identities when replaying our stateless transcript.
		return true
	}

	protected override customizeResponsesRequest<T extends ResponseCreateParamsBase>(request: T): T {
		return { ...request, model: this.connection.requestModel }
	}

	override getModel() {
		const model = super.getModel()
		const toolIdentity = { provider: "bedrock", id: this.connection.id, family: this.connection.family }
		return {
			...model,
			instructionModelId: this.connection.family,
			toolIdentity,
			info: applyModelToolPreferences(toolIdentity, this.connection.info),
		}
	}

	setReasoningOptions(settings: Pick<ProviderSettings, "enableReasoningEffort" | "reasoningEffort">): void {
		this.options = {
			...this.options,
			enableReasoningEffort: settings.enableReasoningEffort,
			reasoningEffort: settings.reasoningEffort,
		}
	}
}
