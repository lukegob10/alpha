import type { ModelInfo } from "../model.js"

export interface NativeOpenAiModelCapabilities {
	readonly responses: boolean
	readonly freeformApplyPatch: boolean
}

const RESPONSES_WITH_FREEFORM_PATCH: NativeOpenAiModelCapabilities = Object.freeze({
	responses: true,
	freeformApplyPatch: true,
})

// Exact compatibility entries preserve existing routes without guessing the
// capabilities of previews, deployments, compatible providers, or future models.
// GPT-6.1 Sol requires Responses for tools (official API docs, 2026-10-03).
// Its patch capability is independently declared in Codex's model catalog at
// b741e480e203f037ca726bc2a76d99a8e8668e66, codex-rs/models-manager/models.json.
const NATIVE_OPENAI_MODEL_CAPABILITIES = new Map<string, NativeOpenAiModelCapabilities>([
	["gpt-5.4", RESPONSES_WITH_FREEFORM_PATCH],
	["gpt-5.5", RESPONSES_WITH_FREEFORM_PATCH],
	["gpt-5.6-luna", RESPONSES_WITH_FREEFORM_PATCH],
	["gpt-5.6-sol", RESPONSES_WITH_FREEFORM_PATCH],
	["gpt-5.6-terra", RESPONSES_WITH_FREEFORM_PATCH],
	["gpt-6-astra", RESPONSES_WITH_FREEFORM_PATCH],
	["gpt-6-luna", RESPONSES_WITH_FREEFORM_PATCH],
	["gpt-6-sol", RESPONSES_WITH_FREEFORM_PATCH],
	["gpt-6.1-sol", RESPONSES_WITH_FREEFORM_PATCH],
])

export function getNativeOpenAiModelCapabilities(
	modelId: string,
	baseUrl?: string,
	useAzure?: boolean,
): NativeOpenAiModelCapabilities | undefined {
	if (useAzure) return undefined
	const capabilities = NATIVE_OPENAI_MODEL_CAPABILITIES.get(modelId)
	if (!capabilities) return undefined
	if (!baseUrl?.trim()) return capabilities

	try {
		const url = new URL(baseUrl)
		return url.origin === "https://api.openai.com" &&
			!url.username &&
			!url.password &&
			(url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/") &&
			!url.search &&
			!url.hash
			? capabilities
			: undefined
	} catch {
		return undefined
	}
}
/** Levels declared by the custom-model settings editor, not inferred from a model ID. */
export const openAiCustomReasoningEfforts = ["low", "medium", "high", "xhigh", "max"] as const

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
