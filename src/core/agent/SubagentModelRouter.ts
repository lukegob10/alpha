import {
	getModelId,
	getVscodeLlmCatalogModels,
	getVscodeLlmModelId,
	type ProviderSettings,
	type ProviderSettingsWithId,
	type ReasoningEffortExtended,
	type SubagentModelRouteState,
	type TaskReasoningPreference,
} from "@alpha-code/types"
import { ProviderProfileUnavailableError } from "../config/ProviderProfileUnavailableError"

export type SubagentRole = "explore" | "review" | "worker"

interface StoredProviderProfile extends ProviderSettingsWithId {
	name: string
}

export interface SubagentProfileLoader {
	getProfile(params: { name: string } | { id: string }): Promise<StoredProviderProfile>
	assertProfileAvailable?(params: { name: string } | { id: string }): Promise<void>
}

export interface ResolveSubagentModelRouteOptions {
	role: SubagentRole
	parentApiConfiguration: ProviderSettings
	parentApiConfigName?: string
	parentReasoningPreference?: TaskReasoningPreference
	defaultProfileId?: string
	profileByRole?: Partial<Record<SubagentRole, string>>
	profileLoader: SubagentProfileLoader
	requestedModelId?: string
	requestedReasoningEffort?: ReasoningEffortExtended
	defaultModelId?: string
	defaultReasoningEffort?: ReasoningEffortExtended
	agentModelId?: string
	agentReasoningEffort?: ReasoningEffortExtended
	resolveModelDefaultReasoningEffort?(configuration: ProviderSettings): Promise<ReasoningEffortExtended | undefined>
}

export interface ResolvedSubagentModelRoute {
	apiConfiguration: ProviderSettings
	apiConfigName: string
	/** Explicit child choice so generic task creation cannot inherit newer parent settings. */
	reasoningPreference?: TaskReasoningPreference
	route: SubagentModelRouteState
}

/**
 * Capture a provider route without carrying process-local executable objects
 * into durable or cross-task state. FakeAI is intentionally registered by ID
 * in the extension host; descendants rehydrate that registered implementation
 * from the clone-safe ID stub.
 */
export const snapshotProviderSettings = (settings: ProviderSettings): ProviderSettings => {
	if (settings.apiProvider !== "fake-ai") return structuredClone(settings)

	const fakeAi = settings.fakeAi
	const fakeAiId =
		fakeAi && typeof fakeAi === "object" && typeof (fakeAi as { id?: unknown }).id === "string"
			? (fakeAi as { id: string }).id
			: undefined

	return structuredClone({
		...settings,
		fakeAi: fakeAiId ? { id: fakeAiId } : fakeAi,
	})
}

const settingsFromProfile = (profile: StoredProviderProfile): ProviderSettings => {
	const { id: _id, name: _name, ...settings } = profile
	return snapshotProviderSettings(settings)
}

/** VS Code LM stores its model identity in the selector rather than a generic model-id field. */
export const getSubagentRouteModelId = (settings: ProviderSettings): string | undefined => getModelId(settings)

async function resolveParentRoute(
	options: ResolveSubagentModelRouteOptions,
	source: SubagentModelRouteState["source"],
	fallback?: Pick<SubagentModelRouteState, "requestedProfileId" | "fallbackReason">,
): Promise<ResolvedSubagentModelRoute> {
	const apiConfiguration = snapshotProviderSettings(options.parentApiConfiguration)
	const apiConfigName = options.parentApiConfigName?.trim() || "Parent profile"
	let profileId: string | undefined

	if (options.parentApiConfigName) {
		try {
			profileId = (await options.profileLoader.getProfile({ name: options.parentApiConfigName })).id
		} catch {
			// Historical tasks can refer to a renamed or deleted profile. The task's
			// in-memory configuration is still the authoritative inheritance source.
		}
	}

	return {
		apiConfiguration,
		apiConfigName,
		reasoningPreference: structuredClone(options.parentReasoningPreference ?? { kind: "default" }),
		route: {
			source,
			resolution: fallback ? "fallback" : "selected",
			profileId,
			profileName: apiConfigName,
			provider: apiConfiguration.apiProvider,
			modelId: getSubagentRouteModelId(apiConfiguration),
			...fallback,
		},
	}
}

/** Resolve and snapshot a sub-agent profile without mutating the active provider profile. */
async function resolveProfileRoute(options: ResolveSubagentModelRouteOptions): Promise<ResolvedSubagentModelRoute> {
	const roleProfileId = options.profileByRole?.[options.role]
	const requestedProfileId = roleProfileId || options.defaultProfileId
	const source: SubagentModelRouteState["source"] = roleProfileId
		? "role"
		: options.defaultProfileId
			? "default"
			: "parent"

	if (!requestedProfileId) {
		return resolveParentRoute(options, "parent")
	}

	let profile: StoredProviderProfile
	try {
		await options.profileLoader.assertProfileAvailable?.({ id: requestedProfileId })
		profile = await options.profileLoader.getProfile({ id: requestedProfileId })
	} catch (error) {
		if (error instanceof ProviderProfileUnavailableError) throw error
		return resolveParentRoute(options, source, {
			requestedProfileId,
			fallbackReason: "missing",
		})
	}

	const apiConfiguration = settingsFromProfile(profile)
	if (!apiConfiguration.apiProvider) {
		return resolveParentRoute(options, source, {
			requestedProfileId,
			fallbackReason: "unconfigured",
		})
	}

	return {
		apiConfiguration,
		apiConfigName: profile.name,
		reasoningPreference: { kind: "default" },
		route: {
			source,
			resolution: "selected",
			profileId: profile.id,
			profileName: profile.name,
			provider: apiConfiguration.apiProvider,
			modelId: getSubagentRouteModelId(apiConfiguration),
		},
	}
}

/** Apply a model-facing override to a captured provider profile without changing its credentials or provider. */
export function applySubagentSpawnOverrides(
	base: ResolvedSubagentModelRoute,
	requestedModelId?: string,
	requestedReasoningEffort?: ReasoningEffortExtended,
	resetReasoningForSelectedModel = true,
): ResolvedSubagentModelRoute {
	if (!requestedModelId && !requestedReasoningEffort) return base

	const apiConfiguration = snapshotProviderSettings(base.apiConfiguration)
	if (resetReasoningForSelectedModel && requestedModelId && !requestedReasoningEffort) {
		apiConfiguration.reasoningEffort = undefined
		apiConfiguration.enableReasoningEffort = undefined
	}
	if (requestedModelId) {
		switch (apiConfiguration.apiProvider) {
			case "openai":
				apiConfiguration.apiModelId = undefined
				if (apiConfiguration.openAiModelId !== requestedModelId) {
					apiConfiguration.openAiCustomModelInfo = null
				}
				apiConfiguration.openAiModelId = requestedModelId
				break
			case "vertex":
			case "stellar":
			case "openai-native":
			case "openai-codex":
			case "bedrock":
			case "meta":
			case "anthropic":
			case "gemini":
			case "xai":
			case "openrouter":
				apiConfiguration.openAiModelId = undefined
				apiConfiguration.apiModelId = requestedModelId
				break
			case "vscode-lm": {
				const selector = apiConfiguration.vsCodeLmModelSelector
				const catalog = getVscodeLlmCatalogModels()
				const usesCatalogFamily =
					selector?.vendor === "copilot" &&
					selector.id === undefined &&
					selector.version === undefined &&
					catalog.some((model) => model.family === selector.family)
				const catalogModel = usesCatalogFamily
					? catalog.find(
							(model) =>
								model.family === requestedModelId || getVscodeLlmModelId(model) === requestedModelId,
						)
					: undefined
				apiConfiguration.apiModelId = undefined
				apiConfiguration.openAiModelId = undefined
				// Catalog choices bind to a host model only at admission. Exact saved
				// selectors and unknown override IDs retain their existing ID semantics.
				apiConfiguration.vsCodeLmModelSelector = catalogModel
					? { vendor: "copilot", family: catalogModel.family }
					: { id: requestedModelId }
				break
			}
			default:
				throw new Error(
					`Provider ${apiConfiguration.apiProvider ?? "unconfigured"} cannot select a spawn model`,
				)
		}
	}
	if (requestedReasoningEffort) {
		apiConfiguration.enableReasoningEffort = requestedReasoningEffort !== "none"
		apiConfiguration.reasoningEffort = requestedReasoningEffort
	}

	return {
		apiConfiguration,
		apiConfigName: base.apiConfigName,
		// The routed profile now owns an explicit effort or the selected model's
		// default. An inherited task override must not supersede that decision.
		reasoningPreference:
			requestedReasoningEffort || (resetReasoningForSelectedModel && requestedModelId)
				? { kind: "default" }
				: structuredClone(base.reasoningPreference ?? { kind: "default" }),
		route: {
			...base.route,
			source: "spawn",
			modelId: getSubagentRouteModelId(apiConfiguration),
			...(requestedModelId ? { requestedModelId } : {}),
			...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
		},
	}
}

/** Resolve the profile first, then apply a per-spawn model or effort override. */
export async function resolveSubagentModelRoute(
	options: ResolveSubagentModelRouteOptions,
): Promise<ResolvedSubagentModelRoute> {
	const base = await resolveProfileRoute({
		...options,
		parentReasoningPreference: structuredClone(options.parentReasoningPreference ?? { kind: "default" }),
	})
	const selected = applySubagentSpawnOverrides(
		base,
		options.requestedModelId ?? options.defaultModelId,
		options.requestedReasoningEffort ?? options.defaultReasoningEffort,
	)
	if (options.agentModelId && !options.agentReasoningEffort && !selected.apiConfiguration.reasoningEffort) {
		const effort = await options.resolveModelDefaultReasoningEffort?.(selected.apiConfiguration)
		if (effort) {
			selected.apiConfiguration.reasoningEffort = effort
			selected.apiConfiguration.enableReasoningEffort = effort !== "none"
		}
	}
	// Custom agent settings are applied last. A custom model alone preserves the
	// effort already resolved from the launch/default/parent settings, as in Codex.
	return applySubagentSpawnOverrides(selected, options.agentModelId, options.agentReasoningEffort, false)
}
