import type { ModelInfo } from "../model.js"

// Verified 2026-10-28 against /docs/en/models/{opus-5-5,sonnet-5-5,fable-5-1}/overview and
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
	"claude-fable-5-1": {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		requiredReasoningEffort: true,
		reasoningEffort: "high",
		preserveReasoning: true,
		inputPrice: 10,
		outputPrice: 50,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 0.25,
		minTokensPerCachePoint: 512,
		description: "Claude Fable 5.1: demanding reasoning and long-horizon agentic work",
	},
} as const satisfies Record<string, ModelInfo>

export type AnthropicModelId = keyof typeof anthropicModels
export const anthropicDefaultModelId: AnthropicModelId = "claude-opus-5-5"
