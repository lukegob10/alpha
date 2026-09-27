import {
	getModelId,
	type ProviderSettings,
	type ProviderSettingsWithId,
	type ReasoningEffortExtended,
	type SubagentModelRouteState,
} from "@alpha-code/types"

export type SubagentRole = "explore" | "review" | "worker"

interface StoredProviderProfile extends ProviderSettingsWithId {
	name: string
}

export interface SubagentProfileLoader {
	getProfile(params: { name: string } | { id: string }): Promise<StoredProviderProfile>
}

export interface ResolveSubagentModelRouteOptions {
	role: SubagentRole
	parentApiConfiguration: ProviderSettings
	parentApiConfigName?: string
	defaultProfileId?: string
	profileByRole?: Partial<Record<SubagentRole, string>>
	profileLoader: SubagentProfileLoader
	requestedModelId?: string
	requestedReasoningEffort?: ReasoningEffortExtended
}

export interface ResolvedSubagentModelRoute {
	apiConfiguration: ProviderSettings
	apiConfigName: string
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
export const getSubagentRouteModelId = (settings: ProviderSettings): string | undefined =>
	settings.apiProvider === "vscode-lm" ? settings.vsCodeLmModelSelector?.id : getModelId(settings)

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
		profile = await options.profileLoader.getProfile({ id: requestedProfileId })
	} catch {
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
): ResolvedSubagentModelRoute {
	if (!requestedModelId && !requestedReasoningEffort) return base

	const apiConfiguration = snapshotProviderSettings(base.apiConfiguration)
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
				apiConfiguration.openAiModelId = undefined
				apiConfiguration.apiModelId = requestedModelId
				break
			case "vscode-lm":
				apiConfiguration.apiModelId = undefined
				apiConfiguration.openAiModelId = undefined
				apiConfiguration.vsCodeLmModelSelector = { id: requestedModelId }
				break
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
	const base = await resolveProfileRoute(options)
	return applySubagentSpawnOverrides(base, options.requestedModelId, options.requestedReasoningEffort)
}
