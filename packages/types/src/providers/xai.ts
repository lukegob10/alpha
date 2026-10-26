import type { ModelInfo } from "../model.js"

export const xaiDefaultModelId = "grok-4.7" as const

export type XAIModelId = keyof typeof xaiModels

// Verified 2026-10-25 against https://docs.x.ai/developers/models/grok-4.6,
// https://docs.x.ai/developers/models/grok-4.7, and /model-capabilities/text/reasoning
// plus /model-capabilities/text/best-practices. Both models share these native API capabilities.
// maxTokens is the documented default visible-output cap, not a reasoning budget.
const grokReasoningModel = {
	maxTokens: 128_000,
	contextWindow: 500_000,
	supportsImages: true,
	supportsPromptCache: true,
	supportsStreaming: true,
	supportsTemperature: true,
	defaultTemperature: 0.7,
	supportsVerbosity: false,
	supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
	requiredReasoningEffort: true,
	reasoningEffort: "high",
	preserveReasoning: true,
} as const satisfies ModelInfo

export const xaiModels = {
	[xaiDefaultModelId]: {
		...grokReasoningModel,
		description: "Grok 4.7: xAI's frontier model for coding and agentic tasks.",
	},
	"grok-4.6": {
		...grokReasoningModel,
		description: "Grok 4.6: xAI's reasoning model for coding and agentic tasks.",
	},
} as const satisfies Record<string, ModelInfo>

/** A saved unsupported model must never silently acquire another model's capabilities. */
export function resolveXaiModelInfo(modelId: string): ModelInfo {
	if (!Object.hasOwn(xaiModels, modelId)) {
		throw new Error(`Unsupported xAI model: ${modelId}`)
	}
	return xaiModels[modelId as XAIModelId]
}
