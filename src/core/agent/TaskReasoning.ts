import {
	reasoningEffortsExtended,
	resolveOpenAiCustomModelInfo,
	resolveModelReasoningEffort,
	type TaskReasoningCapabilities,
	type TaskReasoningFallbackReason,
	type TaskReasoningPreference,
	type TaskReasoningState,
	type ReasoningEffortExtended,
	type ModelInfo,
	type ProviderSettings,
} from "@alpha-code/types"

import {
	DEFAULT_HYBRID_REASONING_MODEL_THINKING_TOKENS,
	GEMINI_25_PRO_MIN_THINKING_TOKENS,
	getModelMaxOutputTokens,
} from "../../shared/api"

export type TaskReasoningModel = {
	id: string
	info: ModelInfo
}

export type TaskReasoningResolution = {
	configuration: ProviderSettings
	state: TaskReasoningState
}

const DEFAULT_PREFERENCE: TaskReasoningPreference = { kind: "default" }

/** Only an applied setting change belongs to the next request; metadata refreshes do not. */
export function hasPendingReasoningChange(current: TaskReasoningState | undefined, next: TaskReasoningState): boolean {
	if (!current) return false
	const active = current.effective
	const selected = next.effective
	if (active.kind !== selected.kind) return true
	if (active.kind === "effort" && selected.kind === "effort") return active.effort !== selected.effort
	if (active.kind === "custom" && selected.kind === "custom") return active.value !== selected.value
	return (
		active.kind === "on" &&
		(current.capabilities.kind === "budget" ? current.capabilities.budgetTokens : undefined) !==
			(next.capabilities.kind === "budget" ? next.capabilities.budgetTokens : undefined)
	)
}

/** Increment the acknowledged next-step choice, skipping unsupported levels without wrapping. */
export function getAdjacentReasoningPreference(
	state: TaskReasoningState,
	direction: -1 | 1,
): TaskReasoningPreference | undefined {
	if (state.capabilities.kind === "binary") {
		if (direction === -1 && !state.capabilities.canDisable) return undefined
		const kind = direction === 1 ? "on" : "off"
		return state.effective.kind !== kind ? { kind } : undefined
	}
	if (state.capabilities.kind !== "effort") return undefined
	const efforts = reasoningEffortsExtended.filter((effort) => state.capabilities.efforts?.includes(effort))
	const current = state.effective.kind === "effort" ? efforts.indexOf(state.effective.effort) : -1
	const next = current === -1 ? (direction === 1 ? 0 : -1) : current + direction
	return next >= 0 && next < efforts.length ? { kind: "effort", effort: efforts[next] } : undefined
}

/** Tool-requested levels must be honored exactly; saved/UI preferences retain their normal fallback behavior. */
export function assertTaskReasoningEffortSupported(
	effort: ReasoningEffortExtended,
	capabilities: TaskReasoningCapabilities,
	modelId: string,
): void {
	if (capabilities.kind === "effort" && capabilities.efforts?.includes(effort)) return
	const supported = capabilities.kind === "effort" ? capabilities.efforts?.join(", ") : undefined
	throw new Error(
		`Model ${JSON.stringify(modelId)} does not support reasoning effort ${JSON.stringify(effort)}. ${supported ? `Supported levels: ${supported}.` : "This model does not support named reasoning levels."}`,
	)
}

/**
 * Resolve one task preference against the model descriptor captured for the
 * next step. The profile is the input and is never persisted with task-only
 * overrides.
 */
export function resolveTaskReasoning(
	configuration: ProviderSettings,
	preference: TaskReasoningPreference | undefined,
	model: TaskReasoningModel,
): TaskReasoningResolution {
	if (configuration.apiProvider === "openai") {
		model = { ...model, info: resolveOpenAiCustomModelInfo(model.info) }
	}
	const requested = preference ?? DEFAULT_PREFERENCE
	const capabilities = getTaskReasoningCapabilities(configuration, model)

	const resolution =
		requested.kind === "default"
			? resolveDefaultPreference(capabilities, configuration, model)
			: resolvePreference(requested, capabilities, configuration, model)
	return {
		// Preserve object identity when the profile already expresses the
		// adapter's default. Task construction uses this to avoid rebuilding
		// handlers and their host listeners.
		configuration: applyRuntimeChanges(configuration, resolution.patch),
		state: {
			requested,
			effective: resolution.effective,
			capabilities,
			...(resolution.fallbackReason ? { fallbackReason: resolution.fallbackReason } : {}),
		},
	}
}

function getTaskReasoningCapabilities(
	configuration: ProviderSettings,
	model: TaskReasoningModel,
): TaskReasoningCapabilities {
	const { info: modelInfo } = model
	if (modelInfo.requiredReasoningBudget || modelInfo.supportsReasoningBudget) {
		return {
			kind: "budget",
			canDisable: !modelInfo.requiredReasoningBudget,
			budgetTokens: getDefaultBudgetTokens(configuration, model.id, modelInfo),
		}
	}

	const efforts = getNamedEfforts(modelInfo)
	if (efforts.length) {
		return {
			kind: "effort",
			efforts,
			canDisable: !modelInfo.requiredReasoningEffort,
		}
	}

	if (modelInfo.supportsReasoningBinary) {
		return { kind: "binary", canDisable: true }
	}

	return { kind: "unavailable", canDisable: true }
}

function getNamedEfforts(modelInfo: ModelInfo): ReasoningEffortExtended[] {
	const supported = modelInfo.supportsReasoningEffort
	const values = Array.isArray(supported)
		? supported.filter((value): value is ReasoningEffortExtended => value !== "disable")
		: supported === true && modelInfo.reasoningEffort
			? [modelInfo.reasoningEffort]
			: []
	return [...new Set(values)]
}

type PreferenceResolution = {
	effective: TaskReasoningPreference
	fallbackReason?: TaskReasoningFallbackReason
	patch: Partial<ProviderSettings>
}

function resolvePreference(
	requested: Exclude<TaskReasoningPreference, { kind: "default" }>,
	capabilities: TaskReasoningCapabilities,
	configuration: ProviderSettings,
	model: TaskReasoningModel,
): PreferenceResolution {
	switch (requested.kind) {
		case "effort":
			return resolveEffortPreference(requested.effort, capabilities, configuration, model)
		case "off":
			if (capabilities.canDisable) {
				return { effective: requested, patch: disabledPatch() }
			}
			return activeResolution(capabilities, configuration, model.info, "required")
		case "on":
			return resolveOnPreference(capabilities, configuration, model.info)
		case "custom": {
			// Historical task preferences remain readable; active providers use their
			// declared capabilities instead of forwarding arbitrary reasoning tokens.
			const fallback = resolveDefaultPreference(capabilities, configuration, model)
			return {
				effective: fallback.effective,
				fallbackReason:
					fallback.fallbackReason ?? (capabilities.kind === "unavailable" ? "unavailable" : "unsupported"),
				patch: fallback.patch,
			}
		}
	}
}

function resolveEffortPreference(
	effort: ReasoningEffortExtended,
	capabilities: TaskReasoningCapabilities,
	configuration: ProviderSettings,
	model: TaskReasoningModel,
): PreferenceResolution {
	if (capabilities.kind === "effort" && capabilities.efforts?.includes(effort)) {
		return {
			effective: { kind: "effort", effort },
			patch: activeEffortPatch(effort),
		}
	}

	if (capabilities.kind === "budget") {
		const fallback = resolveDefaultPreference(capabilities, configuration, model)
		return {
			effective: fallback.effective,
			fallbackReason: fallback.fallbackReason ?? "budget-only",
			patch: fallback.patch,
		}
	}

	if (capabilities.kind === "binary") {
		const fallback = resolveDefaultPreference(capabilities, configuration, model)
		return {
			effective: fallback.effective,
			fallbackReason: fallback.fallbackReason ?? "unsupported",
			patch: fallback.patch,
		}
	}

	if (capabilities.kind === "effort") {
		const fallback = resolveDefaultPreference(capabilities, configuration, model)
		return {
			effective: fallback.effective,
			fallbackReason: fallback.fallbackReason ?? "unsupported",
			patch: fallback.patch,
		}
	}

	return {
		effective: { kind: "off" },
		fallbackReason: capabilities.kind === "unavailable" ? "unavailable" : "unsupported",
		patch: disabledPatch(),
	}
}

function resolveDefaultPreference(
	capabilities: TaskReasoningCapabilities,
	configuration: ProviderSettings,
	model: TaskReasoningModel,
): {
	effective: TaskReasoningPreference
	fallbackReason?: TaskReasoningFallbackReason
	patch: Partial<ProviderSettings>
} {
	if (!capabilities.canDisable && (capabilities.kind === "budget" || capabilities.kind === "effort")) {
		return activeResolution(capabilities, configuration, model.info, "required")
	}

	if (capabilities.kind === "effort") {
		const configuredEffort = configuration.reasoningEffort as string | undefined
		if (configuration.enableReasoningEffort === false || configuredEffort === "disable") {
			return { effective: { kind: "off" }, patch: disabledPatch() }
		}

		const hasExplicitEnable = configuration.enableReasoningEffort === true
		const efforts = capabilities.efforts ?? []
		const validConfiguredEffort =
			configuredEffort !== undefined &&
			configuredEffort !== "disable" &&
			efforts.includes(configuredEffort as ReasoningEffortExtended)

		// VS Code LM only emits a reasoning option when the enable flag is set.
		// Preserve Default's omitted request rather than turning a profile preview
		// into an explicit host override before live model preparation.
		if (configuration.apiProvider === "vscode-lm" && !hasExplicitEnable) {
			if (configuredEffort !== undefined && configuredEffort !== "disable" && !validConfiguredEffort) {
				return {
					effective: { kind: "off" },
					fallbackReason: "unsupported",
					patch: disabledPatch(),
				}
			}
			return { effective: { kind: "default" }, patch: {} }
		}

		const effort = selectEffort(configuration, model.info, efforts, hasExplicitEnable)
		if (!effort) {
			if (configuredEffort !== undefined && configuredEffort !== "disable") {
				return {
					effective: { kind: "off" },
					fallbackReason: "unsupported",
					patch: disabledPatch(),
				}
			}
			return { effective: { kind: "default" }, patch: {} }
		}

		// An omitted setting lets adapters use their catalogued model default.
		// Only materialize a patch when a legacy selection is invalid.
		if (
			configuration.reasoningEffort === undefined &&
			!hasExplicitEnable &&
			model.info.reasoningEffort === undefined
		) {
			return { effective: { kind: "default" }, patch: {} }
		}
		if (configuration.reasoningEffort === undefined && !hasExplicitEnable) {
			return { effective: { kind: "effort", effort }, patch: {} }
		}
		if (hasExplicitEnable && validConfiguredEffort) {
			return { effective: { kind: "effort", effort }, patch: {} }
		}
		return {
			effective: { kind: "effort", effort },
			...(configuration.reasoningEffort !== undefined && !validConfiguredEffort
				? { fallbackReason: "unsupported" as const }
				: {}),
			patch: activeEffortPatch(effort),
		}
	}

	if (capabilities.kind === "budget") {
		return configuration.enableReasoningEffort
			? { effective: { kind: "on" }, patch: {} }
			: { effective: { kind: "off" }, patch: {} }
	}

	if (capabilities.kind === "binary") {
		return configuration.enableReasoningEffort
			? { effective: { kind: "on" }, patch: {} }
			: { effective: { kind: "off" }, patch: {} }
	}

	return { effective: { kind: "off" }, patch: {} }
}

function resolveOnPreference(
	capabilities: TaskReasoningCapabilities,
	configuration: ProviderSettings,
	modelInfo: ModelInfo,
): PreferenceResolution {
	if (capabilities.kind === "budget") {
		return { effective: { kind: "on" }, patch: activeBinaryPatch() }
	}

	if (capabilities.kind === "effort") {
		const effort = selectEffort(
			configuration,
			modelInfo,
			(capabilities.efforts ?? []).filter((effort) => effort !== "none"),
		)
		if (effort) {
			return { effective: { kind: "effort", effort }, patch: activeEffortPatch(effort) }
		}
		return { effective: { kind: "off" }, fallbackReason: "unavailable", patch: disabledPatch() }
	}

	if (capabilities.kind === "binary") {
		return { effective: { kind: "on" }, patch: activeBinaryPatch() }
	}

	return {
		effective: { kind: "off" },
		fallbackReason: capabilities.kind === "custom" ? "unsupported" : "unavailable",
		patch: disabledPatch(),
	}
}

function activeResolution(
	capabilities: TaskReasoningCapabilities,
	configuration: ProviderSettings,
	modelInfo: ModelInfo,
	fallbackReason: TaskReasoningFallbackReason,
): PreferenceResolution {
	if (capabilities.kind === "effort") {
		const effort = selectEffort(configuration, modelInfo, capabilities.efforts ?? [])
		if (effort) {
			return {
				effective: { kind: "effort", effort },
				fallbackReason,
				patch: activeEffortPatch(effort),
			}
		}
	}

	return {
		effective: { kind: "on" },
		fallbackReason,
		patch: activeBinaryPatch(),
	}
}

function selectEffort(
	configuration: ProviderSettings,
	modelInfo: ModelInfo,
	efforts: ReasoningEffortExtended[],
	allowFirst = true,
): ReasoningEffortExtended | undefined {
	return resolveModelReasoningEffort(
		{ supportsReasoningEffort: efforts, reasoningEffort: modelInfo.reasoningEffort },
		configuration.reasoningEffort,
		allowFirst,
	)
}

function activeEffortPatch(effort: ReasoningEffortExtended): Partial<ProviderSettings> {
	return { enableReasoningEffort: true, reasoningEffort: effort }
}

function activeBinaryPatch(): Partial<ProviderSettings> {
	return { enableReasoningEffort: true, reasoningEffort: undefined }
}

function disabledPatch(): Partial<ProviderSettings> {
	return { enableReasoningEffort: false, reasoningEffort: "disable" }
}

function applyRuntimeChanges(configuration: ProviderSettings, patch: Partial<ProviderSettings>): ProviderSettings {
	const current = configuration as Record<string, unknown>
	const hasChange = Object.entries(patch).some(([key, value]) =>
		value === undefined ? key in current : current[key] !== value,
	)
	if (!hasChange) return configuration

	const next = { ...configuration, ...patch }
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete (next as Record<string, unknown>)[key]
	}
	return next
}

function getDefaultBudgetTokens(configuration: ProviderSettings, modelId: string, model: ModelInfo): number {
	// Mirror getModelParams' active budget path so capability metadata describes
	// the request that the adapter will actually send, including its 80% cap and
	// provider minimum. A disabled optional profile still needs the budget that
	// would be used if the task enables reasoning.
	const activeConfiguration = { ...configuration, enableReasoningEffort: true }
	const maxTokens = getModelMaxOutputTokens({
		modelId,
		model,
		settings: activeConfiguration,
		format: "gemini",
	})
	const isGemini25Pro = modelId.includes("gemini-2.5-pro")
	let budgetTokens =
		configuration.modelMaxThinkingTokens ??
		(isGemini25Pro ? GEMINI_25_PRO_MIN_THINKING_TOKENS : DEFAULT_HYBRID_REASONING_MODEL_THINKING_TOKENS)

	if (maxTokens && budgetTokens > Math.floor(maxTokens * 0.8)) {
		budgetTokens = Math.floor(maxTokens * 0.8)
	}

	const minimum = isGemini25Pro ? GEMINI_25_PRO_MIN_THINKING_TOKENS : 1024
	if (budgetTokens < minimum) budgetTokens = minimum
	return budgetTokens
}
