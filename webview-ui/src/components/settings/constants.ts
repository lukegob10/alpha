import { type ProviderName, type ModelInfo, vertexModels, stellarModels } from "@alpha-code/types"

export const MODELS_BY_PROVIDER: Partial<Record<ProviderName, Record<string, ModelInfo>>> = {
	vertex: vertexModels,
	stellar: stellarModels,
}

export const PROVIDERS = [
	{ value: "vertex", label: "GCP Vertex AI", proxy: false },
	{ value: "openai", label: "OpenAI Compatible", proxy: true },
	{ value: "stellar", label: "Stellar", proxy: false },
	{ value: "vscode-lm", label: "VS Code LM API", proxy: false },
].sort((a, b) => a.label.localeCompare(b.label))
