import { resolveXaiModelInfo, xaiDefaultModelId } from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { getModelParams } from "../transform/model-params"
import type { ApiStreamUsageChunk } from "../transform/stream"
import { OpenAiHandler } from "./openai"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"

/** Native xAI authentication and model selection on the shared Responses transport. */
export class XAIHandler extends OpenAiHandler {
	protected override readonly providerName: string = "xAI"
	protected override readonly providerId: string = "xai"

	constructor(options: ApiHandlerOptions) {
		const id = options.apiModelId === undefined ? xaiDefaultModelId : options.apiModelId.trim()
		const info = resolveXaiModelInfo(id)
		const apiKey = options.xaiApiKey?.trim()
		if (!apiKey) throw new Error("An xAI API key is required.")

		// Select native credentials and transport explicitly. Saved compatible/Azure,
		// gateway headers, and task-only custom effort tokens cannot alter this route.
		super({
			openAiBaseUrl: "https://api.x.ai/v1",
			openAiApiKey: apiKey,
			openAiModelId: id,
			openAiCustomModelInfo: info,
			openAiStreamingEnabled: true,
			includeMaxTokens: options.includeMaxTokens,
			modelMaxTokens: options.modelMaxTokens,
			modelTemperature: options.modelTemperature,
			enableReasoningEffort: options.enableReasoningEffort,
			reasoningEffort: options.reasoningEffort,
		})
	}

	protected override shouldUseResponsesApi(): boolean {
		return true
	}

	protected override supportsResponsesReasoningSummary(): boolean {
		return false
	}

	protected override preserveResponsesReasoningIds(): boolean {
		return true
	}

	protected override usesResponsesForSingleCompletion(): boolean {
		return true
	}

	protected override reportsResponsesLifecycle(): boolean {
		return true
	}

	protected override processOpenAiResponsesUsage(usage: unknown): ApiStreamUsageChunk {
		const metrics = super.processOpenAiResponsesUsage(usage)
		const ticks =
			usage !== null && typeof usage === "object" && !Array.isArray(usage)
				? (usage as Record<string, unknown>).cost_in_usd_ticks
				: undefined
		// Exact billed cost includes cache discounts and tool charges; tick integers
		// must be safe before conversion. https://docs.x.ai/developers/cost-tracking (2026-10-25)
		if (typeof ticks !== "number" || !Number.isSafeInteger(ticks) || ticks < 0) return metrics
		return { ...metrics, totalCost: ticks / 10_000_000_000 }
	}

	override getModel() {
		const id = this.options.openAiModelId ?? xaiDefaultModelId
		const info = applyModelToolPreferences({ provider: "xai", id }, resolveXaiModelInfo(id))
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 0.7,
		})
		return { ...params, id, info, verbosity: undefined, toolIdentity: { provider: "xai", id } }
	}
}
