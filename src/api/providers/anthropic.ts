import { Anthropic } from "@anthropic-ai/sdk"

import {
	anthropicModels,
	anthropicDefaultModelId,
	type AnthropicModelId,
	type ModelInfo,
	resolveOptionalOutputTokenLimit,
	getUnsupportedCuratedProviderSettings,
} from "@alpha-code/types"

import type { ApiHandlerCreateMessageMetadata, ApiHandlerSingleCompletionMetadata } from "../index"
import type { ApiHandlerOptions } from "../../shared/api"
import { createLinkedAbortController, iterateApiStreamWithAbort, type ApiStream } from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import { throwIfSingleCompletionAborted } from "../transform/single-completion"
import {
	AnthropicMessageHandler,
	type AnthropicMessageModel,
	type AnthropicMessageToolParams,
	type AnthropicRequestContext,
} from "./anthropic-messages"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"

export class AnthropicHandler extends AnthropicMessageHandler {
	override readonly streamCapabilities = { lifecycle: true, cancellation: true } as const
	private nativeClient?: Anthropic

	constructor(options: ApiHandlerOptions) {
		super({ ...options })
		if (getUnsupportedCuratedProviderSettings("anthropic", options).length) {
			throw new Error(
				"This Anthropic provider supports the native API with an API key; remove legacy routing or auth options.",
			)
		}
	}

	protected override async getRequestContext(
		model: string,
		metadata?: ApiHandlerSingleCompletionMetadata,
	): Promise<AnthropicRequestContext> {
		throwIfSingleCompletionAborted(metadata)
		if (!this.nativeClient) {
			const apiKey = this.options.apiKey?.trim()
			if (!apiKey) throw new Error("An Anthropic API key is required.")
			this.nativeClient = new Anthropic({
				apiKey,
				authToken: null,
				baseURL: "https://api.anthropic.com",
				timeout: getApiRequestTimeout(),
				maxRetries: 0,
			})
		}
		return { client: this.nativeClient, model }
	}

	protected override getToolChoiceForRequest(
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiHandlerCreateMessageMetadata["tool_choice"] {
		if (metadata?.tool_choice === "required" || typeof metadata?.tool_choice === "object") {
			throw new Error(
				"This Anthropic model supports automatic or disabled tool selection; forced tool use is unsupported.",
			)
		}
		return metadata?.tool_choice
	}

	protected override getNativeToolParams(metadata?: ApiHandlerCreateMessageMetadata): AnthropicMessageToolParams {
		const choice = this.getToolChoiceForRequest(metadata)
		if (!metadata?.tools?.length) return {}
		const params = super.getNativeToolParams(metadata)
		return choice === "none" ? { ...params, tool_choice: { type: "none" } } : params
	}

	override getModel() {
		const id = this.options.apiModelId === undefined ? anthropicDefaultModelId : this.options.apiModelId.trim()
		if (!Object.hasOwn(anthropicModels, id)) {
			throw new Error("Unsupported Anthropic model. Select a model from the supported catalog.")
		}
		const entry = anthropicModels[id as AnthropicModelId]
		const info: ModelInfo = applyModelToolPreferences({ provider: "anthropic", id }, entry)
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
			entry.maxTokens
		const thinkingDisabled =
			!info.requiredReasoningEffort &&
			(this.options.enableReasoningEffort === false || this.options.reasoningEffort === "disable")
		return {
			...params,
			id,
			info,
			maxTokens,
			temperature: undefined,
			verbosity: undefined,
			toolIdentity: { provider: "anthropic", id },
			// Alpha may replace an instruction/tool prefix or compact completed turns.
			// Preserve valid signed blocks; let the API drop only blocks invalidated by that prefix change.
			// https://platform.claude.com/docs/en/build-with-claude/preserved-thinking (2026-10-25)
			reasoning: thinkingDisabled
				? { type: "disabled" }
				: {
						type: "adaptive",
						display: "summarized",
						block_binding: { prefix_mismatch_behavior: "drop_block" },
					},
			betas: thinkingDisabled ? undefined : ["thinking-binding-controls-2026-08-01"],
			outputConfig: params.reasoningEffort ? { effort: params.reasoningEffort } : undefined,
		} satisfies AnthropicMessageModel
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
			throw new Error("Anthropic completion did not finish with a complete text response.")
		}
		return super.getCompletionText(response)
	}
}
