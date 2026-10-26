import {
	geminiDefaultModelId,
	geminiModels,
	getUnsupportedCuratedProviderSettings,
	resolveOptionalOutputTokenLimit,
	type ModelInfo,
} from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { getModelParams } from "../transform/model-params"
import { GeminiTransportHandler } from "./gemini"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"

function getNativeGeminiModelId(options: ApiHandlerOptions): string {
	const id = options.apiModelId === undefined ? geminiDefaultModelId : options.apiModelId.trim()
	if (!Object.hasOwn(geminiModels, id)) throw new Error(`Unsupported Gemini model: ${id}`)
	return id
}

function getNativeGeminiApiKey(options: ApiHandlerOptions): string {
	getNativeGeminiModelId(options)
	if (getUnsupportedCuratedProviderSettings("gemini", options).length > 0) {
		throw new Error("Native Gemini requires the official Google API endpoint.")
	}
	const apiKey = options.geminiApiKey?.trim()
	if (!apiKey) throw new Error("Gemini API key is required.")
	return apiKey
}

/** Direct API-key authentication over the shared Google protocol implementation. */
export class GeminiHandler extends GeminiTransportHandler {
	constructor(options: ApiHandlerOptions) {
		super(options, { provider: "gemini", apiKey: getNativeGeminiApiKey(options) })
	}

	override getModel() {
		const id = getNativeGeminiModelId(this.options)
		const info: ModelInfo = applyModelToolPreferences(
			{ provider: "gemini", id },
			geminiModels[id as keyof typeof geminiModels],
		)
		const params = getModelParams({
			format: "gemini",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 1,
		})
		const maxTokens = resolveOptionalOutputTokenLimit({
			model: info,
			settings: this.options,
			enforceModelMaximum: true,
		})
		return { id, info, ...params, maxTokens, toolIdentity: { provider: "gemini", id } }
	}
}
