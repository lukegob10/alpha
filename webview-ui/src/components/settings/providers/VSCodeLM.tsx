import { useState, useCallback, useMemo } from "react"
import { useEvent } from "react-use"
import type { LanguageModelChatSelector } from "vscode"

import {
	type ProviderSettings,
	type ExtensionMessage,
	type ModelInfo,
	openAiModelInfoSaneDefaults,
	getVscodeLlmModelInfo,
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

	const staticInfo = getVscodeLlmModelInfo(model)
	const baseName = staticInfo?.name || model.name || model.family || model.id || fallbackId
	const cleanedName = titleCaseIdentifier(baseName.replace(/^copilot[-/\s]+/i, ""))
	const reasoningLevel = inferReasoningLevel(model)

	if (!reasoningLevel || cleanedName.toLowerCase().includes(reasoningLevel.toLowerCase())) {
		return cleanedName
	}

	return `${cleanedName} · ${reasoningLevel}`
}

function formatVsCodeLmModelDetail(model: VSCodeLmModel | undefined): string | undefined {
	if (!model || getVscodeLlmModelInfo(model)) {
		return undefined
	}

	return [model.vendor, model.family, model.version, model.id].filter(Boolean).join(" / ") || undefined
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
	const staticInfo = getVscodeLlmModelInfo(model)
	const supportsReasoningEffort = staticInfo?.supportsReasoningEffort ?? inferVsCodeLmReasoningEffortSupport(model)

	return {
		...openAiModelInfoSaneDefaults,
		...staticInfo,
		maxTokens: staticInfo?.maxTokens ?? 0,
		contextWindow: model.maxInputTokens ?? staticInfo?.contextWindow ?? openAiModelInfoSaneDefaults.contextWindow,
		supportsImages: staticInfo?.supportsImages ?? false,
		supportsPromptCache: staticInfo?.supportsPromptCache ?? false,
		supportsReasoningEffort,
		description: [model.name, model.vendor, model.family, model.version, model.id].filter(Boolean).join(" - "),
	}
}

function getVsCodeLmModelDedupeKey(model: VSCodeLmModel): string {
	const staticInfo = getVscodeLlmModelInfo(model)
	const canonicalModel = staticInfo?.family ?? model.family ?? model.id ?? model.name ?? ""
	const reasoningLevel = inferReasoningLevel(model)?.toLowerCase() ?? ""

	return [model.vendor ?? "", canonicalModel.toLowerCase(), reasoningLevel].join("/")
}

function dedupeVsCodeLmModels(models: VSCodeLmModel[], selectedSelector: LanguageModelChatSelector | undefined) {
	const selectedKey = selectedSelector ? stringifyVsCodeLmModelSelector(selectedSelector) : undefined
	const dedupedModels: VSCodeLmModel[] = []
	const keyToIndex = new Map<string, number>()

	for (const model of models) {
		const dedupeKey = getVsCodeLmModelDedupeKey(model)
		const modelKey = stringifyVsCodeLmModelSelector(model)
		const existingIndex = keyToIndex.get(dedupeKey)

		if (existingIndex === undefined) {
			keyToIndex.set(dedupeKey, dedupedModels.length)
			dedupedModels.push(model)
			continue
		}

		if (modelKey === selectedKey) {
			dedupedModels[existingIndex] = model
		}
	}

	return dedupedModels
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

	const visibleVsCodeLmModels = useMemo(
		() => dedupeVsCodeLmModels(vsCodeLmModels, apiConfiguration.vsCodeLmModelSelector),
		[apiConfiguration.vsCodeLmModelSelector, vsCodeLmModels],
	)

	// Convert VSCode LM models array to Record format for ModelPicker
	const modelsRecord = useMemo((): Record<string, ModelInfo> => {
		return visibleVsCodeLmModels.reduce(
			(acc, model) => {
				const modelId = stringifyVsCodeLmModelSelector(model)
				acc[modelId] = buildVsCodeLmModelInfo(model)
				return acc
			},
			{} as Record<string, ModelInfo>,
		)
	}, [visibleVsCodeLmModels])

	const modelsById = useMemo(() => {
		return new Map(visibleVsCodeLmModels.map((model) => [stringifyVsCodeLmModelSelector(model), model]))
	}, [visibleVsCodeLmModels])

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
		() => findMatchingModelId(apiConfiguration.vsCodeLmModelSelector, visibleVsCodeLmModels),
		[apiConfiguration.vsCodeLmModelSelector, visibleVsCodeLmModels],
	)
	const selectedModelInfo = selectedModelId ? modelsRecord[selectedModelId] : undefined

	const onModelChange = useCallback(
		(modelId: string) => {
			const supportsReasoningEffort = modelsRecord[modelId]?.supportsReasoningEffort
			const configuredReasoningEffort = apiConfiguration.reasoningEffort

			if (!supportsReasoningEffort) {
				setApiConfigurationField("enableReasoningEffort", false)
				setApiConfigurationField("reasoningEffort", undefined)
				return
			}

			if (
				configuredReasoningEffort &&
				configuredReasoningEffort !== "disable" &&
				Array.isArray(supportsReasoningEffort) &&
				!supportsReasoningEffort.includes(configuredReasoningEffort)
			) {
				setApiConfigurationField("reasoningEffort", undefined)
			}
		},
		[apiConfiguration.reasoningEffort, modelsRecord, setApiConfigurationField],
	)

	return (
		<>
			{visibleVsCodeLmModels.length > 0 ? (
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
						secondaryLabelTransform={(modelId) => formatVsCodeLmModelDetail(modelsById.get(modelId))}
						onModelChange={onModelChange}
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
