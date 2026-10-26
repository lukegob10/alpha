import {
	getCuratedModelInfo,
	getUnsupportedCuratedProviderSettings,
	openAiNativeDefaultModelId,
	type ProviderSettings,
} from "@alpha-code/types"
import type { ResponseCreateParamsBase } from "openai/resources/responses/responses"

import type { ApiHandlerOptions } from "../../shared/api"
import { OpenAiHandler } from "./openai"

/** Native credentials and curated capabilities feed the shared Responses transport. */
export class OpenAiNativeHandler extends OpenAiHandler {
	protected override readonly providerId: string = "openai-native"

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
			taskReasoningCustomEffort: undefined,
		})
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
		this.options = { ...this.options, ...settings }
	}
}
