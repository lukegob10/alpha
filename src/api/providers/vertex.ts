import {
	type ModelInfo,
	type VertexModelId,
	vertexDefaultModelId,
	vertexModels,
	validateOptionalOutputTokenLimit,
} from "@alpha-code/types"

import { type ApiHandlerOptions, shouldUseReasoningBudget } from "../../shared/api"

import { getModelParams } from "../transform/model-params"

import { VertexGeminiHandler } from "./gemini"
import { SingleCompletionHandler } from "../index"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"

export class VertexHandler extends VertexGeminiHandler implements SingleCompletionHandler {
	constructor(options: ApiHandlerOptions) {
		super(options)
	}

	override getModel() {
		const modelId = this.options.apiModelId
		let id: string = modelId && modelId in vertexModels ? (modelId as VertexModelId) : vertexDefaultModelId
		let info: ModelInfo = vertexModels[id as VertexModelId]

		// Keep newly-released Gemini model IDs usable before the static model catalog is updated.
		// Falling back to the default Claude ID would route a Gemini request through the Gemini handler
		// with a Claude model name, which Vertex rejects as an invalid request.
		if (modelId?.startsWith("gemini-") && !(modelId in vertexModels)) {
			id = modelId
			// Keep the catalog row's conservative transport/context metadata, but
			// never clone its sampling or reasoning contract onto an unknown model. A newly
			// released Gemini ID must be treated as capability-unavailable until its
			// wire capabilities are verified and added to the catalog.
			info = { ...vertexModels["gemini-3.7-flash"] }
			info.supportsTemperature = false
			delete info.supportsReasoningEffort
			delete info.reasoningEffort
			delete info.supportsReasoningBudget
			delete info.requiredReasoningBudget
			delete info.supportsReasoningBinary
			delete info.requiredReasoningEffort
		}

		const settings = shouldUseReasoningBudget({ model: info, settings: this.options })
			? { ...this.options, modelMaxTokens: validateOptionalOutputTokenLimit(this.options.modelMaxTokens) }
			: this.options
		const params = getModelParams({
			format: "gemini",
			modelId: id,
			model: info,
			settings,
			defaultTemperature: info.defaultTemperature ?? 1,
		})

		info = applyModelToolPreferences({ provider: "vertex", id }, info)

		// The `:thinking` suffix indicates that the model is a "Hybrid"
		// reasoning model and that reasoning is required to be enabled.
		// The actual model ID honored by Gemini's API does not have this
		// suffix.
		const resolvedId = id.endsWith(":thinking") ? id.replace(":thinking", "") : id
		return { id: resolvedId, info, ...params, toolIdentity: { provider: "vertex", id: resolvedId } }
	}
}
