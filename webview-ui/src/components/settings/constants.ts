import {
	type ProviderName,
	type ModelInfo,
	vertexModels,
	stellarModels,
	CURATED_MODELS_BY_PROVIDER,
} from "@alpha-code/types"

export const MODELS_BY_PROVIDER: Partial<Record<ProviderName, Record<string, ModelInfo>>> = {
	vertex: vertexModels,
	stellar: stellarModels,
	...CURATED_MODELS_BY_PROVIDER,
}

export const PROVIDERS = [
	{ value: "vertex", label: "GCP Vertex AI", proxy: false },
	{ value: "openai", label: "OpenAI Compatible", proxy: true },
	{ value: "stellar", label: "Stellar", proxy: false },
	{ value: "vscode-lm", label: "VS Code LM API", proxy: false },
	{ value: "openai-native", label: "OpenAI", proxy: false },
	{ value: "anthropic", label: "Anthropic", proxy: false },
	{ value: "gemini", label: "Google Gemini", proxy: false },
	{ value: "xai", label: "xAI", proxy: false },
	{ value: "openrouter", label: "OpenRouter", proxy: true },
	{ value: "bedrock", label: "Amazon Bedrock", proxy: false },
	{ value: "openai-codex", label: "Sign in with ChatGPT", proxy: false },
	{ value: "meta", label: "Meta", proxy: false },
].sort((a, b) => a.label.localeCompare(b.label))
