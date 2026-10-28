import { getCuratedModelInfo, metaDefaultModelId } from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { OpenAiHandler } from "./openai"

/** Native Meta credentials and bundled capabilities use the shared Responses transport. */
export class MetaHandler extends OpenAiHandler {
	protected override readonly providerName: string = "Meta"
	protected override readonly providerId: string = "meta"

	constructor(options: ApiHandlerOptions) {
		const id = options.apiModelId === undefined ? metaDefaultModelId : options.apiModelId.trim()
		const info = getCuratedModelInfo("meta", id)
		if (!info) throw new Error(`Unsupported Meta model: ${id}`)
		const apiKey = options.metaApiKey?.trim()
		if (!apiKey) throw new Error("A Meta API key is required.")

		// A saved profile can retain another provider's endpoint and settings.
		// Only Meta credentials and portable request preferences enter this route.
		super({
			openAiBaseUrl: "https://api.meta.ai/v1",
			openAiApiKey: apiKey,
			openAiModelId: id,
			openAiCustomModelInfo: info,
			openAiStreamingEnabled: true,
			includeMaxTokens: options.includeMaxTokens,
			modelMaxTokens: options.modelMaxTokens,
			modelTemperature: options.modelTemperature,
			enableReasoningEffort: options.enableReasoningEffort,
			reasoningEffort: options.reasoningEffort,
			enableResponsesReasoningSummary: options.enableResponsesReasoningSummary,
		})
		// The OpenAI SDK reads these headers from its own environment defaults.
		// They identify another service's account and must never reach Meta.
		this.client = this.client.withOptions({ organization: null, project: null })
	}

	protected override shouldUseResponsesApi(): boolean {
		// Meta Chat Completions cannot replay private reasoning for external keys.
		// Stateless Responses replay preserves it without server-side history.
		// https://dev.meta.ai/docs/protocols/responses (verified 2026-10-28).
		return true
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
}
