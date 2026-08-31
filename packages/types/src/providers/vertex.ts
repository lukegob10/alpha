import type { ModelInfo } from "../model.js"

// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude
export type VertexModelId = keyof typeof vertexModels

export const vertexDefaultModelId: VertexModelId = "claude-sonnet-5"

export const vertexModels = {
	"gemini-3.7-flash": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high"],
		reasoningEffort: "medium",
		supportsTemperature: false,
		inputPrice: 0.75,
		outputPrice: 3.75,
		cacheReadsPrice: 0.075,
		description: "Gemini 3.7 Flash: Google's latest production Flash model for coding and agents",
	},
	"gemini-3.6-flash": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["minimal", "low", "medium", "high"],
		reasoningEffort: "medium",
		supportsTemperature: false,
		inputPrice: 0.75,
		outputPrice: 3.75,
		cacheReadsPrice: 0.075,
		description: "Gemini 3.6 Flash: Fast production model for grounded and agentic workloads",
	},
	"gemini-3.1-pro-preview": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high"],
		reasoningEffort: "low",

		supportsTemperature: true,
		defaultTemperature: 1,
		inputPrice: 4.0,
		outputPrice: 18.0,
		cacheReadsPrice: 0.4,
		cacheWritesPrice: 4.5,
		tiers: [
			{
				contextWindow: 200_000,
				inputPrice: 2.0,
				outputPrice: 12.0,
				cacheReadsPrice: 0.2,
			},
			{
				contextWindow: Infinity,
				inputPrice: 4.0,
				outputPrice: 18.0,
				cacheReadsPrice: 0.4,
			},
		],
	},
	"gemini-3.1-pro-preview-customtools": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high"],
		reasoningEffort: "low",

		supportsTemperature: true,
		defaultTemperature: 1,
		inputPrice: 4.0,
		outputPrice: 18.0,
		cacheReadsPrice: 0.4,
		cacheWritesPrice: 4.5,
		tiers: [
			{
				contextWindow: 200_000,
				inputPrice: 2.0,
				outputPrice: 12.0,
				cacheReadsPrice: 0.2,
			},
			{
				contextWindow: Infinity,
				inputPrice: 4.0,
				outputPrice: 18.0,
				cacheReadsPrice: 0.4,
			},
		],
	},
	"gemini-3.5-flash": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["minimal", "low", "medium", "high"],
		reasoningEffort: "medium",

		supportsTemperature: true,
		defaultTemperature: 1,
		inputPrice: 1.5,
		outputPrice: 9.0,
		cacheReadsPrice: 0.15,
	},
	"gemini-3.5-flash-lite": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["minimal", "low", "medium", "high"],
		reasoningEffort: "minimal",

		supportsTemperature: true,
		defaultTemperature: 1,
		inputPrice: 0.3,
		outputPrice: 2.5,
		cacheReadsPrice: 0.03,
		description: "Gemini 3.5 Flash-Lite: Cost-efficient model for high-volume agentic tasks",
	},
	"gemini-3.1-flash-lite": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["minimal", "low", "medium", "high"],
		reasoningEffort: "minimal",

		supportsTemperature: true,
		defaultTemperature: 1,
		inputPrice: 0.25,
		outputPrice: 1.5,
		cacheReadsPrice: 0.025,
	},
	"xai/grok-4.6": {
		maxTokens: 65_536,
		contextWindow: 524_288,
		supportsImages: true,
		supportsPromptCache: false,
		supportsStreaming: true,
		supportsTemperature: true,
		defaultTemperature: 0,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		inputPrice: 2.0,
		outputPrice: 6.0,
		description:
			"Grok 4.6 on Vertex AI (Preview): xAI's model for coding, agentic tasks, and knowledge work; available through the global endpoint",
		includedTools: ["search_replace"],
		excludedTools: ["apply_diff"],
	},
	"claude-fable-5": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 11.0,
		outputPrice: 55.0,
		cacheWritesPrice: 13.75,
		cacheReadsPrice: 1.1,
		supportsTemperature: false,
		description: "Claude Fable 5: Anthropic's most capable widely released long-horizon agent model",
	},
	"claude-opus-5": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.5,
		outputPrice: 27.5,
		cacheWritesPrice: 6.875,
		cacheReadsPrice: 0.55,
		supportsTemperature: false,
		description: "Claude Opus 5: Advanced model for complex agentic coding and enterprise work",
	},
	"claude-sonnet-5": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 2.2,
		outputPrice: 11.0,
		cacheWritesPrice: 2.75,
		cacheReadsPrice: 0.22,
		supportsTemperature: false,
		description: "Claude Sonnet 5: Fast model balancing frontier intelligence and cost",
	},
	"claude-sonnet-4-6": {
		maxTokens: 8192,
		contextWindow: 200_000, // Default 200K, extendable to 1M with beta flag 'context-1m-2025-08-07'
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0, // $3 per million input tokens (≤200K context)
		outputPrice: 15.0, // $15 per million output tokens (≤200K context)
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
		supportsReasoningBudget: true,
		// Tiered pricing for extended context (requires beta flag 'context-1m-2025-08-07')
		tiers: [
			{
				contextWindow: 1_000_000, // 1M tokens with beta flag
				inputPrice: 6.0, // $6 per million input tokens (>200K context)
				outputPrice: 22.5, // $22.50 per million output tokens (>200K context)
				cacheWritesPrice: 7.5, // $7.50 per million tokens (>200K context)
				cacheReadsPrice: 0.6, // $0.60 per million tokens (>200K context)
			},
		],
	},
	"claude-opus-4-6": {
		maxTokens: 8192,
		contextWindow: 200_000, // Default 200K, extendable to 1M with beta flag 'context-1m-2025-08-07'
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.0, // $5 per million input tokens (≤200K context)
		outputPrice: 25.0, // $25 per million output tokens (≤200K context)
		cacheWritesPrice: 6.25, // $6.25 per million tokens
		cacheReadsPrice: 0.5, // $0.50 per million tokens
		supportsReasoningBudget: true,
		// Tiered pricing for extended context (requires beta flag 'context-1m-2025-08-07')
		tiers: [
			{
				contextWindow: 1_000_000, // 1M tokens with beta flag
				inputPrice: 10.0, // $10 per million input tokens (>200K context)
				outputPrice: 37.5, // $37.50 per million output tokens (>200K context)
				cacheWritesPrice: 12.5, // $12.50 per million tokens (>200K context)
				cacheReadsPrice: 1.0, // $1.00 per million tokens (>200K context)
			},
		],
	},
	"claude-opus-4-8": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.5,
		outputPrice: 27.5,
		cacheWritesPrice: 6.875,
		cacheReadsPrice: 0.55,
		supportsTemperature: false,
	},
	"claude-opus-4-7": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.5,
		outputPrice: 27.5,
		cacheWritesPrice: 6.875,
		cacheReadsPrice: 0.55,
		supportsTemperature: false,
	},
} as const satisfies Record<string, ModelInfo>

// Vertex AI models that support 1M context window beta
// Uses the same beta header 'context-1m-2025-08-07' as Anthropic and Bedrock
export const VERTEX_1M_CONTEXT_MODEL_IDS = ["claude-sonnet-4-6", "claude-opus-4-6"] as const

export const VERTEX_REGIONS = [
	{ value: "global", label: "global" },
	{ value: "us", label: "us" },
	{ value: "us-central1", label: "us-central1" },
	{ value: "us-east1", label: "us-east1" },
	{ value: "us-east4", label: "us-east4" },
	{ value: "us-east5", label: "us-east5" },
	{ value: "us-south1", label: "us-south1" },
	{ value: "us-west1", label: "us-west1" },
	{ value: "us-west2", label: "us-west2" },
	{ value: "us-west3", label: "us-west3" },
	{ value: "us-west4", label: "us-west4" },
	{ value: "northamerica-northeast1", label: "northamerica-northeast1" },
	{ value: "northamerica-northeast2", label: "northamerica-northeast2" },
	{ value: "southamerica-east1", label: "southamerica-east1" },
	{ value: "europe-west1", label: "europe-west1" },
	{ value: "europe-west2", label: "europe-west2" },
	{ value: "europe-west3", label: "europe-west3" },
	{ value: "europe-west4", label: "europe-west4" },
	{ value: "europe-west6", label: "europe-west6" },
	{ value: "europe-central2", label: "europe-central2" },
	{ value: "asia-east1", label: "asia-east1" },
	{ value: "asia-east2", label: "asia-east2" },
	{ value: "asia-northeast1", label: "asia-northeast1" },
	{ value: "asia-northeast2", label: "asia-northeast2" },
	{ value: "asia-northeast3", label: "asia-northeast3" },
	{ value: "asia-south1", label: "asia-south1" },
	{ value: "asia-south2", label: "asia-south2" },
	{ value: "asia-southeast1", label: "asia-southeast1" },
	{ value: "asia-southeast2", label: "asia-southeast2" },
	{ value: "australia-southeast1", label: "australia-southeast1" },
	{ value: "australia-southeast2", label: "australia-southeast2" },
	{ value: "me-west1", label: "me-west1" },
	{ value: "me-central1", label: "me-central1" },
	{ value: "africa-south1", label: "africa-south1" },
]
