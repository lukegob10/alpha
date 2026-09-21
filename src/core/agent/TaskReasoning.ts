import {
	taskReasoningCustomTokenPattern,
	resolveOpenAiCustomModelInfo,
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
	type TaskReasoningRuntimeOptions,
} from "../../shared/api"

/** The provider configuration plus ephemeral task-only reasoning controls. */
export type TaskReasoningConfiguration = ProviderSettings & TaskReasoningRuntimeOptions

export type TaskReasoningModel = {
	id: string
	info: ModelInfo
}

export type TaskReasoningResolution = {
	configuration: TaskReasoningConfiguration
	state: TaskReasoningState
}

const DEFAULT_PREFERENCE: TaskReasoningPreference = { kind: "default" }

/**
 * Resolve one task preference against the model descriptor captured for the
 * next step. The profile is the input and is never persisted with task-only
 * overrides; Stellar's custom token is carried only on the returned runtime
 * configuration.
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

	if (requested.kind === "default") {
		const defaultResolution = resolveDefaultPreference(capabilities, configuration, model)
		return {
			// Preserve object identity when the profile already expresses the
			// adapter's default. Task construction uses this to avoid rebuilding
			// handlers and their host listeners.
			configuration: applyRuntimeChanges(configuration, defaultResolution.patch),
			state: {
				requested,
				effective: defaultResolution.effective,
				capabilities,
				...(defaultResolution.fallbackReason ? { fallbackReason: defaultResolution.fallbackReason } : {}),
			},
		}
	}

	const resolution = resolvePreference(requested, capabilities, configuration, model)
	return {
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
	// Stellar is intentionally a constrained custom-token surface. Do not let a
	// future catalog field accidentally turn it into a generic named-level UI.
	if (configuration.apiProvider === "stellar") {
		return { kind: "custom", canDisable: true }
	}

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
	patch: Partial<TaskReasoningConfiguration>
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
		case "custom":
			if (capabilities.kind !== "custom") {
				const fallback = resolveDefaultPreference(capabilities, configuration, model)
				return {
					effective: fallback.effective,
					fallbackReason:
						fallback.fallbackReason ??
						(capabilities.kind === "unavailable" ? "unavailable" : "unsupported"),
					patch: fallback.patch,
				}
			}
			return resolveCustomPreference(requested.value, capabilities)
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
	patch: Partial<TaskReasoningConfiguration>
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
			return { effective: { kind: "default" }, patch: clearTaskOverridePatch() }
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
			return { effective: { kind: "default" }, patch: clearTaskOverridePatch() }
		}

		// An omitted setting lets adapters use their catalogued model default.
		// Only materialize a patch when a legacy selection is invalid or when a
		// task override left a custom runtime token behind.
		const hasRuntimeCustom = (configuration as TaskReasoningConfiguration).taskReasoningCustomEffort !== undefined
		if (
			configuration.reasoningEffort === undefined &&
			!hasRuntimeCustom &&
			!hasExplicitEnable &&
			model.info.reasoningEffort === undefined
		) {
			return { effective: { kind: "default" }, patch: {} }
		}
		if (configuration.reasoningEffort === undefined && !hasRuntimeCustom && !hasExplicitEnable) {
			return { effective: { kind: "effort", effort }, patch: {} }
		}
		if (hasRuntimeCustom === false && hasExplicitEnable && validConfiguredEffort) {
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
			? { effective: { kind: "on" }, patch: clearTaskOverridePatch() }
			: { effective: { kind: "off" }, patch: clearTaskOverridePatch() }
	}

	if (capabilities.kind === "binary") {
		return configuration.enableReasoningEffort
			? { effective: { kind: "on" }, patch: clearTaskOverridePatch() }
			: { effective: { kind: "off" }, patch: clearTaskOverridePatch() }
	}

	return {
		effective: { kind: "off" },
		fallbackReason:
			(configuration as TaskReasoningConfiguration).taskReasoningCustomEffort === undefined
				? undefined
				: "unsupported",
		patch:
			(configuration as TaskReasoningConfiguration).taskReasoningCustomEffort === undefined
				? {}
				: disabledPatch(),
	}
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
		const effort = selectEffort(configuration, modelInfo, capabilities.efforts ?? [])
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

function resolveCustomPreference(value: string, capabilities: TaskReasoningCapabilities): PreferenceResolution {
	if (capabilities.kind === "custom" && taskReasoningCustomTokenPattern.test(value)) {
		return {
			effective: { kind: "custom", value },
			patch: {
				enableReasoningEffort: false,
				reasoningEffort: "disable",
				taskReasoningCustomEffort: value,
			},
		}
	}

	return {
		effective: { kind: "off" },
		fallbackReason: taskReasoningCustomTokenPattern.test(value) ? "unsupported" : "invalid-custom",
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
	const configured = configuration.reasoningEffort as string | undefined
	if (configured && configured !== "disable" && efforts.includes(configured as ReasoningEffortExtended)) {
		return configured as ReasoningEffortExtended
	}
	if (modelInfo.reasoningEffort && efforts.includes(modelInfo.reasoningEffort)) return modelInfo.reasoningEffort
	return allowFirst ? efforts[0] : undefined
}

function activeEffortPatch(effort: ReasoningEffortExtended): Partial<TaskReasoningConfiguration> {
	return { enableReasoningEffort: true, reasoningEffort: effort, taskReasoningCustomEffort: undefined }
}

function activeBinaryPatch(): Partial<TaskReasoningConfiguration> {
	return { enableReasoningEffort: true, reasoningEffort: undefined, taskReasoningCustomEffort: undefined }
}

function disabledPatch(): Partial<TaskReasoningConfiguration> {
	return { enableReasoningEffort: false, reasoningEffort: "disable", taskReasoningCustomEffort: undefined }
}

function clearTaskOverridePatch(): Partial<TaskReasoningConfiguration> {
	return { taskReasoningCustomEffort: undefined }
}

function applyRuntimeChanges(
	configuration: ProviderSettings,
	patch: Partial<TaskReasoningConfiguration>,
): TaskReasoningConfiguration {
	const current = configuration as Record<string, unknown>
	const hasChange = Object.entries(patch).some(([key, value]) =>
		value === undefined ? key in current : current[key] !== value,
	)
	if (!hasChange) return configuration

	const next = { ...configuration, ...patch } as TaskReasoningConfiguration
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
