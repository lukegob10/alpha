import type { ProviderSettings, ModelInfo } from "@alpha-code/types"
import {
	isProviderName,
	isCuratedProvider,
	getModelId,
	getProviderDefaultModelId,
	getCuratedModelInfo,
	openAiModelInfoSaneDefaults,
	resolveOpenAiCustomModelInfo,
	getVscodeLlmContextWindow,
	getVscodeLlmModelInfo,
	vertexDefaultModelId,
	vertexModels,
	resolveVertexOpenAiModelInfo,
	stellarDefaultModelId,
	resolveStellarModelInfo,
	vscodeLlmDefaultModelId,
} from "@alpha-code/types"

import { stringifyVsCodeLmModelSelector } from "../../../../../src/shared/vsCodeSelectorUtils"

/**
 * Resolve the model metadata used by the webview from the executable
 * providers. Provider discovery and model fetching belong to their provider
 * adapters; this hook only projects the current settings into UI metadata.
 */
export const useSelectedModel = (apiConfiguration?: ProviderSettings) => {
	const provider = apiConfiguration?.apiProvider ?? "vertex"

	if (!isProviderName(provider)) {
		return { provider, id: apiConfiguration?.apiModelId ?? "", info: undefined, isLoading: false, isError: false }
	}

	if (isCuratedProvider(provider)) {
		const id = getModelId(apiConfiguration ?? { apiProvider: provider }) ?? getProviderDefaultModelId(provider)
		const info = getCuratedModelInfo(provider, id)
		return { provider, id, info, isLoading: false, isError: info === undefined }
	}

	if (provider === "vertex") {
		const id = apiConfiguration?.apiModelId ?? vertexDefaultModelId
		const family = id.trim().toLowerCase()
		const info =
			family.includes("claude") || family.startsWith("gemini")
				? (vertexModels as Record<string, ModelInfo>)[id]
				: resolveVertexOpenAiModelInfo(id.trim())
		return {
			provider,
			id,
			info,
			isLoading: false,
			isError: false,
		}
	}

	if (provider === "stellar") {
		const id = apiConfiguration?.apiModelId ?? stellarDefaultModelId
		return {
			provider,
			id,
			info: resolveStellarModelInfo(id),
			isLoading: false,
			isError: false,
		}
	}

	if (provider === "openai") {
		const id = apiConfiguration?.openAiModelId ?? ""
		return {
			provider,
			id,
			info: resolveOpenAiCustomModelInfo(apiConfiguration?.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
			isLoading: false,
			isError: false,
		}
	}

	if (provider === "vscode-lm") {
		const selector = apiConfiguration?.vsCodeLmModelSelector
		const id = selector ? stringifyVsCodeLmModelSelector(selector) : vscodeLlmDefaultModelId
		const info = selector ? getVscodeLlmModelInfo(selector) : undefined
		return {
			provider,
			id,
			info: {
				...openAiModelInfoSaneDefaults,
				...info,
				contextWindow: getVscodeLlmContextWindow(
					selector ?? { vendor: "copilot", family: vscodeLlmDefaultModelId },
					apiConfiguration?.vsCodeLmContextSize,
				),
				contextWindowIncludesOutput: false,
			} as ModelInfo,
			isLoading: false,
			isError: false,
		}
	}

	// Keep unrecognized settings recoverable without assigning another provider metadata.
	return {
		provider,
		id: apiConfiguration?.apiModelId ?? "",
		info: undefined,
		isLoading: false,
		isError: false,
	}
}
