import type { ModelInfo } from "../model.js"

/** Levels declared by the custom-model settings editor, not inferred from a model ID. */
export const openAiCustomReasoningEfforts = ["low", "medium", "high", "xhigh"] as const

/** Read legacy editor profiles without rewriting them or widening explicit capabilities. */
export function resolveOpenAiCustomModelInfo(info: ModelInfo): ModelInfo {
	if (
		info.supportsReasoningEffort === undefined &&
		info.reasoningEffort !== undefined &&
		openAiCustomReasoningEfforts.some((effort) => effort === info.reasoningEffort) &&
		!info.supportsReasoningBudget &&
		!info.requiredReasoningBudget &&
		!info.supportsReasoningBinary
	) {
		return { ...info, supportsReasoningEffort: [...openAiCustomReasoningEfforts] }
	}
	return info
}

/** Conservative metadata used for user-configured OpenAI-compatible models. */
export const openAiModelInfoSaneDefaults: ModelInfo = {
	maxTokens: -1,
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: false,
	inputPrice: 0,
	outputPrice: 0,
}

// https://learn.microsoft.com/en-us/azure/ai-services/openai/api-version-deprecation
// https://learn.microsoft.com/en-us/azure/ai-services/openai/reference#api-specs
export const azureOpenAiDefaultApiVersion = "2024-08-01-preview"

export const OPENAI_AZURE_AI_INFERENCE_PATH = "/models/chat/completions"
