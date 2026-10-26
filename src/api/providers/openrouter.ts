import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"
import { isDeepStrictEqual } from "node:util"

import {
	getModelId,
	getCuratedModelInfo,
	getUnsupportedCuratedProviderSettings,
	openRouterDefaultModelId,
	type ModelInfo,
	resolveModelReasoningEffort,
	resolveModelParameterApplicability,
} from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../index"
import { getModelParams } from "../transform/model-params"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { OpenAiHandler } from "./openai"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

/** A curated router route, using the shared Chat Completions transport. */
export class OpenRouterHandler extends OpenAiHandler {
	protected override readonly providerName = "OpenRouter"
	protected override readonly providerId = "openrouter"
	private readonly selectedModel: { id: string; info: ModelInfo }
	private pendingReasoningDetails?: unknown[]
	private sealedReasoningDetails?: unknown[]

	constructor(options: ApiHandlerOptions) {
		const id = (getModelId({ ...options, apiProvider: "openrouter" }) ?? openRouterDefaultModelId).trim()
		const info = getCuratedModelInfo("openrouter", id)
		if (!info) {
			throw new Error("Unsupported OpenRouter model. Select a supported frontier model.")
		}
		if (!options.openRouterApiKey?.trim()) {
			throw new Error("An OpenRouter API key is required.")
		}
		if (getUnsupportedCuratedProviderSettings("openrouter", options).length > 0) {
			throw new Error(
				"Custom OpenRouter endpoints and provider routing are not supported by the curated provider.",
			)
		}

		// Only this provider's credentials and endpoint may reach its transport.
		// Generic endpoint settings and provider-specific state must not leak across profiles.
		super({
			openAiBaseUrl: OPENROUTER_BASE_URL,
			openAiApiKey: options.openRouterApiKey.trim(),
			openAiModelId: id,
			openAiCustomModelInfo: info,
			openAiStreamingEnabled: options.openRouterStreamingEnabled ?? true,
			enableReasoningEffort: options.enableReasoningEffort,
			reasoningEffort: options.reasoningEffort,
			includeMaxTokens: options.includeMaxTokens,
			modelMaxTokens: options.modelMaxTokens,
			modelTemperature: options.modelTemperature,
			verbosity: options.verbosity,
		})
		this.selectedModel = { id, info }
	}

	protected override shouldUseResponsesApi(): boolean {
		return false
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.pendingReasoningDetails = undefined
		this.sealedReasoningDetails = undefined
		yield* super.createMessage(systemPrompt, messages, metadata)
	}

	override getReasoningDetails(): unknown[] | undefined {
		return this.sealedReasoningDetails ? structuredClone(this.sealedReasoningDetails) : undefined
	}

	protected override onChatFinishReason(reason: string | null | undefined): void {
		// A cancellation can occur after a complete tool-call marker but before EOF.
		// Seal before accepting those calls; incomplete signed fragments are never replayable.
		if (reason === "stop" || reason === "tool_calls") {
			this.sealedReasoningDetails = structuredClone(this.pendingReasoningDetails)
		}
	}

	protected override captureReasoningDetails(details: unknown[]): void {
		const pending = (this.pendingReasoningDetails ??= [])
		if (this.options.openAiStreamingEnabled === false) {
			pending.push(...structuredClone(details))
			return
		}

		// Match OpenRouter's SDK delta semantics, reviewed 2026-10-25 at
		// OpenRouterTeam/ai-sdk-provider d8edda07b62de696d613ae0115823382465665cd, src/chat/index.ts.
		// Streamed indices can all be zero. Text signatures seal blocks; encrypted state is discrete.
		for (const value of details) {
			const incoming = record(structuredClone(value))
			if (!incoming) throw malformedReasoningFragment()
			const field =
				incoming.type === "reasoning.text"
					? "text"
					: incoming.type === "reasoning.summary"
						? "summary"
						: undefined
			if (
				field &&
				["id", "format", "signature"].some(
					(key) => incoming[key] !== undefined && incoming[key] !== null && typeof incoming[key] !== "string",
				)
			) {
				throw malformedReasoningFragment()
			}
			if (
				field &&
				incoming[field] !== undefined &&
				incoming[field] !== null &&
				typeof incoming[field] !== "string"
			) {
				throw malformedReasoningFragment()
			}
			const previous = record(pending.at(-1))
			const signed = incoming.type === "reasoning.text" && hasMetadata(previous?.signature)
			const newIdentity = ["id", "format"].some(
				(key) =>
					hasMetadata(previous?.[key]) && hasMetadata(incoming[key]) && previous?.[key] !== incoming[key],
			)
			if (field && previous && previous.type === incoming.type && !signed && !newIdentity) {
				mergeReasoningFragment(previous, incoming, field)
			} else {
				pending.push(incoming)
			}
		}
	}

	override getModel() {
		const { id, info: catalogInfo } = this.selectedModel
		const identity = { provider: this.providerId, family: id, id }
		const info = applyModelToolPreferences(identity, catalogInfo)
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 0,
		})
		const applicability = resolveModelParameterApplicability({
			provider: this.providerId,
			modelId: id,
			model: info,
			settings: this.options,
		})
		return {
			id,
			info,
			...params,
			temperature: applicability.supportsTemperature ? params.temperature : undefined,
			verbosity: info.supportsVerbosity ? params.verbosity : undefined,
			toolIdentity: identity,
		}
	}

	protected override convertMessages(
		messages: Anthropic.Messages.MessageParam[],
	): OpenAI.Chat.ChatCompletionMessageParam[] {
		return convertToOpenAiMessages(messages, { preserveReasoningDetails: true })
	}

	protected override customizeChatRequest<T extends OpenAI.Chat.Completions.ChatCompletionCreateParams>(
		request: T,
	): T {
		const { info } = this.getModel()
		const effort = resolveModelReasoningEffort(info, request.reasoning_effort ?? undefined)
		if (!effort) {
			throw new Error("The selected reasoning effort is unavailable for this OpenRouter model.")
		}
		// OpenRouter's unified reasoning object and capability filter are required
		// on every path, including auxiliary completions. Verified 2026-10-25:
		// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
		// https://openrouter.ai/docs/guides/routing/provider-selection
		const customized = {
			...request,
			reasoning: { effort },
			provider: { require_parameters: true },
			...(info.supportsVerbosity && this.options.verbosity ? { verbosity: this.options.verbosity } : {}),
		}
		delete customized.reasoning_effort
		// Every curated router route advertises max_tokens; use its unified parameter
		// even when the shared compatible transport supplied OpenAI's newer alias.
		if (customized.max_completion_tokens !== undefined) {
			customized.max_tokens = customized.max_completion_tokens
			delete customized.max_completion_tokens
		}
		// Omit the optional parallel hint because support varies across curated routes.
		// Alpha's scheduler still governs execution of any returned independent calls.
		delete customized.parallel_tool_calls
		return customized
	}

	protected override *readReasoning(value: unknown): Generator<{ type: "reasoning"; text: string }> {
		const visible = [...super.readReasoning(value)]
		if (visible.length > 0) {
			yield* visible
			return
		}
		const details = record(value)?.reasoning_details
		if (!Array.isArray(details)) return
		for (const value of details) {
			const detail = record(value)
			const text =
				detail?.type === "reasoning.text"
					? detail.text
					: detail?.type === "reasoning.summary"
						? detail.summary
						: undefined
			if (typeof text === "string" && text) yield { type: "reasoning", text }
		}
	}

	protected override processUsageMetrics(usage: unknown, info?: ModelInfo): ApiStreamUsageChunk {
		const source = record(usage)
		const cacheWriteTokens = tokenCount(record(source?.prompt_tokens_details)?.cache_write_tokens)
		const totalCost = tokenCount(source?.cost)
		return {
			...super.processUsageMetrics(usage, info),
			...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
			...(totalCost !== undefined ? { totalCost } : {}),
		}
	}

	protected override validateChatSingleCompletion(response: OpenAI.Chat.Completions.ChatCompletion): void {
		const choice = response.choices?.[0]
		if (
			choice?.finish_reason !== "stop" ||
			choice.message?.tool_calls?.length ||
			typeof choice.message?.content !== "string" ||
			!choice.message.content.trim()
		) {
			throw new Error("OpenRouter did not return a complete text response.")
		}
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function tokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
		? value
		: undefined
}

function hasMetadata(value: unknown): boolean {
	return value !== undefined && value !== null && value !== ""
}

function mergeReasoningFragment(
	previous: Record<string, unknown>,
	incoming: Record<string, unknown>,
	field: "text" | "summary",
): void {
	for (const [key, value] of Object.entries(incoming)) {
		if (key === field || value === undefined) continue
		// The first observed index is replay metadata, not a streamed block identifier.
		if (key === "index" && previous[key] !== undefined) continue
		const optionalMetadata = key === "id" || key === "format" || key === "signature"
		if (optionalMetadata && !hasMetadata(value)) continue
		if (previous[key] === undefined || (optionalMetadata && !hasMetadata(previous[key]))) {
			previous[key] = value
		} else if (!isDeepStrictEqual(previous[key], value)) {
			// Unknown opaque fields cannot be overwritten or guessed during reconstruction.
			throw malformedReasoningFragment()
		}
	}
	previous[field] = `${previous[field] ?? ""}${incoming[field] ?? ""}`
}

function malformedReasoningFragment(): Error {
	return new Error("OpenRouter returned inconsistent reasoning fragments; the response cannot be safely continued.")
}
