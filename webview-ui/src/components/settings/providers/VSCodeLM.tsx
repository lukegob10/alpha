import { useState, useCallback, useMemo } from "react"
import { useEvent } from "react-use"
import type { LanguageModelChatSelector } from "vscode"

import {
	type ProviderSettings,
	type ExtensionMessage,
	type ModelInfo,
	openAiModelInfoSaneDefaults,
	getVscodeLlmModelId,
	getVscodeLlmModelInfo,
	getVscodeLlmExtendedContextSize,
} from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"
import { stringifyVsCodeLmModelSelector } from "../../../../../src/shared/vsCodeSelectorUtils"

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
	max: "Max",
}

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
	const providerName = staticInfo?.name || model.name
	const baseName = providerName || model.family || model.id || fallbackId
	const nameWithoutVendor = baseName.replace(/^copilot[-/\s]+/i, "")
	const cleanedName = providerName ? nameWithoutVendor : titleCaseIdentifier(nameWithoutVendor)
	const reasoningLevel = inferReasoningLevel(model)

	if (!reasoningLevel || cleanedName.toLowerCase().includes(reasoningLevel.toLowerCase())) {
		return cleanedName
	}

	return `${cleanedName} · ${reasoningLevel}`
}

function formatVsCodeLmModelDetail(model: VSCodeLmModel | undefined): string | undefined {
	if (!model) {
		return undefined
	}

	return [model.vendor, model.family, model.version, model.id].filter(Boolean).join(" / ") || undefined
}

function getVsCodeLmPickerKey(model: LanguageModelChatSelector): string {
	return model.id ? [model.vendor, model.id].filter(Boolean).join("/") : stringifyVsCodeLmModelSelector(model)
}

function toStoredVsCodeLmSelector(model: VSCodeLmModel): LanguageModelChatSelector {
	return {
		vendor: model.vendor,
		family: model.family,
		version: model.version,
		id: model.id,
	}
}

function buildVsCodeLmModelInfo(model: VSCodeLmModel, configuredContextSize?: number): ModelInfo {
	const staticInfo = getVscodeLlmModelInfo(model)
	const extendedContextSize = getVscodeLlmExtendedContextSize(model)
	const isExtendedContextSelected = configuredContextSize === extendedContextSize
	const liveContextWindow =
		typeof model.maxInputTokens === "number" && Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0
			? model.maxInputTokens
			: undefined
	const configuredWindow =
		staticInfo?.supportsContextWindowConfiguration && isExtendedContextSelected && extendedContextSize
			? extendedContextSize
			: staticInfo?.contextWindow
	const contextWindow = liveContextWindow
		? Math.min(liveContextWindow, configuredWindow ?? liveContextWindow)
		: (configuredWindow ?? openAiModelInfoSaneDefaults.contextWindow)

	return {
		...openAiModelInfoSaneDefaults,
		...staticInfo,
		maxTokens: staticInfo?.maxTokens ?? 0,
		contextWindow,
		supportsImages: staticInfo?.supportsImages ?? false,
		supportsPromptCache: staticInfo?.supportsPromptCache ?? false,
		supportsReasoningEffort: staticInfo?.supportsReasoningEffort,
		// The live VS Code list is authoritative even when static retirement metadata is stale.
		deprecated: false,
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
		return getVsCodeLmPickerKey(exactMatch)
	}

	const compatibleMatches = models.filter((model) => selectorMatchesModel(selector, model))
	if (compatibleMatches.length === 1) {
		return getVsCodeLmPickerKey(compatibleMatches[0])
	}

	// Legacy selectors sometimes contain a documented family but no live opaque ID.
	// Resolve those only when the canonical capability mapping is unambiguous.
	const canonicalModelId = getVscodeLlmModelId(selector)
	if (!canonicalModelId) {
		return undefined
	}
	const canonicalMatches = models.filter((model) => getVscodeLlmModelId(model) === canonicalModelId)
	return canonicalMatches.length === 1 ? getVsCodeLmPickerKey(canonicalMatches[0]) : undefined
}

export const VSCodeLM = ({ apiConfiguration, setApiConfigurationField }: VSCodeLMProps) => {
	const { t } = useAppTranslation()

	const [vsCodeLmModels, setVsCodeLmModels] = useState<VSCodeLmModel[]>([])
	const [hasLoadedModels, setHasLoadedModels] = useState(false)

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		switch (message.type) {
			case "vsCodeLmModels":
				{
					const newModels = message.vsCodeLmModels ?? []
					setVsCodeLmModels(newModels)
					setHasLoadedModels(true)
				}
				break
		}
	}, [])

	useEvent("message", onMessage)

	// Convert VSCode LM models array to Record format for ModelPicker
	const modelsRecord = useMemo((): Record<string, ModelInfo> => {
		return vsCodeLmModels.reduce(
			(acc, model) => {
				const modelId = getVsCodeLmPickerKey(model)
				acc[modelId] = buildVsCodeLmModelInfo(model)
				return acc
			},
			{} as Record<string, ModelInfo>,
		)
	}, [vsCodeLmModels])

	const modelsById = useMemo(() => {
		return new Map(vsCodeLmModels.map((model) => [getVsCodeLmPickerKey(model), model]))
	}, [vsCodeLmModels])

	// Transform the deduplicated picker key back to the exact selector returned
	// by VS Code. The picker never manufactures broad fallback selectors.
	const valueTransform = useCallback(
		(modelId: string) => {
			const model = modelsById.get(modelId)
			return model ? toStoredVsCodeLmSelector(model) : undefined
		},
		[modelsById],
	)

	// Transform a stored exact selector (or an unambiguous legacy selector) to
	// the corresponding live picker identity.
	const displayTransform = useCallback(
		(value: unknown) => {
			if (!value) return ""
			const selector = value as LanguageModelChatSelector
			return findMatchingModelId(selector, vsCodeLmModels) ?? getVsCodeLmPickerKey(selector)
		},
		[vsCodeLmModels],
	)

	const selectedModelId = useMemo(
		() => findMatchingModelId(apiConfiguration.vsCodeLmModelSelector, vsCodeLmModels),
		[apiConfiguration.vsCodeLmModelSelector, vsCodeLmModels],
	)
	const selectedModel = selectedModelId ? modelsById.get(selectedModelId) : undefined
	const selectedModelInfo = selectedModel
		? buildVsCodeLmModelInfo(selectedModel, apiConfiguration.vsCodeLmContextSize)
		: undefined
	const extendedContextSize = selectedModel ? getVscodeLlmExtendedContextSize(selectedModel) : undefined
	const selectedStaticModelInfo = selectedModel ? getVscodeLlmModelInfo(selectedModel) : undefined
	const defaultContextSize = selectedStaticModelInfo?.contextWindow
	const isExtendedContextSelected = apiConfiguration.vsCodeLmContextSize === extendedContextSize
	const selectedContextSizeValue =
		isExtendedContextSelected && extendedContextSize
			? extendedContextSize.toString()
			: (defaultContextSize?.toString() ?? "default")

	const onModelChange = useCallback(
		(modelId: string) => {
			const supportsReasoningEffort = modelsRecord[modelId]?.supportsReasoningEffort
			const configuredReasoningEffort = apiConfiguration.reasoningEffort
			const nextModel = modelsById.get(modelId)
			const nextStaticModelInfo = nextModel ? getVscodeLlmModelInfo(nextModel) : undefined
			const nextDefaultContextSize = nextStaticModelInfo?.contextWindow
			const nextExtendedContextSize = nextModel ? getVscodeLlmExtendedContextSize(nextModel) : undefined

			if (!supportsReasoningEffort) {
				setApiConfigurationField("enableReasoningEffort", false)
				setApiConfigurationField("reasoningEffort", undefined)
			} else if (
				configuredReasoningEffort &&
				configuredReasoningEffort !== "disable" &&
				Array.isArray(supportsReasoningEffort) &&
				!supportsReasoningEffort.includes(configuredReasoningEffort)
			) {
				setApiConfigurationField("reasoningEffort", undefined)
			}

			if (
				apiConfiguration.vsCodeLmContextSize &&
				apiConfiguration.vsCodeLmContextSize !== nextDefaultContextSize &&
				apiConfiguration.vsCodeLmContextSize !== nextExtendedContextSize
			) {
				setApiConfigurationField("vsCodeLmContextSize", undefined)
			}
		},
		[
			apiConfiguration.reasoningEffort,
			apiConfiguration.vsCodeLmContextSize,
			modelsById,
			modelsRecord,
			setApiConfigurationField,
		],
	)
	const preferredDefaultModel = vsCodeLmModels.find((model) => getVscodeLlmModelId(model) === "gpt-5.5")
	const defaultModelId = preferredDefaultModel
		? getVsCodeLmPickerKey(preferredDefaultModel)
		: (Array.from(modelsById.keys()).sort((left, right) => left.localeCompare(right))[0] ?? "")
	const selectedModelUnavailable =
		Boolean(apiConfiguration.vsCodeLmModelSelector) && vsCodeLmModels.length > 0 && !selectedModel
	const refreshModels = useCallback(() => {
		setHasLoadedModels(false)
		vscode.postMessage({ type: "requestVsCodeLmModels" })
	}, [])

	return (
		<>
			{vsCodeLmModels.length > 0 ? (
				<>
					<ModelPicker
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						defaultModelId={defaultModelId}
						models={modelsRecord}
						modelIdKey="vsCodeLmModelSelector"
						serviceName="VS Code LM"
						serviceUrl="https://code.visualstudio.com/api/extension-guides/language-model"
						valueTransform={valueTransform}
						displayTransform={displayTransform}
						labelTransform={(modelId) => formatVsCodeLmModelLabel(modelsById.get(modelId), modelId)}
						secondaryLabelTransform={(modelId) => formatVsCodeLmModelDetail(modelsById.get(modelId))}
						onModelChange={onModelChange}
						selectedModelInfoOverride={selectedModelInfo}
						errorMessage={
							selectedModelUnavailable ? t("settings:providers.vscodeLmUnavailable") : undefined
						}
						allowCustomModel={false}
						hidePricing
					/>
					{extendedContextSize && (
						<div>
							<label className="block font-medium mb-1">
								{t("settings:providers.vscodeLmContextSize.label")}
							</label>
							<Select
								value={selectedContextSizeValue}
								onValueChange={(value) =>
									setApiConfigurationField("vsCodeLmContextSize", Number(value))
								}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{defaultContextSize && (
										<SelectItem value={defaultContextSize.toString()}>
											{t("settings:providers.vscodeLmContextSize.default", {
												contextSize: defaultContextSize.toLocaleString(),
											})}
										</SelectItem>
									)}
									<SelectItem value={extendedContextSize.toString()}>
										{t("settings:providers.vscodeLmContextSize.extended", {
											contextSize: extendedContextSize.toLocaleString(),
										})}
									</SelectItem>
								</SelectContent>
							</Select>
							<div className="text-sm text-vscode-descriptionForeground mt-1">
								{t("settings:providers.vscodeLmContextSize.description")}
							</div>
						</div>
					)}
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
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t(
							hasLoadedModels
								? "settings:providers.vscodeLmNoModels"
								: "settings:providers.vscodeLmLoading",
						)}
					</div>
					<Button
						type="button"
						variant="secondary"
						onClick={refreshModels}
						data-testid="refresh-vscode-lm-models">
						{t("settings:providers.vscodeLmRefresh")}
					</Button>
				</div>
			)}
			<div className="text-sm text-vscode-errorForeground">{t("settings:providers.vscodeLmWarning")}</div>
		</>
	)
}
