import {
	getCuratedModelInfo,
	getModelId,
	getProviderDefaultModelId,
	getUnsupportedCuratedProviderSettings,
	getVscodeLlmCatalogModels,
	getVscodeLlmModelId,
	isCuratedProvider,
	isProviderName,
	providerSettingsSchemaDiscriminated,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type ProviderSettingsWithId,
	type ReasoningEffortExtended,
	type SubagentModelRouteState,
	type TaskReasoningCapabilities,
	type TaskReasoningPreference,
} from "@alpha-code/types"
import { isDeepStrictEqual } from "util"
import { ProviderProfileUnavailableError } from "../config/ProviderProfileUnavailableError"
import { assertTaskReasoningEffortSupported, resolveTaskReasoning } from "./TaskReasoning"

export type SubagentRole = "explore" | "review" | "worker"

interface StoredProviderProfile extends ProviderSettingsWithId {
	name: string
}

export interface SubagentProfileLoader {
	getProfile(params: { name: string } | { id: string }): Promise<StoredProviderProfile>
	assertProfileAvailable?(params: { name: string } | { id: string }): Promise<void>
	listConfig?(): Promise<ProviderSettingsEntry[]>
}

export interface ResolveSubagentModelRouteOptions {
	role: SubagentRole
	parentApiConfiguration: ProviderSettings
	parentApiConfigName?: string
	/** Stable captured identity; never replace it with a later profile using the same name. */
	parentProfileId?: string
	parentReasoningPreference?: TaskReasoningPreference
	defaultProfileId?: string
	profileByRole?: Partial<Record<SubagentRole, string>>
	profileLoader: SubagentProfileLoader
	requestedProvider?: string
	/** Saved profile ID or exact name; never an endpoint or a credential. */
	requestedProfile?: string
	requestedModelId?: string
	requestedReasoningEffort?: ReasoningEffortExtended
	defaultModelId?: string
	defaultReasoningEffort?: ReasoningEffortExtended
	agentProfileId?: string
	agentModelId?: string
	agentReasoningEffort?: ReasoningEffortExtended
	resolveModelDefaultReasoningEffort?(configuration: ProviderSettings): Promise<ReasoningEffortExtended | undefined>
	resolveReasoningCapabilities?(configuration: ProviderSettings): Promise<TaskReasoningCapabilities>
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

const profileRoute = (
	profile: StoredProviderProfile,
	source: SubagentModelRouteState["source"],
): ResolvedSubagentModelRoute => {
	const apiConfiguration = settingsFromProfile(profile)
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

/** Host selectors and registered scripted runtimes carry their route locator outside generic model-id fields. */
export const getSubagentRouteModelId = (settings: ProviderSettings): string | undefined => {
	if (settings.apiProvider === "fake-ai") {
		const runtime = settings.fakeAi
		return runtime && typeof runtime === "object" && "id" in runtime && typeof runtime.id === "string"
			? runtime.id
			: undefined
	}
	return getModelId(settings)
}

const modelPreferenceKeys = new Set([
	"apiModelId",
	"openAiModelId",
	"openRouterModelId",
	"vsCodeLmModelSelector",
	"openAiCustomModelInfo",
	"includeMaxTokens",
	"todoListEnabled",
	"modelTemperature",
	"rateLimitSeconds",
	"consecutiveMistakeLimit",
	"enableReasoningEffort",
	"reasoningEffort",
	"modelMaxTokens",
	"modelMaxThinkingTokens",
	"verbosity",
	"vsCodeLmContextSize",
	"vertex1MContext",
	"anthropicBeta1MContext",
	"vertexStreamingEnabled",
	"stellarStreamingEnabled",
	"openAiStreamingEnabled",
	"openRouterStreamingEnabled",
	"refreshIntervalMinutes",
	"vertexGatewayTokenRefreshMinutes",
	"stellarTokenRefreshMinutes",
	"openAiNativeServiceTier",
	"openAiR1FormatEnabled",
])

const falseByDefaultIdentityFlags = new Set([
	"openAiUseAzure",
	"anthropicUseAuthToken",
	"awsUseProfile",
	"awsUseApiKey",
])

const capturedProfileIdentity = (configuration: ProviderSettings): unknown => {
	// The provider's own schema excludes unrelated providers/indexing credentials.
	// Model and task preferences may legitimately differ from the saved profile.
	const parsed = providerSettingsSchemaDiscriminated.safeParse(snapshotProviderSettings(configuration))
	if (!parsed.success) return undefined
	const unsupportedFields = isCuratedProvider(configuration.apiProvider)
		? getUnsupportedCuratedProviderSettings(configuration.apiProvider, configuration)
		: undefined
	const fields = {
		...parsed.data,
		vsCodeLmVendor:
			configuration.apiProvider === "vscode-lm" ? configuration.vsCodeLmModelSelector?.vendor : undefined,
	}
	return Object.fromEntries(
		Object.entries(fields).filter(
			([key, value]) =>
				value !== undefined &&
				value !== "" &&
				!modelPreferenceKeys.has(key) &&
				!(value === false && falseByDefaultIdentityFlags.has(key)) &&
				!(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) &&
				!(unsupportedFields && key.endsWith("BaseUrl") && !unsupportedFields.some((field) => field === key)),
		),
	)
}

/** Validate selected curated routes before task admission without instantiating an adapter or discovering models. */
export function assertCuratedModelRouteSupported(configuration: ProviderSettings): void {
	const provider = configuration.apiProvider
	if (!isCuratedProvider(provider)) return
	const unsupportedFields = getUnsupportedCuratedProviderSettings(provider, configuration)
	if (unsupportedFields.length) {
		throw new Error(
			`Saved ${provider} profile has unsupported settings: ${unsupportedFields.join(", ")}. Reconfigure the profile before selecting this route.`,
		)
	}
	const modelId = getSubagentRouteModelId(configuration)
	if (modelId !== undefined && !getCuratedModelInfo(provider, modelId.trim())) {
		throw new Error(
			`Unsupported ${provider} model ${JSON.stringify(modelId)}. A model alone keeps the selected provider. Call list_provider_profiles for saved connections, then set profile to the returned ID and omit model to use its configured model.`,
		)
	}
}

/** Explicit selections fail closed; only legacy implicit defaults may fall back to the invoking profile. */
async function loadExplicitProfile(
	loader: SubagentProfileLoader,
	selection: string,
	idOnly = false,
): Promise<StoredProviderProfile> {
	if (!selection.trim()) throw new Error("Select a saved provider profile by its ID or exact name.")
	const entries = await loader.listConfig?.()
	const matches = entries?.filter((entry) => entry.id === selection || (!idOnly && entry.name === selection))
	if (matches && matches.length !== 1) {
		throw new Error(
			matches.length
				? `Saved provider profile ${JSON.stringify(selection)} is ambiguous. Select its unique profile ID.`
				: `Saved provider profile ${JSON.stringify(selection)} was not found. Select an existing saved profile.`,
		)
	}
	const entry = matches?.[0]
	if (entry?.availability) {
		throw new ProviderProfileUnavailableError(entry.availability, entry, entry.invalidFields)
	}
	const queries: Array<{ id: string } | { name: string }> = entry
		? [entry.id ? { id: entry.id } : { name: entry.name }]
		: idOnly
			? [{ id: selection }]
			: [{ id: selection }, { name: selection }]
	let profile: StoredProviderProfile | undefined
	for (const query of queries) {
		try {
			await loader.assertProfileAvailable?.(query)
			profile = await loader.getProfile(query)
			break
		} catch (error) {
			if (error instanceof ProviderProfileUnavailableError) throw error
		}
	}
	if (!profile || (entry?.id && profile.id !== entry.id)) {
		throw new Error(
			`Saved provider profile ${JSON.stringify(selection)} was not found or could not be loaded. Select an existing saved profile.`,
		)
	}
	if (!profile.apiProvider) {
		throw new Error(
			`Saved provider profile ${JSON.stringify(profile.name)} is not configured. Configure it before use.`,
		)
	}
	if (!isProviderName(profile.apiProvider) && profile.apiProvider !== "fake-ai") {
		throw new ProviderProfileUnavailableError("unsupported", { id: profile.id ?? "", name: profile.name })
	}
	return profile
}

async function resolveExplicitProfileRoute(
	options: ResolveSubagentModelRouteOptions,
): Promise<ResolvedSubagentModelRoute | undefined> {
	// Provider/profile selection extends Codex CLI (2f47f9779282): the complete
	// saved profile owns credentials, while execution authority remains inherited.
	const provider = options.requestedProvider
	if (provider !== undefined && !isProviderName(provider)) {
		throw new Error(
			`Unknown provider ${JSON.stringify(provider)}. Select a canonical provider ID from the saved profiles.`,
		)
	}
	const requested =
		options.requestedProfile !== undefined
			? await loadExplicitProfile(options.profileLoader, options.requestedProfile)
			: undefined
	const fixed =
		options.agentProfileId !== undefined
			? await loadExplicitProfile(options.profileLoader, options.agentProfileId, true)
			: undefined
	if (fixed && ((requested && fixed.id !== requested.id) || (provider && fixed.apiProvider !== provider))) {
		throw new Error(
			`Named-agent profile ${JSON.stringify(fixed.name)} conflicts with the requested provider or profile. Use the named agent's profile or select a different agent type.`,
		)
	}
	const selected = fixed ?? requested
	if (selected) {
		if (provider && selected.apiProvider !== provider) {
			throw new Error(
				`Saved provider profile ${JSON.stringify(selected.name)} uses provider ${JSON.stringify(selected.apiProvider)}, which conflicts with requested provider ${JSON.stringify(provider)}.`,
			)
		}
		const result = profileRoute(selected, requested || provider ? "spawn" : "role")
		if (requested) result.route.requestedProfileId = requested.id
		return result
	}
	if (provider === undefined) return undefined
	if (provider === options.parentApiConfiguration.apiProvider) {
		return resolveParentRoute(options, "spawn")
	}
	const entries = await options.profileLoader.listConfig?.()
	const candidates = entries?.filter((entry) => entry.apiProvider === provider && !entry.availability) ?? []
	if (candidates.length !== 1) {
		const choices = candidates
			.slice(0, 10)
			.map((entry) => `${JSON.stringify(entry.name)} (${entry.id})`)
			.join(", ")
		throw new Error(
			candidates.length
				? `Provider ${JSON.stringify(provider)} has multiple saved profiles. Set profile to a saved profile ID or exact name: ${choices}.`
				: `No available saved profile for provider ${JSON.stringify(provider)}. Configure a profile in Settings before selecting this provider.`,
		)
	}
	const profile = await loadExplicitProfile(options.profileLoader, candidates[0].id, true)
	if (profile.apiProvider !== provider) {
		throw new Error(
			`Saved provider profile ${JSON.stringify(profile.name)} now uses provider ${JSON.stringify(profile.apiProvider)}, which conflicts with requested provider ${JSON.stringify(provider)}. Select the profile again.`,
		)
	}
	return profileRoute(profile, "spawn")
}

async function resolveParentRoute(
	options: ResolveSubagentModelRouteOptions,
	source: SubagentModelRouteState["source"],
	fallback?: Pick<SubagentModelRouteState, "requestedProfileId" | "fallbackReason">,
): Promise<ResolvedSubagentModelRoute> {
	const apiConfiguration = snapshotProviderSettings(options.parentApiConfiguration)
	let apiConfigName = options.parentApiConfigName?.trim() || "Parent profile"
	let profileId = options.parentProfileId || undefined

	if (profileId) {
		try {
			const profile = await options.profileLoader.getProfile({ id: profileId })
			if (profile.id === profileId) apiConfigName = profile.name
		} catch {
			// A deleted/unavailable identity must stay captured; never rebind it by name.
		}
	} else if (options.parentApiConfigName) {
		let profile: StoredProviderProfile | undefined
		try {
			profile = await options.profileLoader.getProfile({ name: options.parentApiConfigName })
		} catch {
			// Historical tasks can refer to a renamed or deleted profile. The task's
			// in-memory configuration is still the authoritative inheritance source.
		}
		if (profile) {
			const identity = capturedProfileIdentity(apiConfiguration)
			if (identity && isDeepStrictEqual(identity, capturedProfileIdentity(profile))) {
				profileId = profile.id || undefined
			}
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
			// Inline API configurations remain authoritative even if the displayed
			// profile name belongs to another route. Cold restore must not borrow it.
			...(!profileId ? { unboundProfile: true as const } : {}),
			profileName: apiConfigName,
			provider: apiConfiguration.apiProvider,
			modelId: getSubagentRouteModelId(apiConfiguration),
			...fallback,
		},
	}
}

/** Resolve and snapshot a sub-agent profile without mutating the active provider profile. */
async function resolveProfileRoute(options: ResolveSubagentModelRouteOptions): Promise<ResolvedSubagentModelRoute> {
	const explicit = await resolveExplicitProfileRoute(options)
	if (explicit) return explicit
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

	return profileRoute(profile, source)
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
				const catalogModel =
					!selector?.vendor || selector.vendor === "copilot"
						? catalog.find(
								(model) =>
									model.family === requestedModelId ||
									getVscodeLlmModelId(model) === requestedModelId,
							)
						: undefined
				apiConfiguration.apiModelId = undefined
				apiConfiguration.openAiModelId = undefined
				// A new catalog choice replaces the old model's pin. Unknown opaque
				// IDs remain exact and retain the selected host vendor's boundary.
				apiConfiguration.vsCodeLmModelSelector = catalogModel
					? { vendor: "copilot", family: catalogModel.family }
					: {
							...(selector?.vendor ? { vendor: selector.vendor } : {}),
							id: requestedModelId,
						}
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
		parentApiConfiguration: snapshotProviderSettings(options.parentApiConfiguration),
		parentReasoningPreference: structuredClone(options.parentReasoningPreference ?? { kind: "default" }),
	})
	// An explicit or named-agent Alpha profile owns its configured model and effort.
	// Global defaults fill an omitted selection rather than overwrite that choice.
	const hasSelectedProfile = options.requestedProfile !== undefined || options.agentProfileId !== undefined
	const requestedModelId = options.requestedModelId ?? (hasSelectedProfile ? undefined : options.defaultModelId)
	const requestedReasoningEffort =
		options.requestedReasoningEffort ?? (hasSelectedProfile ? undefined : options.defaultReasoningEffort)
	const selected = applySubagentSpawnOverrides(base, requestedModelId, requestedReasoningEffort)
	const hasLaunchSelection =
		options.requestedProvider !== undefined ||
		options.requestedProfile !== undefined ||
		options.requestedModelId !== undefined ||
		options.requestedReasoningEffort !== undefined ||
		options.defaultModelId !== undefined ||
		options.defaultReasoningEffort !== undefined ||
		options.agentProfileId !== undefined
	const capabilityCache = new Map<string, Promise<TaskReasoningCapabilities | undefined>>()
	const validateEffort = async (route: ResolvedSubagentModelRoute, effort?: ReasoningEffortExtended) => {
		if (!effort) return
		const configuration = route.apiConfiguration
		const provider = configuration.apiProvider
		const modelId =
			getSubagentRouteModelId(configuration) ??
			(isCuratedProvider(provider) ? getProviderDefaultModelId(provider) : undefined)
		const key = JSON.stringify([provider, modelId])
		let pending = capabilityCache.get(key)
		if (!pending) {
			pending = (async () => {
				const info =
					isCuratedProvider(provider) && modelId ? getCuratedModelInfo(provider, modelId.trim()) : undefined
				if (info && modelId) {
					return resolveTaskReasoning(configuration, { kind: "default" }, { id: modelId, info }).state
						.capabilities
				}
				return options.resolveReasoningCapabilities?.(configuration)
			})()
			capabilityCache.set(key, pending)
		}
		const capabilities = await pending
		if (capabilities) assertTaskReasoningEffortSupported(effort, capabilities, modelId ?? "selected model")
	}
	// Codex 2f47f9779282 child_config.rs validates launch/default choices before
	// layering the role, then validates the resulting role model and effort.
	if (hasLaunchSelection) assertCuratedModelRouteSupported(selected.apiConfiguration)
	await validateEffort(selected, requestedReasoningEffort)
	if (options.agentModelId && !options.agentReasoningEffort && !selected.apiConfiguration.reasoningEffort) {
		const effort = await options.resolveModelDefaultReasoningEffort?.(selected.apiConfiguration)
		if (effort) {
			selected.apiConfiguration.reasoningEffort = effort
			selected.apiConfiguration.enableReasoningEffort = effort !== "none"
		}
	}
	// Custom agent settings are applied last. A custom model alone preserves the
	// effort already resolved from the launch/default/parent settings, as in Codex.
	const resolved = applySubagentSpawnOverrides(selected, options.agentModelId, options.agentReasoningEffort, false)
	if (hasLaunchSelection || options.agentModelId !== undefined || options.agentReasoningEffort !== undefined) {
		assertCuratedModelRouteSupported(resolved.apiConfiguration)
	}
	const preference = resolved.reasoningPreference
	const configuredEffort = resolved.apiConfiguration.reasoningEffort
	const preservedEffort = options.agentModelId
		? preference?.kind === "effort"
			? preference.effort
			: preference?.kind === "off" ||
				  resolved.apiConfiguration.enableReasoningEffort === false ||
				  configuredEffort === "disable"
				? "none"
				: configuredEffort
		: undefined
	const effectiveRoleEffort = options.agentReasoningEffort ?? requestedReasoningEffort ?? preservedEffort
	await validateEffort(resolved, effectiveRoleEffort)
	// Persist the resulting flags independently of requested arguments. An empty
	// snapshot also matters: reload must clear flags added to the saved profile.
	resolved.route.reasoningConfiguration = {
		...(resolved.apiConfiguration.enableReasoningEffort !== undefined
			? { enableReasoningEffort: resolved.apiConfiguration.enableReasoningEffort }
			: {}),
		...(resolved.apiConfiguration.reasoningEffort !== undefined
			? { reasoningEffort: resolved.apiConfiguration.reasoningEffort }
			: {}),
	}
	return resolved
}
