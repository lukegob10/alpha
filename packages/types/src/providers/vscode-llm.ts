import type { ModelInfo } from "../model.js"

export type VscodeLlmModelId = keyof typeof vscodeLlmModels
export type VscodeLlmModelInfo = ModelInfo & {
	family: string
	version: string
	name: string
	supportsToolCalling: boolean
	maxInputTokens: number
	supportsContextWindowConfiguration?: boolean
	extendedContextSize?: number
}
export type VscodeLlmModelSelectorLike = {
	vendor?: string
	family?: string
	id?: string
	name?: string
	version?: string
	maxInputTokens?: number
}

export type VscodeLlmModelMetadata = VscodeLlmModelSelectorLike

export const vscodeLlmDefaultModelId: VscodeLlmModelId = "gpt-5.5"

const COPILOT_DEFAULT_CONTEXT_WINDOW = 128_000
const COPILOT_GPT_5_CONTEXT_WINDOW = 272_000
const COPILOT_GPT_5_6_LUNA_CONTEXT_WINDOW = 200_000
const COPILOT_EXTENDED_CONTEXT_SIZE = 922_000
const COPILOT_CLAUDE_CONTEXT_WINDOW = 200_000
const COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE = 936_000
const COPILOT_GEMINI_CONTEXT_WINDOW = 200_000
const COPILOT_GEMINI_EXTENDED_CONTEXT_SIZE = 936_000
const COPILOT_GROK_CONTEXT_WINDOW = 200_000
const COPILOT_GROK_EXTENDED_CONTEXT_SIZE = 425_001
const COPILOT_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["low", "medium", "high"]
const COPILOT_MINIMAL_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["minimal", "low", "medium", "high"]
const COPILOT_EXTRA_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["none", "low", "medium", "high", "xhigh"]
const COPILOT_CODEX_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["low", "medium", "high", "xhigh"]
const COPILOT_KIMI_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["low", "high", "max"]
const COPILOT_CLAUDE_46_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["low", "medium", "high", "max"]
const COPILOT_CLAUDE_FRONTIER_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]
const COPILOT_MAX_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]

function copilotModel({
	name,
	family,
	version = family,
	contextWindow = COPILOT_DEFAULT_CONTEXT_WINDOW,
	supportsImages = false,
	supportsReasoningEffort,
	supportsContextWindowConfiguration = false,
	extendedContextSize,
	deprecated,
}: {
	name: string
	family: string
	version?: string
	contextWindow?: number
	supportsImages?: boolean
	supportsReasoningEffort?: ModelInfo["supportsReasoningEffort"]
	supportsContextWindowConfiguration?: boolean
	extendedContextSize?: number
	deprecated?: boolean
}): VscodeLlmModelInfo {
	return {
		contextWindow,
		maxInputTokens: contextWindow,
		maxTokens: -1,
		supportsImages,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		family,
		version,
		name,
		supportsToolCalling: true,
		supportsReasoningEffort,
		supportsContextWindowConfiguration,
		extendedContextSize: supportsContextWindowConfiguration
			? (extendedContextSize ?? COPILOT_EXTENDED_CONTEXT_SIZE)
			: undefined,
		deprecated,
	}
}

// Mirrors the current GitHub Copilot supported-models documentation. The live
// VS Code LM provider still uses vscode.lm.selectChatModels() as the source of truth.
// https://docs.github.com/en/copilot/reference/ai-models/supported-models
export const vscodeLlmModels = {
	"gpt-5-mini": copilotModel({
		name: "GPT-5 mini",
		family: "gpt-5-mini",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gpt-5.3-codex": copilotModel({
		name: "GPT-5.3-Codex",
		family: "gpt-5.3-codex",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CODEX_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gpt-5.4": copilotModel({
		name: "GPT-5.4",
		family: "gpt-5.4",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_EXTRA_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gpt-5.4-mini": copilotModel({
		name: "GPT-5.4 mini",
		family: "gpt-5.4-mini",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_EXTRA_REASONING_EFFORTS,
	}),
	"gpt-5.4-nano": copilotModel({
		name: "GPT-5.4 nano",
		family: "gpt-5.4-nano",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsReasoningEffort: COPILOT_EXTRA_REASONING_EFFORTS,
		deprecated: true,
	}),
	"gpt-5.5": copilotModel({
		name: "GPT-5.5",
		family: "gpt-5.5",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_EXTRA_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gpt-5.6-luna": copilotModel({
		name: "GPT-5.6 Luna",
		family: "gpt-5.6-luna",
		contextWindow: COPILOT_GPT_5_6_LUNA_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_MAX_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gpt-5.6-sol": copilotModel({
		name: "GPT-5.6 Sol",
		family: "gpt-5.6-sol",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_MAX_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gpt-5.6-terra": copilotModel({
		name: "GPT-5.6 Terra",
		family: "gpt-5.6-terra",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_MAX_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"claude-fable-5": copilotModel({
		name: "Claude Fable 5",
		family: "claude-fable-5",
		contextWindow: COPILOT_CLAUDE_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CLAUDE_FRONTIER_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE,
	}),
	"claude-haiku-4.5": copilotModel({
		name: "Claude Haiku 4.5",
		family: "claude-haiku-4.5",
		supportsImages: true,
	}),
	"claude-sonnet-4.5": copilotModel({
		name: "Claude Sonnet 4.5",
		family: "claude-sonnet-4.5",
		supportsImages: true,
	}),
	"claude-sonnet-4.6": copilotModel({
		name: "Claude Sonnet 4.6",
		family: "claude-sonnet-4.6",
		contextWindow: COPILOT_CLAUDE_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CLAUDE_46_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE,
	}),
	"claude-sonnet-5": copilotModel({
		name: "Claude Sonnet 5",
		family: "claude-sonnet-5",
		contextWindow: COPILOT_CLAUDE_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CLAUDE_FRONTIER_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE,
	}),
	"claude-opus-4.5": copilotModel({
		name: "Claude Opus 4.5",
		family: "claude-opus-4.5",
		supportsImages: true,
	}),
	"claude-opus-4.6": copilotModel({
		name: "Claude Opus 4.6",
		family: "claude-opus-4.6",
		contextWindow: COPILOT_CLAUDE_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CLAUDE_46_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE,
	}),
	"claude-opus-4.7": copilotModel({
		name: "Claude Opus 4.7",
		family: "claude-opus-4.7",
		contextWindow: COPILOT_CLAUDE_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CLAUDE_FRONTIER_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE,
	}),
	"claude-opus-4.8": copilotModel({
		name: "Claude Opus 4.8",
		family: "claude-opus-4.8",
		contextWindow: COPILOT_CLAUDE_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CLAUDE_FRONTIER_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE,
	}),
	"claude-opus-4.8-fast": copilotModel({
		name: "Claude Opus 4.8 (fast mode) (Preview)",
		family: "claude-opus-4.8-fast",
		contextWindow: COPILOT_CLAUDE_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CLAUDE_FRONTIER_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE,
	}),
	"claude-opus-5": copilotModel({
		name: "Claude Opus 5",
		family: "claude-opus-5",
		contextWindow: COPILOT_CLAUDE_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CLAUDE_FRONTIER_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_CLAUDE_EXTENDED_CONTEXT_SIZE,
	}),
	"gemini-2.5-pro": copilotModel({
		name: "Gemini 2.5 Pro",
		family: "gemini-2.5-pro",
		supportsImages: true,
		deprecated: true,
	}),
	"gemini-3-flash": copilotModel({
		name: "Gemini 3 Flash",
		family: "gemini-3-flash",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		deprecated: true,
	}),
	"gemini-3.1-pro": copilotModel({
		name: "Gemini 3.1 Pro (Preview)",
		family: "gemini-3.1-pro",
		contextWindow: COPILOT_GEMINI_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_GEMINI_EXTENDED_CONTEXT_SIZE,
	}),
	"gemini-3.5-flash": copilotModel({
		name: "Gemini 3.5 Flash",
		family: "gemini-3.5-flash",
		contextWindow: COPILOT_GEMINI_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_MINIMAL_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_GEMINI_EXTENDED_CONTEXT_SIZE,
	}),
	"gemini-3.6-flash": copilotModel({
		name: "Gemini 3.6 Flash",
		family: "gemini-3.6-flash",
		contextWindow: COPILOT_GEMINI_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_MINIMAL_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_GEMINI_EXTENDED_CONTEXT_SIZE,
	}),
	"gemini-3.7-flash": copilotModel({
		name: "Gemini 3.7 Flash",
		family: "gemini-3.7-flash",
		contextWindow: COPILOT_GEMINI_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_GEMINI_EXTENDED_CONTEXT_SIZE,
	}),
	"mai-code-1-flash": copilotModel({
		name: "MAI-Code-1-Flash",
		family: "mai-code-1-flash",
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"mai-code-1.1-flash": copilotModel({
		name: "MAI-Code-1.1-Flash",
		family: "mai-code-1.1-flash",
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsImages: true,
	}),
	"raptor-mini": copilotModel({
		name: "Raptor mini",
		family: "raptor-mini",
		contextWindow: 200_000,
		supportsImages: true,
	}),
	"kimi-k2.7-code": copilotModel({
		name: "Kimi K2.7 Code",
		family: "kimi-k2.7-code",
		contextWindow: 224_000,
		supportsImages: true,
	}),
	"kimi-k3": copilotModel({
		name: "Kimi K3",
		family: "kimi-k3",
		contextWindow: 917_504,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_KIMI_REASONING_EFFORTS,
	}),
	"grok-4.5": copilotModel({
		name: "Grok 4.5",
		family: "grok-4.5",
		contextWindow: COPILOT_GROK_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_GROK_EXTENDED_CONTEXT_SIZE,
	}),
	"grok-4.6": copilotModel({
		name: "Grok 4.6",
		family: "grok-4.6",
		contextWindow: COPILOT_GROK_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_CODEX_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
		extendedContextSize: COPILOT_GROK_EXTENDED_CONTEXT_SIZE,
	}),
	"gpt-4.1": copilotModel({
		name: "GPT-4.1",
		family: "gpt-4.1",
		deprecated: true,
	}),
	"gpt-5.2": copilotModel({
		name: "GPT-5.2",
		family: "gpt-5.2",
		deprecated: true,
	}),
	"gpt-5.2-codex": copilotModel({
		name: "GPT-5.2-Codex",
		family: "gpt-5.2-codex",
		deprecated: true,
	}),
} as const satisfies Record<string, VscodeLlmModelInfo>

const vscodeLlmModelAliases: Partial<Record<VscodeLlmModelId, readonly string[]>> = {
	"gemini-3-flash": ["gemini-3-flash-preview"],
	"gemini-3.1-pro": ["gemini-3.1-pro-preview"],
	"mai-code-1-flash": ["mai-code-1-flash-picker"],
	"raptor-mini": ["oswe-vscode-prime", "oswe-vscode"],
}

const hiddenVscodeLlmModelIds = ["claude-mythos-5"] as const

function getVscodeLlmModelIdentifiers(modelId: VscodeLlmModelId): string[] {
	return [modelId, vscodeLlmModels[modelId].family, ...(vscodeLlmModelAliases[modelId] ?? [])].filter(
		(value, index, identifiers) => identifiers.indexOf(value) === index,
	)
}

function includesCompleteModelId(value: string, modelId: string): boolean {
	let searchFromIndex = 0

	while (searchFromIndex < value.length) {
		const matchIndex = value.indexOf(modelId, searchFromIndex)
		if (matchIndex === -1) {
			return false
		}

		const nextCharacter = value[matchIndex + modelId.length]
		if (!nextCharacter || !/[a-z0-9.]/i.test(nextCharacter)) {
			return true
		}

		searchFromIndex = matchIndex + modelId.length
	}

	return false
}

export function getVscodeLlmModelId(model: VscodeLlmModelSelectorLike): VscodeLlmModelId | undefined {
	if (model.vendor && model.vendor.toLowerCase() !== "copilot") {
		return undefined
	}

	const searchableValues = [model.family, model.id, model.name, model.version]
		.filter(Boolean)
		.map((value) => value!.toLowerCase())

	for (const modelId of Object.keys(vscodeLlmModels) as VscodeLlmModelId[]) {
		if (searchableValues.some((value) => getVscodeLlmModelIdentifiers(modelId).includes(value))) {
			return modelId
		}
	}

	const longestIdentifiersFirst = (Object.keys(vscodeLlmModels) as VscodeLlmModelId[])
		.flatMap((modelId) => getVscodeLlmModelIdentifiers(modelId).map((identifier) => ({ identifier, modelId })))
		.sort((left, right) => right.identifier.length - left.identifier.length)

	for (const { identifier, modelId } of longestIdentifiersFirst) {
		if (searchableValues.some((value) => includesCompleteModelId(value, identifier))) {
			return modelId
		}
	}

	return undefined
}

export function getVscodeLlmModelInfo(model: VscodeLlmModelSelectorLike): VscodeLlmModelInfo | undefined {
	const modelId = getVscodeLlmModelId(model)
	return modelId ? vscodeLlmModels[modelId] : undefined
}

function serializeVscodeLlmModel(model: VscodeLlmModelMetadata): VscodeLlmModelMetadata {
	return {
		vendor: model.vendor,
		family: model.family,
		version: model.version,
		id: model.id,
		name: model.name,
		maxInputTokens: model.maxInputTokens,
	}
}

function getVscodeLlmSelectorKey(model: VscodeLlmModelSelectorLike): string {
	return [model.vendor, model.family, model.version, model.id].filter(Boolean).join("/")
}

function getVscodeLlmLiveIdentityKey(model: VscodeLlmModelSelectorLike): string {
	// VS Code documents model IDs as opaque, provider-owned identifiers. A family
	// describes capabilities; it is not a unique routing identity.
	return model.id ? `id:${model.vendor ?? ""}/${model.id}` : `selector:${getVscodeLlmSelectorKey(model)}`
}

function isHiddenVscodeLlmModel(model: VscodeLlmModelSelectorLike): boolean {
	const searchableValues = [model.family, model.id, model.name, model.version]
		.filter(Boolean)
		.map((value) => value!.toLowerCase())

	return hiddenVscodeLlmModelIds.some((modelId) =>
		searchableValues.some((value) => includesCompleteModelId(value, modelId)),
	)
}

function shouldPreferVscodeLlmModel(candidate: VscodeLlmModelMetadata, current: VscodeLlmModelMetadata): boolean {
	return (
		typeof candidate.maxInputTokens === "number" &&
		candidate.maxInputTokens > (current.maxInputTokens ?? Number.NEGATIVE_INFINITY)
	)
}

/**
 * Returns the documented Copilot catalog as broad selectors for capability inspection.
 * These selectors must not be presented as available models: availability is scoped to
 * the current VS Code window, Copilot account, plan, and organization policy.
 */
export function getVscodeLlmCatalogModels(): VscodeLlmModelMetadata[] {
	return (Object.keys(vscodeLlmModels) as VscodeLlmModelId[])
		.filter((modelId) => !vscodeLlmModels[modelId].deprecated)
		.map((modelId) => {
			const modelInfo = vscodeLlmModels[modelId]
			return {
				vendor: "copilot",
				family: vscodeLlmModelAliases[modelId]?.[0] ?? modelInfo.family,
				name: modelInfo.name,
			}
		})
}

/** Deduplicate exact live identities without collapsing provider-returned variants. */
export function mergeVscodeLlmModels(liveModels: readonly VscodeLlmModelMetadata[]): VscodeLlmModelMetadata[] {
	const mergedModels: VscodeLlmModelMetadata[] = []
	const identityIndexes = new Map<string, number>()

	for (const liveModel of liveModels) {
		const serializedModel = serializeVscodeLlmModel(liveModel)
		if (isHiddenVscodeLlmModel(serializedModel)) {
			continue
		}

		const identityKey = getVscodeLlmLiveIdentityKey(serializedModel)
		if (!identityKey || identityKey === "selector:") {
			continue
		}

		const existingIndex = identityIndexes.get(identityKey)
		if (existingIndex === undefined) {
			identityIndexes.set(identityKey, mergedModels.length)
			mergedModels.push(serializedModel)
		} else {
			const existingModel = mergedModels[existingIndex]
			if (existingModel && shouldPreferVscodeLlmModel(serializedModel, existingModel)) {
				mergedModels[existingIndex] = serializedModel
			}
		}
	}

	return mergedModels
}

/**
 * VS Code exposes the maximum input budget but not Copilot's model configuration schema.
 * Copilot's context-size values are rounded token budgets (for example, 922,000), while
 * `maxInputTokens` reserves a small amount of provider overhead (for example, 921,793).
 */
export function getVscodeLlmExtendedContextSize(model: VscodeLlmModelSelectorLike): number | undefined {
	const modelInfo = getVscodeLlmModelInfo(model)
	const maxInputTokens = model.maxInputTokens

	if (
		!modelInfo?.supportsContextWindowConfiguration ||
		typeof maxInputTokens !== "number" ||
		!Number.isFinite(maxInputTokens) ||
		maxInputTokens <= modelInfo.contextWindow
	) {
		return undefined
	}

	return modelInfo.extendedContextSize ?? Math.round(maxInputTokens / 1_000) * 1_000
}
