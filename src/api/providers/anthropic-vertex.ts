import { assertNativeVertexSettings } from "./utils/native-vertex-settings"
import { Anthropic } from "@anthropic-ai/sdk"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { GoogleAuth, JWTInput } from "google-auth-library"

import {
	type ModelInfo,
	type VertexModelId,
	vertexDefaultModelId,
	vertexModels,
	ANTHROPIC_DEFAULT_MAX_TOKENS,
	VERTEX_1M_CONTEXT_MODEL_IDS,
	resolveModelParameterApplicability,
	validateOptionalOutputTokenLimit,
} from "@alpha-code/types"
import { safeJsonParse } from "@alpha-code/core"

import { type ApiHandlerOptions, shouldUseReasoningBudget } from "../../shared/api"

import { getModelParams } from "../transform/model-params"

import { AnthropicMessageHandler, type AnthropicRequestContext } from "./anthropic-messages"
import type { ApiHandlerCreateMessageMetadata, ApiHandlerSingleCompletionMetadata } from "../index"
import { awaitSingleCompletion, throwIfSingleCompletionAborted } from "../transform/single-completion"
import { createLinkedAbortController, iterateApiStreamWithAbort, type ApiStream } from "../transform/stream"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"

// A configured model ID may be newer than the static catalog. Keep
// the opaque ID usable while withholding reasoning capabilities until the model
// has an explicitly verified entry in the catalog.
const UNKNOWN_VERTEX_CLAUDE_MODEL_INFO: ModelInfo = {
	maxTokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
}

// https://docs.anthropic.com/en/api/claude-on-vertex-ai
export class AnthropicVertexHandler extends AnthropicMessageHandler {
	override readonly streamCapabilities = { lifecycle: true, cancellation: true } as const
	private directClient?: AnthropicVertex
	constructor(options: ApiHandlerOptions) {
		super(options)
		assertNativeVertexSettings(options)
	}

	private getOrCreateDirectClient(): AnthropicVertex {
		if (this.directClient) {
			return this.directClient
		}

		const projectId = this.getConfiguredProjectId() ?? "not-provided"
		const region = this.getConfiguredLocation() ?? "us-east5"

		if (this.options.vertexJsonCredentials) {
			this.directClient = new AnthropicVertex({
				projectId,
				region,
				googleAuth: new GoogleAuth({
					scopes: ["https://www.googleapis.com/auth/cloud-platform"],
					credentials: safeJsonParse<JWTInput>(this.options.vertexJsonCredentials, undefined),
				}),
			})
		} else if (this.options.vertexKeyFile) {
			this.directClient = new AnthropicVertex({
				projectId,
				region,
				googleAuth: new GoogleAuth({
					scopes: ["https://www.googleapis.com/auth/cloud-platform"],
					keyFile: this.options.vertexKeyFile,
				}),
			})
		} else {
			this.directClient = new AnthropicVertex({ projectId, region })
		}

		return this.directClient
	}

	private getConfiguredProjectId(): string | undefined {
		const value = this.options.projectId ?? this.options.vertexProjectId
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private getConfiguredLocation(): string | undefined {
		const value = this.options.location ?? this.options.vertexRegion
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	protected override async getRequestContext(
		model: string,
		metadata?: ApiHandlerSingleCompletionMetadata,
	): Promise<AnthropicRequestContext> {
		throwIfSingleCompletionAborted(metadata)
		return { client: this.getOrCreateDirectClient(), model }
	}

	protected override isStreamingEnabled(): boolean {
		return this.options.vertexStreamingEnabled !== false
	}

	protected override getCompletionError(error: Error): Error {
		return new Error(`Vertex completion error: ${error.message}`)
	}

	protected override getCompletionText(response: Anthropic.Messages.Message): string {
		if (response.stop_reason !== "end_turn" && response.stop_reason !== "stop_sequence") {
			throw new Error("Vertex Claude completion did not finish with a complete text response.")
		}
		return super.getCompletionText(response)
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

	override getModel() {
		const modelId = this.options.apiModelId?.trim() || vertexDefaultModelId
		const isKnownModel = Object.prototype.hasOwnProperty.call(vertexModels, modelId)
		let id = modelId
		let info: ModelInfo = isKnownModel ? vertexModels[id as VertexModelId] : UNKNOWN_VERTEX_CLAUDE_MODEL_INFO

		// Check if 1M context beta should be enabled for supported models
		const supports1MContext = VERTEX_1M_CONTEXT_MODEL_IDS.includes(
			id as (typeof VERTEX_1M_CONTEXT_MODEL_IDS)[number],
		)
		const enable1MContext = supports1MContext && this.options.vertex1MContext

		// If 1M context beta is enabled, update the model info with tier pricing
		if (enable1MContext) {
			const tier = info.tiers?.[0]
			if (tier) {
				info = {
					...info,
					contextWindow: tier.contextWindow,
					inputPrice: tier.inputPrice,
					outputPrice: tier.outputPrice,
					cacheWritesPrice: tier.cacheWritesPrice,
					cacheReadsPrice: tier.cacheReadsPrice,
				}
			}
		}

		info = applyModelToolPreferences({ provider: "vertex", id }, info)

		const settings = shouldUseReasoningBudget({ model: info, settings: this.options })
			? { ...this.options, modelMaxTokens: validateOptionalOutputTokenLimit(this.options.modelMaxTokens) }
			: this.options
		const params = getModelParams({
			format: "anthropic",
			modelId: id,
			model: info,
			settings,
			defaultTemperature: 0,
		})
		const maxTokens = validateOptionalOutputTokenLimit(params.maxTokens) ?? ANTHROPIC_DEFAULT_MAX_TOKENS
		if (params.reasoningBudget !== undefined && params.reasoningBudget >= maxTokens) {
			throw new RangeError("Output token limit must exceed the thinking token budget.")
		}

		// Build betas array for request headers
		const betas: string[] = []

		// Add 1M context beta flag if enabled for supported models
		if (enable1MContext) {
			betas.push("context-1m-2025-08-07")
		}

		// The `:thinking` suffix indicates that the model is a "Hybrid"
		// reasoning model and that reasoning is required to be enabled.
		// The actual model ID honored by Anthropic's API does not have this
		// suffix.
		const resolvedId = id.endsWith(":thinking") ? id.replace(":thinking", "") : id
		const applicability = resolveModelParameterApplicability({
			provider: "vertex",
			modelId: resolvedId,
			model: info,
			settings,
		})
		return {
			id: resolvedId,
			info,
			betas: betas.length > 0 ? betas : undefined,
			toolIdentity: { provider: "vertex", id: resolvedId },
			...params,
			maxTokens,
			temperature:
				applicability.fixedTemperature ?? (applicability.supportsTemperature ? params.temperature : undefined),
			verbosity: undefined,
		}
	}
}
