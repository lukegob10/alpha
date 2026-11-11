import {
	getCuratedModelInfo,
	snapshotNativeCompactionCheckpoint,
	getUnsupportedCuratedProviderSettings,
	openAiNativeDefaultModelId,
	type ProviderSettings,
} from "@alpha-code/types"
import type { ResponseCreateParamsBase } from "openai/resources/responses/responses"

import type { ApiHandlerOptions } from "../../shared/api"
import type { ApiNativeCompactionCapability } from "../index"
import { createLinkedAbortController, raceApiStreamAbort } from "../transform/stream"
import { buildOpenAiResponsesInput } from "./openai-responses"
import { calculateApiCostOpenAI } from "../../shared/cost"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { NativeCompactionInvalidResultError, NativeCompactionUnavailableError } from "../native-compaction"
import { checkContextWindowExceededError } from "../../core/context/context-management/context-error-handling"

// Public GPT-6 guidance confirms inherited GPT-5.6 compaction support (2026-11-03):
// https://developers.openai.com/api/docs/guides/latest-model
// Keep future catalog additions on the local path until their capability is verified.
const NATIVE_COMPACTION_MODELS = new Set(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
import { OpenAiHandler } from "./openai"

/** Native credentials and curated capabilities feed the shared Responses transport. */
export class OpenAiNativeHandler extends OpenAiHandler {
	protected override readonly providerId: string = "openai-native"
	private nativeCompactionUnavailable = false

	constructor(options: ApiHandlerOptions) {
		const unsupported = getUnsupportedCuratedProviderSettings("openai-native", options)
		if (unsupported.length) {
			throw new Error(`Unsupported OpenAI settings: ${unsupported.join(", ")}`)
		}
		const id = options.apiModelId === undefined ? openAiNativeDefaultModelId : options.apiModelId.trim()
		const info = getCuratedModelInfo("openai-native", id)
		if (!info) throw new Error(`Unsupported OpenAI model: ${id}`)
		const apiKey = options.openAiNativeApiKey?.trim()
		if (!apiKey) throw new Error("OpenAI API key is required")

		// Profiles can retain unrelated compatible-provider fields after switching.
		// Those fields must not change the native endpoint, credentials, or protocol.
		super({
			...options,
			openAiBaseUrl: "https://api.openai.com/v1",
			openAiApiKey: apiKey,
			openAiModelId: id,
			openAiCustomModelInfo: info,
			openAiHeaders: undefined,
			openAiHostHeader: undefined,
			openAiUseAzure: false,
			openAiR1FormatEnabled: false,
			openAiStreamingEnabled: true,
			azureApiVersion: undefined,
		})
	}

	get nativeCompaction(): ApiNativeCompactionCapability | undefined {
		// Public API-key Responses supports the documented standalone endpoint.
		// The SIWC subclass has a different request whitelist and keeps local compaction.
		if (this.providerId !== "openai-native" || this.nativeCompactionUnavailable) return undefined
		const model = this.getModel()
		if (!NATIVE_COMPACTION_MODELS.has(model.id)) return undefined
		const scope = { provider: "openai-native" as const, modelId: model.id }
		return {
			scope,
			compact: async (systemPrompt, messages, metadata) => {
				const configuredDeadline = metadata?.deadline
				const configuredTimeout = getApiRequestTimeout()
				const timeout =
					typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0
						? configuredTimeout
						: 600_000
				const deadline = Math.min(
					Date.now() + timeout,
					configuredDeadline instanceof Date
						? configuredDeadline.getTime()
						: (configuredDeadline ?? Infinity),
				)
				const control = createLinkedAbortController({
					...metadata,
					deadline,
					deadlineScope: "compaction_deadline",
				})
				try {
					control.signal.throwIfAborted()
					// OpenAI docs /api/docs/guides/compaction, retrieved 2026-11-03:
					// replay the entire compacted output window, including retained items.
					// SDK 5.12.2 predates responses.compact; its public HTTP method preserves
					// SDK credentials/retries without adding private Codex request fields.
					const response = await raceApiStreamAbort(
						this.client.post<unknown>("/responses/compact", {
							body: {
								model: scope.modelId,
								input: buildOpenAiResponsesInput(
									systemPrompt,
									metadata?.instructionFragments,
									messages,
									false,
									true,
									{
										providerId: scope.provider,
										modelId: scope.modelId,
									},
								),
							},
							signal: control.signal,
						}),
						control.signal,
					)
					if (typeof response !== "object" || response === null || Array.isArray(response)) {
						control.signal.throwIfAborted()
						throw new NativeCompactionInvalidResultError()
					}
					const source = response as Record<string, unknown>
					// Account a completed HTTP response before validation or late Stop can
					// discard its checkpoint. The callback never receives ciphertext.
					if (source.usage !== undefined) {
						const usage = this.processOpenAiResponsesUsage(source.usage)
						const { totalCost } = calculateApiCostOpenAI(
							model.info,
							usage.inputTokens,
							usage.outputTokens,
							usage.cacheWriteTokens,
							usage.cacheReadTokens,
						)
						metadata?.observeUsage?.({ ...usage, totalCost })
					}
					control.signal.throwIfAborted()
					const checkpoint = snapshotNativeCompactionCheckpoint({
						protocol: "openai-responses",
						...scope,
						responseId: source.id,
						output: source.output,
					})
					if (!checkpoint) throw new NativeCompactionInvalidResultError()
					if (this.getModel().id !== scope.modelId) throw new Error("Stale native compaction checkpoint")
					return checkpoint
				} catch (error) {
					control.signal.throwIfAborted()
					// The public endpoint requires fitting input. A size rejection is
					// recoverable through text compaction, not a permanent capability refusal.
					if (checkContextWindowExceededError(error)) throw error
					const source =
						typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined
					if (source && [400, 404, 405, 422, 501].includes(Number(source.status))) {
						this.nativeCompactionUnavailable = true
						throw new NativeCompactionUnavailableError()
					}
					throw error
				} finally {
					control.dispose()
				}
			},
		}
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

	protected override customizeResponsesRequest<T extends ResponseCreateParamsBase>(request: T): T {
		return this.options.openAiNativeServiceTier === "default" ? { ...request, service_tier: "default" } : request
	}

	setReasoningOptions(settings: Pick<ProviderSettings, "enableReasoningEffort" | "reasoningEffort">): void {
		// Runtime callers can pass a full profile; preserve the mapped native transport and credential fields.
		this.options = {
			...this.options,
			enableReasoningEffort: settings.enableReasoningEffort,
			reasoningEffort: settings.reasoningEffort,
		}
	}
}
