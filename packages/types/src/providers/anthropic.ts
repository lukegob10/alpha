import type { ModelInfo } from "../model.js"

// Verified 2026-10-25 against /en/models/{opus,sonnet,haiku}-5-5/overview and
// /en/build-with-claude/effort at platform.claude.com. Keep direct API IDs separate from cloud routes.
export const anthropicModels = {
	"claude-opus-5-5": {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		preserveReasoning: true,
		inputPrice: 4,
		outputPrice: 20,
		cacheWritesPrice: 5,
		cacheReadsPrice: 0.2,
		minTokensPerCachePoint: 512,
		description: "Claude Opus 5.5: adaptive reasoning for coding and long-running agent tasks",
	},
	"claude-sonnet-5-5": {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		// between_tools still reasons during tool use; it is not a full Off setting.
		requiredReasoningEffort: true,
		reasoningEffort: "high",
		preserveReasoning: true,
		inputPrice: 2,
		outputPrice: 10,
		cacheWritesPrice: 2.5,
		cacheReadsPrice: 0.1,
		minTokensPerCachePoint: 512,
		description: "Claude Sonnet 5.5: balanced intelligence and speed for coding and agent tasks",
	},
	"claude-haiku-5-5": {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		requiredReasoningEffort: false,
		reasoningEffort: "medium",
		preserveReasoning: true,
		inputPrice: 0.1,
		outputPrice: 0.5,
		cacheWritesPrice: 0.125,
		cacheReadsPrice: 0.01,
		longContextPricing: {
			thresholdTokens: 100_000,
			inputPriceMultiplier: 5,
			outputPriceMultiplier: 5,
			cacheWritesPriceMultiplier: 5,
			cacheReadsPriceMultiplier: 5,
		},
		minTokensPerCachePoint: 512,
		description: "Claude Haiku 5.5: fast reasoning for tool tasks and high-volume work",
	},
} as const satisfies Record<string, ModelInfo>

export type AnthropicModelId = keyof typeof anthropicModels
export const anthropicDefaultModelId: AnthropicModelId = "claude-opus-5-5"
