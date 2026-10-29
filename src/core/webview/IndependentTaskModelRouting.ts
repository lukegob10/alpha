import {
	getModelId,
	type HistoryItem,
	type ProviderSettingsEntry,
	type ProviderSettings,
	type TaskReasoningCapabilities,
	type TaskReasoningPreference,
} from "@alpha-code/types"

import {
	applySubagentSpawnOverrides,
	assertCuratedModelRouteSupported,
	getSubagentRouteModelId,
	resolveSubagentModelRoute,
	type ResolvedSubagentModelRoute,
	type SubagentProfileLoader,
} from "../agent/SubagentModelRouter"
import type { IndependentTaskModelSelection } from "./CrossTaskOrchestration"
import { buildApiHandler } from "../../api"

export function hasIndependentTaskModelSelection(selection?: IndependentTaskModelSelection): boolean {
	return Boolean(
		selection &&
			(selection.provider !== undefined ||
				selection.profile !== undefined ||
				selection.model !== undefined ||
				selection.reasoningEffort !== undefined),
	)
}

/** Route selection does not grant permission; human provenance is checked independently of model IDs. */
export function assertIndependentTaskModelSelectionRequest(
	request: string | undefined,
	selection?: IndependentTaskModelSelection,
	selectedProfile?: Pick<ProviderSettingsEntry, "id" | "name">,
): void {
	if (!hasIndependentTaskModelSelection(selection)) return
	if (selection?.model !== undefined && (!selection.model.trim() || selection.model.length > 256))
		throw new Error("A thread model ID must contain 1 to 256 characters")
	const source = request?.trim()
	const profileName =
		selectedProfile && (selection?.profile === selectedProfile.id || selection?.profile === selectedProfile.name)
			? selectedProfile.name
			: undefined
	const explicitSelection = Boolean(
		source &&
			(/\b(?:choose|select|change|switch|set|pick)\b[^;!?\n]{0,64}\b(?:model|provider|profile|reasoning|effort)\b/i.test(
				source,
			) ||
				/\b(?:use|using|with)\s+(?:(?:a|an|the|another|different|best|new|high|medium|low|max|xhigh)\s+){0,5}(?:model|provider|profile|reasoning|effort)\b/i.test(
					source,
				) ||
				/(?:^|[.!?\n])\s*(?:please\s+)?use\s+(?:my|this|that)\s+profile\b(?!(?:['’]s)?\s+(?:docs?|documentation|performance|comparison)\b)/i.test(
					source,
				)),
	)
	const namedSelection = Boolean(
		source &&
			[selection?.model, selection?.profile, selection?.provider, profileName].some((value) => {
				const alias = value
					?.toLowerCase()
					.split(/[^a-z0-9]+/)
					.filter(Boolean)
					.join("[\\s._-]*")
				return (
					alias &&
					new RegExp(
						`\\b(?:use|using|with|on|via|select|choose|launch|run|switch\\s+to)\\s+(?:(?:my|the|saved|model|provider|profile)\\s+){0,3}${alias}\\b(?!(?:['’]s)?\\s+(?:docs?|documentation|performance|comparison)\\b)`,
						"i",
					).test(source)
				)
			}),
	)
	if (!source || (!explicitSelection && !namedSelection))
		throw new Error("A thread model/provider/reasoning override requires a selection in the latest human request")
}

/** Reuse the agent router while preserving the sparse update contract of an existing idle thread. */
export async function resolveIndependentTaskModelSelection(options: {
	apiConfiguration: ProviderSettings
	apiConfigName?: string
	parentProfileId?: string
	reasoningPreference?: TaskReasoningPreference
	selection: IndependentTaskModelSelection
	profileLoader: SubagentProfileLoader
	preserveReasoning?: boolean
	resolveReasoningCapabilities?(configuration: ProviderSettings): Promise<TaskReasoningCapabilities>
}): Promise<ResolvedSubagentModelRoute> {
	const { selection } = options
	let route = await resolveSubagentModelRoute({
		role: "worker",
		parentApiConfiguration: options.apiConfiguration,
		parentApiConfigName: options.apiConfigName,
		parentProfileId: options.parentProfileId,
		parentReasoningPreference: options.reasoningPreference,
		profileLoader: options.profileLoader,
		requestedProvider: selection.provider,
		requestedProfile: selection.profile,
		requestedModelId: selection.model,
		requestedReasoningEffort: selection.reasoningEffort,
		resolveReasoningCapabilities: options.resolveReasoningCapabilities,
	})
	if (
		!route.route.profileId &&
		(selection.profile !== undefined ||
			(selection.provider !== undefined && selection.provider !== options.apiConfiguration.apiProvider))
	)
		throw new Error("Save or select the thread's provider profile before changing its model or reasoning")
	if (route.route.profileId) await options.profileLoader.assertProfileAvailable?.({ id: route.route.profileId })
	const priorProfile =
		options.parentProfileId || options.apiConfigName
			? await options.profileLoader
					.getProfile(
						options.parentProfileId ? { id: options.parentProfileId } : { name: options.apiConfigName! },
					)
					.catch(() => undefined)
			: undefined
	if (
		options.preserveReasoning &&
		selection.reasoningEffort === undefined &&
		(priorProfile?.id === route.route.profileId ||
			(!route.route.profileId && !selection.profile && !selection.provider)) &&
		options.apiConfiguration.apiProvider === route.apiConfiguration.apiProvider
	) {
		route = applySubagentSpawnOverrides(
			{
				...route,
				apiConfiguration: {
					...route.apiConfiguration,
					reasoningEffort: options.apiConfiguration.reasoningEffort,
					enableReasoningEffort: options.apiConfiguration.enableReasoningEffort,
				},
				reasoningPreference: structuredClone(options.reasoningPreference ?? { kind: "default" }),
			},
			selection.model,
			undefined,
			false,
		)
	}
	// The empty object deliberately captures cleared defaults. Keep configuration
	// flags separate from explicit effort provenance when restoring this route.
	route.route.reasoningConfiguration = {
		enableReasoningEffort: route.apiConfiguration.enableReasoningEffort,
		reasoningEffort: route.apiConfiguration.reasoningEffort,
	}
	return route
}

/** A captured route never falls back by profile name, even after deletion, rename, or provider edits. */
export async function restoreIndependentTaskModelSelection(
	history: HistoryItem,
	profileLoader: SubagentProfileLoader,
): Promise<ResolvedSubagentModelRoute> {
	const capture = history.threadModelRoute
	if (capture?.unboundProfile) {
		// Inline credentials never enter history. A process-local FakeAI registry
		// locator can rehydrate only its already registered implementation.
		if (capture.provider !== "fake-ai")
			throw new Error(
				"This thread used an unsaved provider configuration; select a saved profile before resuming",
			)
		if (!capture.modelId)
			throw new Error("The thread's FakeAI implementation ID is missing; select a saved profile before resuming")
		const apiConfiguration: ProviderSettings = {
			apiProvider: "fake-ai",
			fakeAi: { id: capture.modelId },
			...(capture.reasoningConfiguration ?? {
				...(capture.requestedReasoningEffort
					? {
							reasoningEffort: capture.requestedReasoningEffort,
							enableReasoningEffort: capture.requestedReasoningEffort !== "none",
						}
					: {}),
			}),
		}
		const handler = buildApiHandler(apiConfiguration)
		handler.dispose?.()
		return {
			apiConfiguration,
			apiConfigName: capture.profileName,
			reasoningPreference: structuredClone(history.reasoningPreference ?? { kind: "default" }),
			route: structuredClone(capture),
		}
	}
	if (capture && (!capture.profileId || !capture.provider))
		throw new Error("The thread's captured provider profile is incomplete; select a saved profile before resuming")
	const query = capture?.profileId
		? { id: capture.profileId }
		: !capture && history.apiConfigName
			? { name: history.apiConfigName }
			: undefined
	if (!query) throw new Error("The thread has no saved provider profile; select a saved profile before resuming")
	await profileLoader.assertProfileAvailable?.(query)
	const { id, name, ...apiConfiguration } = await profileLoader.getProfile(query)
	if (capture && (id !== capture.profileId || apiConfiguration.apiProvider !== capture.provider))
		throw new Error(
			"The thread's captured provider profile is unavailable or has changed provider; select a profile",
		)
	const base: ResolvedSubagentModelRoute = {
		apiConfiguration,
		apiConfigName: name,
		reasoningPreference: structuredClone(history.reasoningPreference ?? { kind: "default" }),
		route: {
			source: "parent",
			resolution: "selected",
			profileId: id,
			profileName: name,
			provider: apiConfiguration.apiProvider,
			modelId: getSubagentRouteModelId(apiConfiguration),
			...(capture ?? {}),
		},
	}
	let modelOverride = capture ? capture.modelId : history.threadModelOverride
	if (apiConfiguration.apiProvider === "fake-ai") {
		if (capture?.reasoningConfiguration !== undefined) {
			if (!capture.modelId) throw new Error("The thread's captured FakeAI implementation ID is missing")
			base.apiConfiguration = { ...apiConfiguration, fakeAi: { id: capture.modelId } }
		} else if (capture?.modelId !== undefined && getModelId(apiConfiguration) !== capture.modelId) {
			throw new Error("The thread's saved FakeAI model no longer matches its captured configuration")
		}
		// New captures use a registry locator; legacy captures retain the profile's
		// generic model identity. Neither is a selectable FakeAI spawn model.
		modelOverride = undefined
	}
	const restored = applySubagentSpawnOverrides(
		base,
		modelOverride,
		capture?.requestedReasoningEffort,
		capture ? capture.requestedModelId !== undefined : true,
	)
	if (capture?.reasoningConfiguration)
		restored.apiConfiguration = {
			...restored.apiConfiguration,
			enableReasoningEffort: capture.reasoningConfiguration.enableReasoningEffort,
			reasoningEffort: capture.reasoningConfiguration.reasoningEffort,
		}
	assertCuratedModelRouteSupported(restored.apiConfiguration)
	if (restored.apiConfiguration.apiProvider === "fake-ai") {
		const handler = buildApiHandler(restored.apiConfiguration)
		handler.dispose?.()
	}
	return {
		...restored,
		reasoningPreference: base.reasoningPreference,
		route: { ...restored.route, profileName: name },
	}
}
