import type { ModelInfo } from "../model.js"

// Route metadata verified against https://openrouter.ai/api/v1/models on 2026-10-25.
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

const optionalOpenAiCapabilities = {
	...openAiCapabilities,
	supportsReasoningEffort: ["none", ...openAiCapabilities.supportsReasoningEffort],
	requiredReasoningEffort: false,
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

// Verified 2026-10-25 against OpenRouter's model and per-model endpoint APIs,
// https://docs.z.ai/guides/llm/glm-5.3 and https://docs.z.ai/guides/vlm/glm-5.3-flash,
// https://platform.moonshot.ai/docs/guide/kimi-k3-quickstart and
// https://platform.moonshot.ai/docs/guide/kimi-k3-1-pro-quickstart.
// OpenRouter lists "none" for Kimi, but Moonshot documents always-on reasoning.
// Keep the verified low/high/max subset until router-specific full Off is established.
const kimiGlmCapabilities = {
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
	"google/gemini-3.8-flash": {
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: true,
		defaultTemperature: 1,
		supportsReasoningEffort: ["low", "medium", "high"],
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		preserveReasoning: true,
		inputPrice: 0.825,
		outputPrice: 4.125,
		cacheReadsPrice: 0.0825,
		cacheWritesPrice: 0.0416666666666667,
	},
	"openai/gpt-6-luna": {
		...optionalOpenAiCapabilities,
		inputPrice: 0.1,
		outputPrice: 0.5,
		cacheReadsPrice: 0.01,
		cacheWritesPrice: 0.125,
	},
	"openai/gpt-5.6-sol": {
		...optionalOpenAiCapabilities,
		inputPrice: 4,
		outputPrice: 20,
		cacheReadsPrice: 0.4,
		cacheWritesPrice: 5,
	},
	"openai/gpt-5.6-terra": {
		...optionalOpenAiCapabilities,
		inputPrice: 2,
		outputPrice: 12,
		cacheReadsPrice: 0.2,
		cacheWritesPrice: 2.5,
	},
	"openai/gpt-5.6-luna": {
		...optionalOpenAiCapabilities,
		inputPrice: 0.2,
		outputPrice: 1.2,
		cacheReadsPrice: 0.02,
		cacheWritesPrice: 0.25,
	},
	"x-ai/grok-4.6": { ...grokCapabilities },
	"x-ai/grok-4.7": { ...grokCapabilities, defaultTemperature: 0.7 },
	"anthropic/claude-opus-5.5": {
		...anthropicCapabilities,
		inputPrice: 4,
		outputPrice: 20,
		cacheReadsPrice: 0.2,
		cacheWritesPrice: 5,
	},
	"anthropic/claude-haiku-5.5": {
		...anthropicCapabilities,
		// The router's "none" effort encodes full Off without retaining a conflicting native effort.
		supportsReasoningEffort: ["none", ...anthropicCapabilities.supportsReasoningEffort],
		requiredReasoningEffort: false,
		reasoningEffort: "medium",
		inputPrice: 0.1,
		outputPrice: 0.5,
		cacheReadsPrice: 0.01,
		cacheWritesPrice: 0.125,
		longContextPricing: {
			thresholdTokens: 100_000,
			inputPriceMultiplier: 5,
			outputPriceMultiplier: 5,
			cacheReadsPriceMultiplier: 5,
			cacheWritesPriceMultiplier: 5,
		},
	},
	"moonshotai/kimi-k3.1-pro": {
		...kimiGlmCapabilities,
		supportsImages: true,
		supportsTemperature: false,
		inputPrice: 2,
		outputPrice: 10,
		cacheReadsPrice: 0.2,
	},
	"moonshotai/kimi-k3": {
		...kimiGlmCapabilities,
		supportsImages: true,
		supportsTemperature: true,
		inputPrice: 0.239,
		outputPrice: 10.8,
		cacheReadsPrice: 0.21,
	},
	"z-ai/glm-5.3": {
		...kimiGlmCapabilities,
		supportsImages: false,
		supportsTemperature: true,
		defaultTemperature: 1,
		inputPrice: 0.079,
		outputPrice: 1.4,
		cacheReadsPrice: 0.078,
	},
	"z-ai/glm-5.3-flash": {
		...kimiGlmCapabilities,
		// The router's top endpoint advertises one fewer output token than the model-level window.
		maxTokens: 943_717,
		supportsImages: true,
		supportsTemperature: true,
		defaultTemperature: 1,
		inputPrice: 0.15,
		outputPrice: 0.5,
		cacheReadsPrice: 0.03,
	},
} as const satisfies Record<string, ModelInfo>

export type OpenRouterModelId = keyof typeof openRouterModels
export const openRouterDefaultModelId: OpenRouterModelId = "openai/gpt-6.1-sol"
