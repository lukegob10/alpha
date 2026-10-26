import type { ModelInfo } from "../model.js"

// Verified 2026-10-25 against the official model cards:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// https://developers.openai.com/api/docs/pricing (Standard, 30-minute cache writes)
// The cards distinguish the 922K input limit from the 1.05M combined window.
const frontierModel: ModelInfo = {
	contextWindow: 922_000,
	contextWindowIncludesOutput: false,
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
}

const optionalReasoningModel: ModelInfo = {
	...frontierModel,
	supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
	requiredReasoningEffort: false,
}

export const openAiNativeModels = {
	"gpt-6.1-sol": {
		...frontierModel,
		description: "GPT-6.1 Sol",
		inputPrice: 2,
		outputPrice: 10,
		cacheReadsPrice: 0.1,
		cacheWritesPrice: 2.5,
	},
	"gpt-6-astra": {
		...frontierModel,
		description: "GPT-6 Astra",
		inputPrice: 10,
		outputPrice: 50,
		cacheReadsPrice: 1,
		cacheWritesPrice: 12.5,
	},
	"gpt-6-luna": {
		...optionalReasoningModel,
		description: "GPT-6 Luna",
		inputPrice: 0.1,
		outputPrice: 0.5,
		cacheReadsPrice: 0.01,
		cacheWritesPrice: 0.125,
	},
	"gpt-5.6-sol": {
		...optionalReasoningModel,
		description: "GPT-5.6 Sol",
		inputPrice: 4,
		outputPrice: 20,
		cacheReadsPrice: 0.4,
		cacheWritesPrice: 5,
	},
	"gpt-5.6-terra": {
		...optionalReasoningModel,
		description: "GPT-5.6 Terra",
		inputPrice: 2,
		outputPrice: 12,
		cacheReadsPrice: 0.2,
		cacheWritesPrice: 2.5,
	},
	"gpt-5.6-luna": {
		...optionalReasoningModel,
		description: "GPT-5.6 Luna",
		inputPrice: 0.2,
		outputPrice: 1.2,
		cacheReadsPrice: 0.02,
		cacheWritesPrice: 0.25,
	},
} as const satisfies Record<string, ModelInfo>

export type OpenAiNativeModelId = keyof typeof openAiNativeModels
export const openAiNativeDefaultModelId: OpenAiNativeModelId = "gpt-6.1-sol"
