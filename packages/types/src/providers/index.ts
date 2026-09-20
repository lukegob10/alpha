export * from "./openai.js"
export * from "./stellar.js"
export * from "./vertex.js"
export * from "./vscode-llm.js"

import { stellarDefaultModelId } from "./stellar.js"
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
	}
}
