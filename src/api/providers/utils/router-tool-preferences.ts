import type { ModelInfo, VscodeLlmModelSelectorLike } from "@alpha-code/types"
import { TOOL_ALIASES } from "../../../shared/tools"

const SURGICAL_EDIT_TOOLS = new Set(["apply_patch", "apply_diff", "edit", "search_replace", "edit_file"])

function copilotEditTool(identifier: string | undefined): "apply_patch" | "edit" | undefined {
	const value = identifier?.toLowerCase().replace(/^copilot[-/:]/, "")
	if (!value) return undefined
	if (/^(?:openai\/)?(?:gpt-\d|o\d(?:[.-]|$)|codex(?:[-.]|$))/.test(value)) return "apply_patch"
	if (/^(?:anthropic\/)?claude(?:[-.]|$)/.test(value) || /^(?:google\/)?gemini(?:[-.]|$)/.test(value)) return "edit"
	return undefined
}

/** Defaults for a resolved Copilot model only; display names and unknown aliases are not routing evidence. */
export function applyCopilotToolPreferences(model: VscodeLlmModelSelectorLike, info: ModelInfo): ModelInfo {
	if (model.vendor?.toLowerCase() !== "copilot") return info
	const familyTool = copilotEditTool(model.family)
	const idTool = copilotEditTool(model.id)
	if (familyTool && idTool && familyTool !== idTool) return info
	const preferred = familyTool ?? idTool
	// Explicit model exceptions and opt-in editors take precedence over these defaults.
	if (
		!preferred ||
		info.includedTools?.some((tool) => SURGICAL_EDIT_TOOLS.has(TOOL_ALIASES[tool] ?? tool)) ||
		info.excludedTools?.some((tool) => (TOOL_ALIASES[tool] ?? tool) === preferred)
	)
		return info
	return {
		...info,
		includedTools: [...(info.includedTools ?? []), preferred],
		excludedTools: [...new Set([...(info.excludedTools ?? []), "apply_diff"])],
	}
}

/**
 * Apply tool preferences for models accessed through dynamic routers (OpenRouter, Requesty).
 *
 * Different model families perform better with specific tools:
 * - OpenAI models: Better results with apply_patch instead of apply_diff/write_to_file
 *
 * This function modifies the model info to apply these preferences consistently
 * across all dynamic router providers.
 *
 * @param modelId The model identifier (e.g., "openai/gpt-4", "google/gemini-2.5-pro")
 * @param info The original model info object
 * @returns A new model info object with tool preferences applied
 */
export function applyRouterToolPreferences(modelId: string, info: ModelInfo): ModelInfo {
	let result = info

	// For OpenAI models via routers, exclude write_to_file and apply_diff, and include apply_patch
	// This matches the behavior of the native OpenAI provider
	if (modelId.includes("openai")) {
		result = {
			...result,
			excludedTools: [...new Set([...(result.excludedTools || []), "apply_diff", "write_to_file"])],
			includedTools: [...new Set([...(result.includedTools || []), "apply_patch"])],
		}
	}

	return result
}
