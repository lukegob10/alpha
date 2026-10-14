import type { ModelInfo, VscodeLlmModelSelectorLike } from "@alpha-code/types"
import { TOOL_ALIASES } from "../../../shared/tools"

export type ModelToolIdentity = {
	provider?: string
	vendor?: string
	family?: string
	id?: string
}

export type SurgicalEditTool = "apply_patch" | "edit"

const RETIRED_EDIT_TOOLS = new Set(["apply_diff", "search_replace", "edit_file"])
const SURGICAL_EDIT_TOOLS = new Set<SurgicalEditTool>(["apply_patch", "edit"])
const ROUTED_PROVIDERS = new Set(["copilot", "openai", "stellar", "vertex", "vertex-openai", "vscode-lm"])

function normalizeIdentifier(identifier: string | undefined): string | undefined {
	const value = identifier?.trim().toLowerCase()
	return value || undefined
}

function classifyIdentifier(identifier: string | undefined): SurgicalEditTool | undefined {
	const value = normalizeIdentifier(identifier)
	if (!value) return undefined

	// IDs may use provider namespaces (`openai/gpt-5`, `xai/grok-4`) or the
	// VS Code Copilot prefix (`copilot-gpt-5`). Inspect namespace components
	// instead of matching arbitrary substrings such as `custom-gpt-wrapper`.
	const candidates = value
		.split(/[/:]/)
		.map((candidate) => candidate.replace(/^copilot[-_]/, ""))
		.reverse()

	for (const candidate of candidates) {
		if (/^(?:gpt(?:[-_.]\d|[-_.]oss(?:[-_.]|$)|$)|o\d(?:[-_.]|$)|codex(?:[-_.]|$))/.test(candidate)) {
			return "apply_patch"
		}
		if (/(?:^|[-_])(?:claude|gemini|grok|llama)(?:[-_.]|$)/.test(candidate)) {
			return "edit"
		}
	}

	return undefined
}

/** Resolves the surgical editor only from a verified provider/model identity. */
export function getModelSurgicalEditTool(model: ModelToolIdentity): SurgicalEditTool | undefined {
	const provider = normalizeIdentifier(model.provider)
	const vendor = normalizeIdentifier(model.vendor)
	if (provider && !ROUTED_PROVIDERS.has(provider)) return undefined
	if (provider === "vscode-lm" && vendor !== "copilot") return undefined
	if (!provider && vendor !== "copilot") return undefined

	const familyTool = classifyIdentifier(model.family)
	const idTool = classifyIdentifier(model.id)
	if (familyTool && idTool && familyTool !== idTool) return undefined
	return familyTool ?? idTool
}

function normalizeToolNames(tools: readonly string[] | undefined): string[] | undefined {
	if (!tools) return undefined

	const normalized: string[] = []
	for (const tool of tools) {
		const canonical = TOOL_ALIASES[tool] ?? tool
		if (RETIRED_EDIT_TOOLS.has(canonical) || normalized.includes(canonical)) continue
		normalized.push(canonical)
	}
	return normalized
}

function sameNames(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	if (left === undefined || right === undefined) return left === right
	return left.length === right.length && left.every((name, index) => name === right[index])
}

/**
 * Applies the provider-neutral surgical editor preference and strips stale
 * retired editor names before a model catalog is built.
 *
 * A missing or conflicting identity is deliberately conservative: stale
 * `apply_patch` metadata is removed, and no new patch preference is granted.
 */
export function applyModelToolPreferences(model: ModelToolIdentity, info: ModelInfo): ModelInfo {
	const normalizedIncluded = normalizeToolNames(info.includedTools)
	const normalizedExcluded = normalizeToolNames(info.excludedTools)
	const preferred = getModelSurgicalEditTool(model)

	// Surgical tools are opt-in preferences, so stale metadata never survives
	// unless the resolved route grants exactly one canonical preference.
	let included = normalizedIncluded?.filter((tool) => !SURGICAL_EDIT_TOOLS.has(tool as SurgicalEditTool))

	let excluded = normalizedExcluded
	if (preferred) {
		const patchExcluded = normalizedExcluded?.includes("apply_patch") === true
		const surgical: SurgicalEditTool = preferred === "apply_patch" && !patchExcluded ? "apply_patch" : "edit"
		included = (included ?? []).filter((tool) => !SURGICAL_EDIT_TOOLS.has(tool as SurgicalEditTool))
		included.push(surgical)
		// Preserve an explicit patch exclusion when it forces the portable fallback,
		// but never let metadata hide the editor selected for this route.
		excluded = excluded?.filter(
			(tool) =>
				!SURGICAL_EDIT_TOOLS.has(tool as SurgicalEditTool) || (tool === "apply_patch" && surgical === "edit"),
		)
	} else {
		// An unknown or conflicting route still gets the portable editor through its
		// regular edit group; no surgical preference is granted.
		excluded = excluded?.filter((tool) => tool !== "edit")
	}

	// User disabledTools policy is applied later at the task surface boundary.
	const nextIncluded = info.includedTools === undefined && included?.length === 0 ? undefined : included
	const nextExcluded = info.excludedTools === undefined && excluded?.length === 0 ? undefined : excluded

	if (sameNames(info.includedTools, nextIncluded) && sameNames(info.excludedTools, nextExcluded)) return info
	return { ...info, includedTools: nextIncluded, excludedTools: nextExcluded }
}

/** Defaults for a resolved Copilot model, retained as a compatibility wrapper. */
export function applyCopilotToolPreferences(model: VscodeLlmModelSelectorLike, info: ModelInfo): ModelInfo {
	return applyModelToolPreferences(
		{
			provider: "vscode-lm",
			vendor: model.vendor,
			family: model.family,
			id: model.id,
		},
		info,
	)
}
