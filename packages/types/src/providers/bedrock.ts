import type { ModelInfo } from "../model.js"

export const bedrockDefaultRegion = "us-east-1"
export const bedrockRegionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d+$/

// Verified 2026-10-28 against AWS Bedrock model-card-anthropic-claude-{opus-5-5,
// sonnet-5-5,fable-5-1}.html and model-card-openai-gpt-6-1-sol.html.
// Global inference profile IDs are explicit routes, not native-provider aliases.
const claudeCapabilities = {
	contextWindow: 1_000_000,
	contextWindowIncludesOutput: true,
	maxTokens: 128_000,
	supportsImages: true,
	supportsPromptCache: true,
	supportsStreaming: true,
	supportsTemperature: false,
	supportsVerbosity: false,
	supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
	requiredReasoningEffort: true,
	preserveReasoning: true,
} satisfies ModelInfo

const openAiLongContextPricing = {
	thresholdTokens: 272_000,
	inputPriceMultiplier: 2,
	outputPriceMultiplier: 1.5,
	cacheReadsPriceMultiplier: 2,
	cacheWritesPriceMultiplier: 2,
}

// USD per million tokens, Global Standard inference; Claude writes use the
// request's default five-minute TTL. Geo routing premiums belong to the adapter.
// https://aws.amazon.com/bedrock/pricing/ and the GPT model cards above (2026-10-28).
export const bedrockModels = {
	"global.anthropic.claude-opus-5-5": {
		...claudeCapabilities,
		reasoningEffort: "medium",
		inputPrice: 4,
		outputPrice: 20,
		cacheWritesPrice: 5,
		cacheReadsPrice: 0.2,
		description: "Claude Opus 5.5 on Amazon Bedrock",
	},
	"global.anthropic.claude-sonnet-5-5": {
		...claudeCapabilities,
		reasoningEffort: "high",
		inputPrice: 2,
		outputPrice: 10,
		cacheWritesPrice: 2.5,
		cacheReadsPrice: 0.1,
		description: "Claude Sonnet 5.5 on Amazon Bedrock",
	},
	"global.anthropic.claude-fable-5-1": {
		...claudeCapabilities,
		reasoningEffort: "high",
		inputPrice: 10,
		outputPrice: 50,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 0.25,
		description: "Claude Fable 5.1 on Amazon Bedrock",
	},
	"global.openai.gpt-6.1-sol": {
		contextWindow: 1_000_000,
		contextWindowIncludesOutput: true,
		maxTokens: 131_072,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsVerbosity: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		preserveReasoning: true,
		description: "GPT-6.1 Sol on Amazon Bedrock",
		inputPrice: 2,
		outputPrice: 10,
		cacheWritesPrice: 2.5,
		cacheReadsPrice: 0.1,
		longContextPricing: openAiLongContextPricing,
	},
	"global.openai.gpt-6-astra": {
		contextWindow: 1_050_000,
		contextWindowIncludesOutput: true,
		maxTokens: 128_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsVerbosity: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		preserveReasoning: true,
		description: "GPT-6 Astra on Amazon Bedrock",
		inputPrice: 10,
		outputPrice: 50,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 1,
		longContextPricing: openAiLongContextPricing,
	},
} as const satisfies Record<string, ModelInfo>

export type BedrockModelId = keyof typeof bedrockModels
export const bedrockDefaultModelId: BedrockModelId = "global.anthropic.claude-opus-5-5"
export type BedrockModelRoute = "anthropic-messages" | "openai-responses"

/** Imported ARNs and unknown model IDs cannot acquire another route's wire contract. */
export function getBedrockModelRoute(modelId: string): BedrockModelRoute | undefined {
	if (!Object.hasOwn(bedrockModels, modelId)) return undefined
	return modelId.startsWith("global.openai.") ? "openai-responses" : "anthropic-messages"
}
