import { embeddingDefaultModels, embeddingModelProfiles, type EmbedderProvider } from "@alpha-code/types"

export const EMBEDDING_MODEL_PROFILES = embeddingModelProfiles

export function getModelDimension(provider: EmbedderProvider, modelId: string): number | undefined {
	return EMBEDDING_MODEL_PROFILES[provider]?.[modelId]?.dimension
}

export function getModelScoreThreshold(provider: EmbedderProvider, modelId: string): number | undefined {
	return EMBEDDING_MODEL_PROFILES[provider]?.[modelId]?.scoreThreshold
}

export function getDefaultModelId(provider: EmbedderProvider): string {
	return embeddingDefaultModels[provider]
}
