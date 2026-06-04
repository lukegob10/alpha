import { useState, useCallback, useMemo } from "react"
import { useEvent } from "react-use"
import type { LanguageModelChatSelector } from "vscode"

import {
	type ProviderSettings,
	type ExtensionMessage,
	type ModelInfo,
	vscodeLlmModels,
	openAiModelInfoSaneDefaults,
} from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	parseVsCodeLmModelSelector,
	stringifyVsCodeLmModelSelector,
} from "../../../../../src/shared/vsCodeSelectorUtils"

import { ModelPicker } from "../ModelPicker"
import { ThinkingBudget } from "../ThinkingBudget"

type VSCodeLmModel = LanguageModelChatSelector & {
	name?: string
	maxInputTokens?: number
}

type VSCodeLMProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
}

const REASONING_LEVEL_LABELS: Record<string, string> = {
	none: "None",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "xHigh",
}
const COPILOT_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["none", "low", "medium", "high"]
const COPILOT_EXTRA_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["none", "low", "medium", "high", "xhigh"]
const COPILOT_CODEX_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["low", "medium", "high", "xhigh"]
const COPILOT_REASONING_MODEL_PATTERNS = [/gpt[-\s]?5(?:\.4(?:[-\s]?(?:mini|nano))?|[-\s]?mini)\b/i]
const COPILOT_EXTRA_REASONING_MODEL_PATTERNS = [/gpt[-\s]?5\.5\b/i]
const COPILOT_CODEX_REASONING_MODEL_PATTERNS = [/gpt[-\s]?5\.3[-\s]?codex\b/i]

function titleCaseIdentifier(value: string): string {
	return value
		.replace(/[_-]+/g, " ")
		.replace(/\b(?:gpt|mai|codex|claude|opus|sonnet|haiku|gemini|raptor)\b/gi, (match) =>
			match.toUpperCase() === "GPT" || match.toUpperCase() === "MAI" ? match.toUpperCase() : match,
		)
		.replace(/\b\w/g, (match) => match.toUpperCase())
		.replace(/\bGpt\b/g, "GPT")
		.replace(/\bMai\b/g, "MAI")
}

function inferReasoningLevel(model: VSCodeLmModel): string | undefined {
	const candidates = [model.name, model.version, model.id].filter(Boolean).map((value) => value!.toLowerCase())

	for (const candidate of candidates) {
		for (const level of Object.keys(REASONING_LEVEL_LABELS)) {
			if (new RegExp(`(^|[^a-z])${level}([^a-z]|$)`).test(candidate)) {
				return REASONING_LEVEL_LABELS[level]
			}
		}
	}

	return undefined
}

function formatVsCodeLmModelLabel(model: VSCodeLmModel | undefined, fallbackId: string): string {
	if (!model) {
		return fallbackId
	}

	const baseName = model.name || model.family || model.id || fallbackId
	const cleanedName = titleCaseIdentifier(baseName.replace(/^copilot[-/\s]+/i, ""))
	const reasoningLevel = inferReasoningLevel(model)

	if (!reasoningLevel || cleanedName.toLowerCase().includes(reasoningLevel.toLowerCase())) {
		return cleanedName
	}

	return `${cleanedName} - ${reasoningLevel}`
}

function findStaticVsCodeLmModelInfo(model: VSCodeLmModel): ModelInfo | undefined {
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

function inferVsCodeLmReasoningEffortSupport(model: VSCodeLmModel): ModelInfo["supportsReasoningEffort"] | undefined {
	const searchableText = [model.family, model.id, model.name, model.version].filter(Boolean).join(" ")
	if (COPILOT_EXTRA_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(searchableText))) {
		return COPILOT_EXTRA_REASONING_EFFORTS
	}

	if (COPILOT_CODEX_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(searchableText))) {
		return COPILOT_CODEX_REASONING_EFFORTS
	}

	if (COPILOT_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(searchableText))) {
		return COPILOT_REASONING_EFFORTS
	}

	return undefined
}

function buildVsCodeLmModelInfo(model: VSCodeLmModel): ModelInfo {
	const staticInfo = findStaticVsCodeLmModelInfo(model)
	const supportsReasoningEffort = staticInfo?.supportsReasoningEffort ?? inferVsCodeLmReasoningEffortSupport(model)

	return {
		...openAiModelInfoSaneDefaults,
		...staticInfo,
		maxTokens: staticInfo?.maxTokens ?? 0,
		contextWindow: model.maxInputTokens ?? staticInfo?.contextWindow ?? openAiModelInfoSaneDefaults.contextWindow,
		supportsImages: false,
		supportsPromptCache: staticInfo?.supportsPromptCache ?? false,
		supportsReasoningEffort,
		description: [model.name, model.vendor, model.family, model.version, model.id].filter(Boolean).join(" - "),
	}
}

function selectorMatchesModel(selector: LanguageModelChatSelector, model: VSCodeLmModel): boolean {
	return (
		(!selector.vendor || selector.vendor === model.vendor) &&
		(!selector.family || selector.family === model.family) &&
		(!selector.version || selector.version === model.version) &&
		(!selector.id || selector.id === model.id)
	)
}

function findMatchingModelId(
	selector: LanguageModelChatSelector | undefined,
	models: VSCodeLmModel[],
): string | undefined {
	if (!selector) {
		return undefined
	}

	const exactKey = stringifyVsCodeLmModelSelector(selector)
	const exactMatch = models.find((model) => stringifyVsCodeLmModelSelector(model) === exactKey)
	if (exactMatch) {
		return stringifyVsCodeLmModelSelector(exactMatch)
	}

	const compatibleMatches = models.filter((model) => selectorMatchesModel(selector, model))
	return compatibleMatches.length === 1 ? stringifyVsCodeLmModelSelector(compatibleMatches[0]) : undefined
}

export const VSCodeLM = ({ apiConfiguration, setApiConfigurationField }: VSCodeLMProps) => {
	const { t } = useAppTranslation()

	const [vsCodeLmModels, setVsCodeLmModels] = useState<VSCodeLmModel[]>([])

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		switch (message.type) {
			case "vsCodeLmModels":
				{
					const newModels = message.vsCodeLmModels ?? []
					setVsCodeLmModels(newModels)
				}
				break
		}
	}, [])

	useEvent("message", onMessage)

	// Convert VSCode LM models array to Record format for ModelPicker
	const modelsRecord = useMemo((): Record<string, ModelInfo> => {
		return vsCodeLmModels.reduce(
			(acc, model) => {
				const modelId = stringifyVsCodeLmModelSelector(model)
				acc[modelId] = buildVsCodeLmModelInfo(model)
				return acc
			},
			{} as Record<string, ModelInfo>,
		)
	}, [vsCodeLmModels])

	const modelsById = useMemo(() => {
		return new Map(vsCodeLmModels.map((model) => [stringifyVsCodeLmModelSelector(model), model]))
	}, [vsCodeLmModels])

	// Transform the full picker key back to the exact VS Code LM selector.
	const valueTransform = useCallback(
		(modelId: string) => {
			return modelsById.get(modelId) ?? parseVsCodeLmModelSelector(modelId)
		},
		[modelsById],
	)

	// Transform stored { vendor, family } object back to display string
	const displayTransform = useCallback((value: unknown) => {
		if (!value) return ""
		return stringifyVsCodeLmModelSelector(value as LanguageModelChatSelector)
	}, [])

	const selectedModelId = useMemo(
		() => findMatchingModelId(apiConfiguration.vsCodeLmModelSelector, vsCodeLmModels),
		[apiConfiguration.vsCodeLmModelSelector, vsCodeLmModels],
	)
	const selectedModelInfo = selectedModelId ? modelsRecord[selectedModelId] : undefined

	return (
		<>
			{vsCodeLmModels.length > 0 ? (
				<>
					<ModelPicker
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						defaultModelId=""
						models={modelsRecord}
						modelIdKey="vsCodeLmModelSelector"
						serviceName="VS Code LM"
						serviceUrl="https://code.visualstudio.com/api/extension-guides/language-model"
						valueTransform={valueTransform}
						displayTransform={displayTransform}
						labelTransform={(modelId) => formatVsCodeLmModelLabel(modelsById.get(modelId), modelId)}
						hidePricing
					/>
					<ThinkingBudget
						key={`vscode-lm-${selectedModelId}`}
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						modelInfo={selectedModelInfo}
					/>
				</>
			) : (
				<div>
					<label className="block font-medium mb-1">{t("settings:providers.vscodeLmModel")}</label>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.vscodeLmDescription")}
					</div>
				</div>
			)}
			<div className="text-sm text-vscode-errorForeground">{t("settings:providers.vscodeLmWarning")}</div>
		</>
	)
}
