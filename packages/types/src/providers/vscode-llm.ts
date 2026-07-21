import type { ModelInfo } from "../model.js"

export type VscodeLlmModelId = keyof typeof vscodeLlmModels
export type VscodeLlmModelInfo = ModelInfo & {
	family: string
	version: string
	name: string
	supportsToolCalling: boolean
	maxInputTokens: number
	supportsContextWindowConfiguration?: boolean
}
export type VscodeLlmModelSelectorLike = {
	vendor?: string
	family?: string
	id?: string
	name?: string
	version?: string
}

export const vscodeLlmDefaultModelId: VscodeLlmModelId = "gpt-5.5"

const COPILOT_DEFAULT_CONTEXT_WINDOW = 128_000
const COPILOT_GPT_5_CONTEXT_WINDOW = 272_000
const COPILOT_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["low", "medium", "high"]
const COPILOT_EXTRA_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["none", "low", "medium", "high", "xhigh"]
const COPILOT_CODEX_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["low", "medium", "high", "xhigh"]
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
	deprecated,
}: {
	name: string
	family: string
	version?: string
	contextWindow?: number
	supportsImages?: boolean
	supportsReasoningEffort?: ModelInfo["supportsReasoningEffort"]
	supportsContextWindowConfiguration?: boolean
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
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gpt-5.3-codex": copilotModel({
		name: "GPT-5.3-Codex",
		family: "gpt-5.3-codex",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsReasoningEffort: COPILOT_CODEX_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gpt-5.4": copilotModel({
		name: "GPT-5.4",
		family: "gpt-5.4",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsReasoningEffort: COPILOT_CODEX_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gpt-5.4-mini": copilotModel({
		name: "GPT-5.4 mini",
		family: "gpt-5.4-mini",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsReasoningEffort: COPILOT_EXTRA_REASONING_EFFORTS,
	}),
	"gpt-5.4-nano": copilotModel({
		name: "GPT-5.4 nano",
		family: "gpt-5.4-nano",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsReasoningEffort: COPILOT_EXTRA_REASONING_EFFORTS,
	}),
	"gpt-5.5": copilotModel({
		name: "GPT-5.5",
		family: "gpt-5.5",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
		supportsReasoningEffort: COPILOT_EXTRA_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gpt-5.6-luna": copilotModel({
		name: "GPT-5.6 Luna",
		family: "gpt-5.6-luna",
		contextWindow: COPILOT_GPT_5_CONTEXT_WINDOW,
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
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"claude-haiku-4.5": copilotModel({
		name: "Claude Haiku 4.5",
		family: "claude-haiku-4.5",
	}),
	"claude-sonnet-4.5": copilotModel({
		name: "Claude Sonnet 4.5",
		family: "claude-sonnet-4.5",
		supportsImages: true,
	}),
	"claude-sonnet-4.6": copilotModel({
		name: "Claude Sonnet 4.6",
		family: "claude-sonnet-4.6",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"claude-sonnet-5": copilotModel({
		name: "Claude Sonnet 5",
		family: "claude-sonnet-5",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"claude-opus-4.5": copilotModel({
		name: "Claude Opus 4.5",
		family: "claude-opus-4.5",
		supportsImages: true,
	}),
	"claude-opus-4.6": copilotModel({
		name: "Claude Opus 4.6",
		family: "claude-opus-4.6",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"claude-opus-4.7": copilotModel({
		name: "Claude Opus 4.7",
		family: "claude-opus-4.7",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"claude-opus-4.8": copilotModel({
		name: "Claude Opus 4.8",
		family: "claude-opus-4.8",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"claude-opus-4.8-fast": copilotModel({
		name: "Claude Opus 4.8 (fast mode)",
		family: "claude-opus-4.8-fast",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
		supportsContextWindowConfiguration: true,
	}),
	"gemini-2.5-pro": copilotModel({
		name: "Gemini 2.5 Pro",
		family: "gemini-2.5-pro",
		supportsImages: true,
	}),
	"gemini-3-flash": copilotModel({
		name: "Gemini 3 Flash",
		family: "gemini-3-flash",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gemini-3.1-pro": copilotModel({
		name: "Gemini 3.1 Pro",
		family: "gemini-3.1-pro",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gemini-3.5-flash": copilotModel({
		name: "Gemini 3.5 Flash",
		family: "gemini-3.5-flash",
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"mai-code-1-flash": copilotModel({
		name: "MAI-Code-1-Flash",
		family: "mai-code-1-flash",
	}),
	"raptor-mini": copilotModel({
		name: "Raptor mini",
		family: "raptor-mini",
	}),
	"kimi-k2.7-code": copilotModel({
		name: "Kimi K2.7 Code",
		family: "kimi-k2.7-code",
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

function includesCompleteModelId(value: string, modelId: string): boolean {
	let searchFromIndex = 0

	while (searchFromIndex < value.length) {
		const matchIndex = value.indexOf(modelId, searchFromIndex)
		if (matchIndex === -1) {
			return false
		}

		const nextCharacter = value[matchIndex + modelId.length]
		if (!nextCharacter || !/[a-z0-9.-]/i.test(nextCharacter)) {
			return true
		}

		searchFromIndex = matchIndex + modelId.length
	}

	return false
}

export function getVscodeLlmModelInfo(model: VscodeLlmModelSelectorLike): VscodeLlmModelInfo | undefined {
	if (model.vendor && model.vendor.toLowerCase() !== "copilot") {
		return undefined
	}

	const searchableValues = [model.family, model.id, model.name, model.version]
		.filter(Boolean)
		.map((value) => value!.toLowerCase())

	for (const [modelId, modelInfo] of Object.entries(vscodeLlmModels)) {
		if (searchableValues.some((value) => value === modelId)) {
			return modelInfo
		}
	}

	const longestModelIdsFirst = Object.entries(vscodeLlmModels).sort(
		([leftModelId], [rightModelId]) => rightModelId.length - leftModelId.length,
	)

	for (const [modelId, modelInfo] of longestModelIdsFirst) {
		if (searchableValues.some((value) => includesCompleteModelId(value, modelId))) {
			return modelInfo
		}
	}

	return undefined
}

/**
 * VS Code exposes the maximum input budget but not Copilot's model configuration schema.
 * Copilot's context-size values are rounded token budgets (for example, 922,000), while
 * `maxInputTokens` reserves a small amount of provider overhead (for example, 921,793).
 */
export function getVscodeLlmExtendedContextSize(
	model: VscodeLlmModelSelectorLike & { maxInputTokens?: number },
): number | undefined {
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

	return Math.round(maxInputTokens / 1_000) * 1_000
}
