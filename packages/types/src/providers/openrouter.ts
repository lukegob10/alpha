import type { ModelInfo } from "../model.js"

// Route metadata verified against https://openrouter.ai/api/v1/models and each
// model's /endpoints response on 2026-10-28. The selectable catalog stays frontier-only.
// Keep this curated catalog independent of native-provider defaults: router limits,
// pricing, and accepted reasoning settings can differ for the same model family.
const openAiCapabilities = {
	contextWindow: 1_050_000,
	maxTokens: 128_000,
	supportsImages: true,
	supportsPromptCache: true,
	supportsStreaming: true,
	supportsTemperature: false,
	supportsVerbosity: true,
	supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
	requiredReasoningEffort: true,
	reasoningEffort: "medium",
	preserveReasoning: true,
	longContextPricing: {
		thresholdTokens: 272_000,
		inputPriceMultiplier: 2,
		outputPriceMultiplier: 1.5,
		cacheReadsPriceMultiplier: 2,
		cacheWritesPriceMultiplier: 2,
	},
} satisfies ModelInfo

const anthropicCapabilities = {
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	supportsImages: true,
	supportsPromptCache: true,
	supportsStreaming: true,
	supportsTemperature: false,
	supportsVerbosity: true,
	supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
	requiredReasoningEffort: true,
	reasoningEffort: "high",
	preserveReasoning: true,
} satisfies ModelInfo

const grokCapabilities = {
	contextWindow: 500_000,
	// This is the router-listed output budget, separate from native xAI's default visible-output cap.
	maxTokens: 450_000,
	supportsImages: true,
	supportsPromptCache: true,
	supportsStreaming: true,
	supportsTemperature: true,
	supportsVerbosity: false,
	supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
	requiredReasoningEffort: true,
	reasoningEffort: "high",
	preserveReasoning: true,
	inputPrice: 2,
	outputPrice: 6,
	cacheReadsPrice: 0.5,
	longContextPricing: {
		thresholdTokens: 200_000,
		inputPriceMultiplier: 2,
		outputPriceMultiplier: 2,
		cacheReadsPriceMultiplier: 2,
	},
} satisfies ModelInfo

// Verified against OpenRouter's model and per-model endpoint APIs and
// https://platform.moonshot.ai/docs/guide/kimi-k3-1-pro-quickstart.
// OpenRouter lists "none" for Kimi, but Moonshot documents always-on reasoning.
// Keep the verified low/high/max subset until router-specific full Off is established.
const kimiProCapabilities = {
	contextWindow: 1_048_576,
	maxTokens: 943_718,
	supportsPromptCache: true,
	supportsStreaming: true,
	supportsVerbosity: false,
	supportsReasoningEffort: ["low", "high", "max"],
	requiredReasoningEffort: true,
	reasoningEffort: "max",
	preserveReasoning: true,
} satisfies ModelInfo

export const openRouterModels = {
	"openai/gpt-6.1-sol": {
		...openAiCapabilities,
		inputPrice: 2,
		outputPrice: 10,
		cacheReadsPrice: 0.1,
		cacheWritesPrice: 2.5,
	},
	"anthropic/claude-sonnet-5.5": {
		...anthropicCapabilities,
		inputPrice: 2,
		outputPrice: 10,
		cacheReadsPrice: 0.1,
		cacheWritesPrice: 2.5,
	},
	"google/gemini-4-argon": {
		contextWindow: 1_048_576,
		contextWindowIncludesOutput: true,
		maxTokens: 943_718,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: true,
		supportsReasoningEffort: ["low", "medium", "high"],
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		preserveReasoning: true,
		inputPrice: 2,
		outputPrice: 10,
		cacheReadsPrice: 0.1,
		cacheWritesPrice: 0.1875,
	},
	"openai/gpt-6-astra": {
		...openAiCapabilities,
		inputPrice: 10,
		outputPrice: 50,
		cacheReadsPrice: 1,
		cacheWritesPrice: 12.5,
	},
	"x-ai/grok-4.7": { ...grokCapabilities, defaultTemperature: 0.7 },
	"anthropic/claude-opus-5.5": {
		...anthropicCapabilities,
		inputPrice: 4,
		outputPrice: 20,
		cacheReadsPrice: 0.2,
		cacheWritesPrice: 5,
	},
	"anthropic/claude-fable-5.1": {
		...anthropicCapabilities,
		inputPrice: 10,
		outputPrice: 50,
		cacheReadsPrice: 0.25,
		cacheWritesPrice: 12.5,
	},
	"moonshotai/kimi-k3.1-pro": {
		...kimiProCapabilities,
		supportsImages: true,
		supportsTemperature: false,
		inputPrice: 2,
		outputPrice: 10,
		cacheReadsPrice: 0.2,
	},
	"meta/muse-wonder": {
		contextWindow: 1_048_576,
		contextWindowIncludesOutput: true,
		maxTokens: 943_718,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: true,
		supportsVerbosity: false,
		supportsReasoningEffort: ["minimal", "low", "medium", "high", "xhigh", "max"],
		requiredReasoningEffort: true,
		reasoningEffort: "high",
		preserveReasoning: true,
		inputPrice: 4,
		outputPrice: 20,
		cacheReadsPrice: 0.2,
	},
} as const satisfies Record<string, ModelInfo>

export type OpenRouterModelId = keyof typeof openRouterModels
export const openRouterDefaultModelId: OpenRouterModelId = "openai/gpt-6.1-sol"
