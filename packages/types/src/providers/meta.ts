import type { ModelInfo } from "../model.js"

// Verified 2026-10-28 against dev.meta.ai/docs/{models,reasoning,pricing-rate-limits}.
// Native output has no documented separate maximum; -1 keeps the server-selected limit.
export const metaModels = {
	"muse-wonder-1.0": {
		contextWindow: 1_048_576,
		contextWindowIncludesOutput: true,
		maxTokens: -1,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsVerbosity: false,
		supportsReasoningEffort: ["minimal", "low", "medium", "high", "xhigh", "max"],
		requiredReasoningEffort: true,
		// Alpha follows the coding-agents guide's recommended high starting point.
		reasoningEffort: "high",
		preserveReasoning: true,
		inputPrice: 4,
		outputPrice: 20,
		cacheReadsPrice: 0.2,
		description: "Muse Wonder: Meta's frontier model for coding and reasoning",
	},
} as const satisfies Record<string, ModelInfo>

export const metaDefaultModelId = "muse-wonder-1.0" as const
export type MetaModelId = keyof typeof metaModels
