import {
	getModelId,
	type ProviderSettings,
	type ProviderSettingsWithId,
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
			modelId: getModelId(apiConfiguration),
			...fallback,
		},
	}
}

/** Resolve and snapshot a sub-agent profile without mutating the active provider profile. */
export async function resolveSubagentModelRoute(
	options: ResolveSubagentModelRouteOptions,
): Promise<ResolvedSubagentModelRoute> {
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
			modelId: getModelId(apiConfiguration),
		},
	}
}
