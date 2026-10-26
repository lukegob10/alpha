export * from "./openai.js"
export * from "./openai-native.js"
export * from "./anthropic.js"
export * from "./gemini.js"
export * from "./xai.js"
export * from "./openrouter.js"
export * from "./stellar.js"
export * from "./vertex.js"
export * from "./vscode-llm.js"

import { stellarDefaultModelId } from "./stellar.js"
import { openAiNativeDefaultModelId } from "./openai-native.js"
import { anthropicDefaultModelId } from "./anthropic.js"
import { geminiDefaultModelId } from "./gemini.js"
import { xaiDefaultModelId } from "./xai.js"
import { openRouterDefaultModelId } from "./openrouter.js"
import { vertexDefaultModelId } from "./vertex.js"
import { vscodeLlmDefaultModelId } from "./vscode-llm.js"

import type { ProviderName } from "../provider-settings.js"

/**
 * Get the default model ID for a supported provider. OpenAI Compatible has no
 * static catalog, so its model is selected from profile settings.
 */
export function getProviderDefaultModelId(provider: ProviderName): string {
	switch (provider) {
		case "vertex":
			return vertexDefaultModelId
		case "stellar":
			return stellarDefaultModelId
		case "vscode-lm":
			return vscodeLlmDefaultModelId
		case "openai":
			return ""
		case "openai-native":
			return openAiNativeDefaultModelId
		case "anthropic":
			return anthropicDefaultModelId
		case "gemini":
			return geminiDefaultModelId
		case "xai":
			return xaiDefaultModelId
		case "openrouter":
			return openRouterDefaultModelId
	}
}
