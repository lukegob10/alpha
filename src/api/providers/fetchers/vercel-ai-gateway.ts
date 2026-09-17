import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@alpha-code/types"
import { VERCEL_AI_GATEWAY_VISION_ONLY_MODELS, VERCEL_AI_GATEWAY_VISION_AND_TOOLS_MODELS } from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"
import { parseApiPrice } from "../../../shared/cost"

/**
 * VercelAiGatewayPricing
 */

const vercelAiGatewayPricingSchema = z.object({
	input: z.string().optional(), // Image models don't have an input price.
	output: z.string().optional(), // Embedding and image models don't have an output price.
	input_cache_write: z.string().optional(),
	input_cache_read: z.string().optional(),
	image: z.string().optional(), // Only image models have an image price.
})

/**
 * VercelAiGatewayModel
 */

const vercelAiGatewayCatalogModelSchema = z.object({
	id: z.string(),
	object: z.string(),
	created: z.number(),
	owned_by: z.string(),
	name: z.string(),
	description: z.string(),
	// Non-language catalog entries do not consistently publish token limits.
	context_window: z.number().positive().optional(),
	max_tokens: z.number().positive().optional(),
	type: z.string(),
	pricing: vercelAiGatewayPricingSchema,
})

const vercelAiGatewayModelSchema = vercelAiGatewayCatalogModelSchema.extend({
	type: z.literal("language"),
	context_window: z.number().positive(),
	max_tokens: z.number().positive(),
})

export type VercelAiGatewayModel = z.infer<typeof vercelAiGatewayModelSchema>

/**
 * VercelAiGatewayModelsResponse
 */

const vercelAiGatewayModelsResponseSchema = z.object({
	object: z.string(),
	data: z.array(vercelAiGatewayCatalogModelSchema),
})

type VercelAiGatewayModelsResponse = z.infer<typeof vercelAiGatewayModelsResponseSchema>

/**
 * getVercelAiGatewayModels
 */

export async function getVercelAiGatewayModels(options?: ApiHandlerOptions): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}
	const baseURL = "https://ai-gateway.vercel.sh/v1"

	try {
		const response = await axios.get<VercelAiGatewayModelsResponse>(`${baseURL}/models`)
		const result = vercelAiGatewayModelsResponseSchema.safeParse(response.data)
		const rawData = (response.data as { data?: unknown })?.data
		if (!Array.isArray(rawData)) {
			console.error("Vercel AI Gateway models response is invalid: data is not an array")
			return models
		}
		const data: unknown[] = result.success ? result.data.data : rawData
		if (!result.success) {
			console.error("Vercel AI Gateway response metadata is invalid; validating catalog entries individually")
		}

		let skippedLanguageModels = 0
		for (const candidate of data) {
			const catalogModel = vercelAiGatewayCatalogModelSchema.safeParse(candidate)
			if (!catalogModel.success) {
				if (
					typeof candidate === "object" &&
					candidate !== null &&
					(candidate as { type?: unknown }).type === "language"
				) {
					skippedLanguageModels++
				}
				continue
			}
			if (catalogModel.data.type !== "language") continue
			const parsedModel = vercelAiGatewayModelSchema.safeParse(catalogModel.data)
			if (!parsedModel.success) {
				skippedLanguageModels++
				continue
			}
			const model = parsedModel.data
			const { id } = model

			models[id] = parseVercelAiGatewayModel({ id, model })
		}
		if (skippedLanguageModels > 0) {
			console.warn(
				`Skipped ${skippedLanguageModels} Vercel AI Gateway language model${skippedLanguageModels === 1 ? "" : "s"} with incomplete token metadata`,
			)
		}
	} catch (error) {
		console.error(
			`Error fetching Vercel AI Gateway models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
	}

	return models
}

/**
 * parseVercelAiGatewayModel
 */

export const parseVercelAiGatewayModel = ({ id, model }: { id: string; model: VercelAiGatewayModel }): ModelInfo => {
	const cacheWritesPrice = model.pricing?.input_cache_write
		? parseApiPrice(model.pricing?.input_cache_write)
		: undefined

	const cacheReadsPrice = model.pricing?.input_cache_read ? parseApiPrice(model.pricing?.input_cache_read) : undefined

	const supportsPromptCache = typeof cacheWritesPrice !== "undefined" && typeof cacheReadsPrice !== "undefined"
	const supportsImages =
		VERCEL_AI_GATEWAY_VISION_ONLY_MODELS.has(id) || VERCEL_AI_GATEWAY_VISION_AND_TOOLS_MODELS.has(id)

	const modelInfo: ModelInfo = {
		maxTokens: model.max_tokens,
		contextWindow: model.context_window,
		supportsImages,
		supportsPromptCache,
		inputPrice: parseApiPrice(model.pricing?.input),
		outputPrice: parseApiPrice(model.pricing?.output),
		cacheWritesPrice,
		cacheReadsPrice,
		description: model.description,
	}

	return modelInfo
}
