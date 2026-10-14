import type { ModelInfo } from "../model.js"

export const stellarDefaultModelId = "Meta-Llama-3.3-70B-Instruct" as const

export type StellarModelId = keyof typeof stellarModels

export const stellarModels = {
	[stellarDefaultModelId]: {
		maxTokens: 8192,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		supportsStreaming: true,
		supportsTemperature: true,
		defaultTemperature: 0.7,
		description: "Meta Llama 3.3 70B Instruct hosted on the internal Stellar model gateway.",
	},
} as const satisfies Record<string, ModelInfo>

/** Preserve the gateway's legacy fallback consistently in the editor and adapter. */
export function resolveStellarModelInfo(modelId: string): ModelInfo {
	return stellarModels[modelId as StellarModelId] ?? stellarModels[stellarDefaultModelId]
}
