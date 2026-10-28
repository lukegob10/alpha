import { useCallback, useMemo } from "react"
import type { LanguageModelChatSelector } from "vscode"

import {
	type ProviderSettings,
	type ModelInfo,
	openAiModelInfoSaneDefaults,
	getVscodeLlmCatalogModels,
	getVscodeLlmModelId,
	getVscodeLlmExactModelId,
	getVscodeLlmModelInfo,
	getVscodeLlmContextWindow,
	vscodeLlmDefaultModelId,
} from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
import { stringifyVsCodeLmModelSelector } from "../../../../../src/shared/vsCodeSelectorUtils"

import { ModelPicker } from "../ModelPicker"
import { ThinkingBudget } from "../ThinkingBudget"

type VSCodeLMProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
}

function getConfiguredModelId(selector: LanguageModelChatSelector) {
	const modelId = getVscodeLlmExactModelId(selector)
	if (modelId || !selector.id || getVscodeLlmModelId({ vendor: selector.vendor, family: selector.family })) {
		return modelId
	}
	// Historical exact routes can have opaque families and decorated provider IDs.
	// Their ID can supply display metadata without changing the saved execution route.
	return getVscodeLlmModelId({ vendor: selector.vendor, id: selector.id })
}

function buildVsCodeLmModelInfo(model: LanguageModelChatSelector, configuredContextSize?: number): ModelInfo {
	const staticInfo = getVscodeLlmModelInfo(model)

	return {
		...openAiModelInfoSaneDefaults,
		...staticInfo,
		maxTokens: staticInfo?.maxTokens ?? 0,
		contextWindow: getVscodeLlmContextWindow(model, configuredContextSize),
		contextWindowIncludesOutput: false,
		supportsImages: staticInfo?.supportsImages ?? false,
		supportsPromptCache: staticInfo?.supportsPromptCache ?? false,
	}
}

export const VSCodeLM = ({ apiConfiguration, setApiConfigurationField }: VSCodeLMProps) => {
	const { t } = useAppTranslation()
	const modelsById = useMemo(
		() =>
			new Map<string, ReturnType<typeof getVscodeLlmCatalogModels>[number]>(
				getVscodeLlmCatalogModels().flatMap((model) => {
					const modelId = getVscodeLlmModelId(model)
					return modelId ? [[modelId, model] as const] : []
				}),
			),
		[],
	)
	const modelsRecord = useMemo(
		() => Object.fromEntries([...modelsById].map(([id, model]) => [id, buildVsCodeLmModelInfo(model)])),
		[modelsById],
	)
	const configuredSelector = apiConfiguration.vsCodeLmModelSelector
	const selectedModelId = configuredSelector ? getConfiguredModelId(configuredSelector) : vscodeLlmDefaultModelId
	const selectedModel = selectedModelId ? modelsById.get(selectedModelId) : undefined
	const selectedModelInfo = selectedModel
		? buildVsCodeLmModelInfo(selectedModel, apiConfiguration.vsCodeLmContextSize)
		: undefined
	const selectedStaticModelInfo = selectedModel ? getVscodeLlmModelInfo(selectedModel) : undefined
	const extendedContextSize = selectedStaticModelInfo?.supportsContextWindowConfiguration
		? selectedStaticModelInfo.extendedContextSize
		: undefined
	const defaultContextSize = selectedStaticModelInfo?.contextWindow
	const isExtendedContextSelected = apiConfiguration.vsCodeLmContextSize === extendedContextSize
	const selectedContextSizeValue =
		isExtendedContextSelected && extendedContextSize
			? extendedContextSize.toString()
			: (defaultContextSize?.toString() ?? "default")

	// Saved exact host IDs remain untouched until the user selects a catalog model.
	// Displaying their known family does not replace their persisted routing identity.
	const displayTransform = useCallback((value: unknown) => {
		const selector = value as LanguageModelChatSelector
		return getConfiguredModelId(selector) ?? stringifyVsCodeLmModelSelector(selector)
	}, [])
	const valueTransform = useCallback(
		(modelId: string): LanguageModelChatSelector | undefined => {
			const model = modelsById.get(modelId)
			return model ? { vendor: model.vendor, family: model.family } : undefined
		},
		[modelsById],
	)
	const onModelChange = useCallback(
		(modelId: string) => {
			const model = modelsById.get(modelId)
			const modelInfo = model ? getVscodeLlmModelInfo(model) : undefined
			const supportsReasoningEffort = modelInfo?.supportsReasoningEffort
			const configuredReasoningEffort = apiConfiguration.reasoningEffort

			if (!supportsReasoningEffort) {
				setApiConfigurationField("enableReasoningEffort", false)
				setApiConfigurationField("reasoningEffort", undefined)
			} else if (
				configuredReasoningEffort &&
				Array.isArray(supportsReasoningEffort) &&
				!supportsReasoningEffort.includes(configuredReasoningEffort)
			) {
				setApiConfigurationField("reasoningEffort", undefined)
			}

			if (
				apiConfiguration.vsCodeLmContextSize &&
				apiConfiguration.vsCodeLmContextSize !== modelInfo?.contextWindow &&
				apiConfiguration.vsCodeLmContextSize !== modelInfo?.extendedContextSize
			) {
				setApiConfigurationField("vsCodeLmContextSize", undefined)
			}
		},
		[apiConfiguration.reasoningEffort, apiConfiguration.vsCodeLmContextSize, modelsById, setApiConfigurationField],
	)

	return (
		<>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={vscodeLlmDefaultModelId}
				models={modelsRecord}
				modelIdKey="vsCodeLmModelSelector"
				serviceName="VS Code LM"
				serviceUrl="https://code.visualstudio.com/api/extension-guides/language-model"
				valueTransform={valueTransform}
				displayTransform={displayTransform}
				labelTransform={(modelId) => {
					const model = modelsById.get(modelId)
					return (model && getVscodeLlmModelInfo(model)?.name) || modelId
				}}
				onModelChange={onModelChange}
				selectedModelInfoOverride={configuredSelector && !selectedModel ? null : selectedModelInfo}
				errorMessage={
					configuredSelector && !selectedModel ? t("settings:providers.vscodeLmUnavailable") : undefined
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
						onValueChange={(value) => setApiConfigurationField("vsCodeLmContextSize", Number(value))}>
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
				key={"vscode-lm-" + selectedModelId}
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				modelInfo={selectedModelInfo}
				showReasoningEffort={false}
			/>
			<div className="text-sm text-vscode-descriptionForeground">{t("settings:providers.vscodeLmWarning")}</div>
		</>
	)
}
