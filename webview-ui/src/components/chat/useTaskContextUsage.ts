import { useMemo } from "react"

import type { LiveTaskMetadata, ProviderSettings } from "@alpha-code/types"
import { getModelReservedOutputTokens } from "@alpha/api"

import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"

export interface TaskContextUsage {
	contextTokens: number
	contextWindow: number
	reservedForOutput: number
	availableInputSpace: number
	availableSpace: number
	percentage: number
}

/** The task's resolved model owns input capacity, including its provider's output reservation. */
export function useTaskContextUsage({
	apiConfiguration,
	taskModel,
	contextTokens,
}: {
	apiConfiguration?: ProviderSettings
	taskModel?: LiveTaskMetadata["model"]
	contextTokens: number
}): TaskContextUsage {
	const selectedModel = useSelectedModel(apiConfiguration)
	const { id: modelId, info: model } = taskModel ?? selectedModel
	const reservedForOutput =
		useMemo(
			() => (model ? getModelReservedOutputTokens({ modelId, model, settings: apiConfiguration }) : 0),
			[model, modelId, apiConfiguration],
		) || 0
	const contextWindow = model?.contextWindow || 0
	const used = Number.isFinite(contextTokens) ? Math.max(0, contextTokens) : 0
	const availableInputSpace = contextWindow - reservedForOutput

	return {
		contextTokens: used,
		contextWindow,
		reservedForOutput,
		availableInputSpace,
		availableSpace: Math.max(0, availableInputSpace - used),
		percentage: availableInputSpace > 0 ? Math.min(100, Math.round((used / availableInputSpace) * 100)) : 0,
	}
}
