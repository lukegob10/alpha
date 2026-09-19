import React, { memo, useCallback, useEffect, useMemo, useState } from "react"
import { convertHeadersToObject } from "./utils/headers"
import { useDebounce } from "react-use"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderName,
	type OrganizationAllowList,
	type ProviderSettings,
	isProviderName,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	vertexDefaultModelId,
	stellarDefaultModelId,
} from "@alpha-code/types"

import {
	getProviderServiceConfig,
	getDefaultModelIdForProvider,
	getStaticModelsForProvider,
	shouldUseGenericModelPicker,
	handleModelChangeSideEffects,
} from "./utils/providerModelConfig"

import { vscode } from "@src/utils/vscode"
import { validateApiConfigurationExcludingModelErrors, getModelValidationError } from "@src/utils/validate"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import { filterProviders, filterModels } from "./utils/organizationFilters"
import { SearchableSelect, Collapsible, CollapsibleTrigger, CollapsibleContent } from "@src/components/ui"

import { OpenAICompatible, Stellar, Vertex, VSCodeLM } from "./providers"

import { MODELS_BY_PROVIDER, PROVIDERS } from "./constants"
import { inputEventTransform, noTransform } from "./transforms"
import { ModelPicker } from "./ModelPicker"
import { ApiErrorMessage } from "./ApiErrorMessage"
import { ThinkingBudget } from "./ThinkingBudget"
import { Verbosity } from "./Verbosity"
import { TodoListSettingsControl } from "./TodoListSettingsControl"
import { TemperatureControl } from "./TemperatureControl"
import { RateLimitSecondsControl } from "./RateLimitSecondsControl"
import { ConsecutiveMistakeLimitControl } from "./ConsecutiveMistakeLimitControl"
import { buildDocLink } from "@src/utils/docLinks"
import { BookOpenText } from "lucide-react"

export interface ApiOptionsProps {
	uriScheme: string | undefined
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	fromWelcomeView?: boolean
	errorMessage: string | undefined
	setErrorMessage: React.Dispatch<React.SetStateAction<string | undefined>>
}

const ApiOptions = ({
	apiConfiguration,
	setApiConfigurationField,
	fromWelcomeView,
	errorMessage,
	setErrorMessage,
}: ApiOptionsProps) => {
	const { t } = useAppTranslation()
	const organizationAllowList = useMemo<OrganizationAllowList>(() => ({ allowAll: true, providers: {} }), [])

	const [customHeaders, setCustomHeaders] = useState<[string, string][]>(() => {
		const headers = apiConfiguration?.openAiHeaders || {}
		return Object.entries(headers)
	})

	useEffect(() => {
		const propHeaders = apiConfiguration?.openAiHeaders || {}

		if (JSON.stringify(customHeaders) !== JSON.stringify(Object.entries(propHeaders))) {
			setCustomHeaders(Object.entries(propHeaders))
		}
	}, [apiConfiguration?.openAiHeaders, customHeaders])

	// Helper to convert array of tuples to object (filtering out empty keys).

	// Debounced effect to update the main configuration when local
	// customHeaders state stabilizes.
	useDebounce(
		() => {
			const currentConfigHeaders = apiConfiguration?.openAiHeaders || {}
			const newHeadersObject = convertHeadersToObject(customHeaders)

			// Only update if the processed object is different from the current config.
			if (JSON.stringify(currentConfigHeaders) !== JSON.stringify(newHeadersObject)) {
				setApiConfigurationField("openAiHeaders", newHeadersObject, false)
			}
		},
		300,
		[customHeaders, apiConfiguration?.openAiHeaders, setApiConfigurationField],
	)

	const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false)

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	const {
		provider: selectedProvider,
		id: selectedModelId,
		info: selectedModelInfo,
	} = useSelectedModel(apiConfiguration)
	const activeSelectedProvider: ProviderName | undefined = isProviderName(selectedProvider)
		? selectedProvider
		: undefined
	const isUnsupportedSelectedProvider =
		typeof apiConfiguration.apiProvider === "string" && !isProviderName(apiConfiguration.apiProvider)

	// Update `apiModelId` whenever `selectedModelId` changes.
	useEffect(() => {
		if (isUnsupportedSelectedProvider) {
			return
		}

		if (selectedModelId && apiConfiguration.apiModelId !== selectedModelId) {
			// Pass false as third parameter to indicate this is not a user action
			// This is an internal sync, not a user-initiated change
			setApiConfigurationField("apiModelId", selectedModelId, false)
		}
	}, [selectedModelId, setApiConfigurationField, apiConfiguration.apiModelId, isUnsupportedSelectedProvider])

	// Debounced refresh model updates, only executed 250ms after the user
	// stops typing.
	useDebounce(
		() => {
			if (selectedProvider === "openai") {
				// Use our custom headers state to build the headers object.
				const headerObject = convertHeadersToObject(customHeaders)

				vscode.postMessage({
					type: "requestOpenAiModels",
					values: {
						baseUrl: apiConfiguration?.openAiBaseUrl,
						apiKey: apiConfiguration?.openAiApiKey,
						customHeaders: {}, // Reserved for any additional headers.
						openAiHeaders: headerObject,
					},
				})
			} else if (selectedProvider === "vscode-lm") {
				vscode.postMessage({ type: "requestVsCodeLmModels" })
			}
		},
		250,
		[selectedProvider, apiConfiguration?.openAiBaseUrl, apiConfiguration?.openAiApiKey, customHeaders],
	)

	useEffect(() => {
		if (isUnsupportedSelectedProvider) {
			setErrorMessage(undefined)
			return
		}

		const apiValidationResult = validateApiConfigurationExcludingModelErrors(
			apiConfiguration,
			undefined,
			organizationAllowList,
		)
		setErrorMessage(apiValidationResult)
	}, [apiConfiguration, organizationAllowList, setErrorMessage, isUnsupportedSelectedProvider])

	const onProviderChange = useCallback(
		(value: ProviderName) => {
			setApiConfigurationField("apiProvider", value)

			const validateAndResetModel = (
				provider: ProviderName,
				modelId: string | undefined,
				field: keyof ProviderSettings,
				defaultValue?: string,
			) => {
				// in case we haven't set a default value for a provider
				if (!defaultValue) return

				// 1) If nothing is set, initialize to the provider default.
				if (!modelId) {
					setApiConfigurationField(field, defaultValue, false)
					return
				}

				// 2) If something *is* set, ensure it's valid for the newly selected provider.
				//
				// Without this, switching providers can leave the UI showing a model from the
				// previously selected provider (including model IDs that don't exist for the
				// newly selected provider).
				//
				// Note: We only validate providers with static model lists.
				const staticModels = MODELS_BY_PROVIDER[provider]
				if (!staticModels) {
					return
				}

				const filteredModels = filterModels(staticModels, provider, organizationAllowList)
				const isValidModel = !!filteredModels && Object.prototype.hasOwnProperty.call(filteredModels, modelId)
				if (!isValidModel) {
					setApiConfigurationField(field, defaultValue, false)
				}
			}

			const PROVIDER_MODEL_CONFIG: Partial<
				Record<
					ProviderName,
					{
						field: keyof ProviderSettings
						default?: string
					}
				>
			> = {
				vertex: { field: "apiModelId", default: vertexDefaultModelId },
				stellar: { field: "apiModelId", default: stellarDefaultModelId },
				openai: { field: "openAiModelId" },
			}

			const config = PROVIDER_MODEL_CONFIG[value]
			if (config) {
				validateAndResetModel(
					value,
					apiConfiguration[config.field] as string | undefined,
					config.field,
					config.default,
				)
			}
		},
		[setApiConfigurationField, apiConfiguration, organizationAllowList],
	)

	const modelValidationError = useMemo(() => {
		return getModelValidationError(apiConfiguration, undefined, organizationAllowList)
	}, [apiConfiguration, organizationAllowList])

	const docs = useMemo(() => {
		const provider = PROVIDERS.find(({ value }) => value === selectedProvider)
		const name = provider?.label

		if (!name || selectedProvider === "stellar") {
			return undefined
		}

		// Get the URL slug - use custom mapping if available, otherwise use the provider key.
		const slugs: Record<string, string> = {
			"openai-native": "openai",
			openai: "openai-compatible",
		}

		const slug = slugs[selectedProvider] || selectedProvider
		return {
			url: buildDocLink(`providers/${slug}`, "provider_docs"),
			name,
		}
	}, [selectedProvider])

	// Convert providers to SearchableSelect options
	const providerOptions = useMemo(() => {
		// First filter by organization allow list
		const allowedProviders = filterProviders(PROVIDERS, organizationAllowList)

		// Then filter out static providers that have no models (unless currently selected)
		const providersWithModels = allowedProviders.filter(({ value }) => {
			// Always show the currently selected provider to avoid breaking existing configurations
			// Use apiConfiguration.apiProvider directly since that's what's actually selected
			if (value === apiConfiguration.apiProvider) {
				return true
			}

			// Check if this is a static provider (has models in MODELS_BY_PROVIDER)
			const staticModels = MODELS_BY_PROVIDER[value as ProviderName]

			// If it's a static provider, check if it has any models after filtering
			if (staticModels) {
				const filteredModels = filterModels(staticModels, value as ProviderName, organizationAllowList)
				// Hide the provider if it has no models after filtering
				return filteredModels && Object.keys(filteredModels).length > 0
			}

			// If it's a dynamic provider (not in MODELS_BY_PROVIDER), always show it
			// to avoid race conditions with async model fetching
			return true
		})

		const options = providersWithModels.map(({ value, label }) => ({
			value,
			label,
		}))

		return options
	}, [organizationAllowList, apiConfiguration.apiProvider])

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1 relative">
				<div className="flex justify-between items-center">
					<label className="block font-medium">{t("settings:providers.apiProvider")}</label>
					{docs && (
						<VSCodeLink href={docs.url} target="_blank" className="flex gap-2">
							{t("settings:providers.apiProviderDocs")}
							<BookOpenText className="size-4 inline ml-2" />
						</VSCodeLink>
					)}
				</div>
				<SearchableSelect
					value={selectedProvider}
					onValueChange={(value) => onProviderChange(value as ProviderName)}
					options={providerOptions}
					placeholder={t("settings:common.select")}
					searchPlaceholder={t("settings:providers.searchProviderPlaceholder")}
					emptyMessage={t("settings:providers.noProviderMatchFound")}
					className="w-full"
					data-testid="provider-select"
				/>
			</div>

			{errorMessage && <ApiErrorMessage errorMessage={errorMessage} />}

			{isUnsupportedSelectedProvider ? (
				<div
					className="rounded-md border border-vscode-panel-border px-3 py-2 text-sm text-vscode-descriptionForeground"
					data-testid="retired-provider-message">
					{t("settings:providers.retiredProviderMessage")}
				</div>
			) : (
				<>
					{selectedProvider === "vertex" && (
						<Vertex
							apiConfiguration={apiConfiguration}
							setApiConfigurationField={setApiConfigurationField}
						/>
					)}

					{selectedProvider === "openai" && (
						<OpenAICompatible
							apiConfiguration={apiConfiguration}
							setApiConfigurationField={setApiConfigurationField}
							organizationAllowList={organizationAllowList}
							modelValidationError={modelValidationError}
							simplifySettings={fromWelcomeView}
						/>
					)}

					{selectedProvider === "vscode-lm" && (
						<VSCodeLM
							apiConfiguration={apiConfiguration}
							setApiConfigurationField={setApiConfigurationField}
						/>
					)}

					{selectedProvider === "stellar" && (
						<Stellar
							apiConfiguration={apiConfiguration}
							setApiConfigurationField={setApiConfigurationField}
						/>
					)}

					{/* Generic model picker for providers with static models */}
					{activeSelectedProvider && shouldUseGenericModelPicker(activeSelectedProvider) && (
						<>
							<ModelPicker
								apiConfiguration={apiConfiguration}
								setApiConfigurationField={setApiConfigurationField}
								defaultModelId={getDefaultModelIdForProvider(activeSelectedProvider, apiConfiguration)}
								models={getStaticModelsForProvider(
									activeSelectedProvider,
									t("settings:labels.useCustomArn"),
								)}
								modelIdKey="apiModelId"
								serviceName={getProviderServiceConfig(activeSelectedProvider).serviceName}
								serviceUrl={getProviderServiceConfig(activeSelectedProvider).serviceUrl}
								organizationAllowList={organizationAllowList}
								errorMessage={modelValidationError}
								simplifySettings={fromWelcomeView}
								onModelChange={(modelId) =>
									handleModelChangeSideEffects(
										activeSelectedProvider,
										modelId,
										setApiConfigurationField,
									)
								}
							/>
						</>
					)}

					{!fromWelcomeView && selectedProvider !== "vscode-lm" && (
						<ThinkingBudget
							key={`${selectedProvider}-${selectedModelId}`}
							apiConfiguration={apiConfiguration}
							setApiConfigurationField={setApiConfigurationField}
							modelInfo={selectedModelInfo}
						/>
					)}

					{/* Gate Verbosity UI by capability flag */}
					{!fromWelcomeView && selectedModelInfo?.supportsVerbosity && (
						<Verbosity
							apiConfiguration={apiConfiguration}
							setApiConfigurationField={setApiConfigurationField}
							modelInfo={selectedModelInfo}
						/>
					)}

					{!fromWelcomeView && (
						<Collapsible open={isAdvancedSettingsOpen} onOpenChange={setIsAdvancedSettingsOpen}>
							<CollapsibleTrigger className="flex items-center gap-1 w-full cursor-pointer hover:opacity-80 mb-2">
								<span
									className={`codicon codicon-chevron-${isAdvancedSettingsOpen ? "down" : "right"}`}></span>
								<span className="font-medium">{t("settings:advancedSettings.title")}</span>
							</CollapsibleTrigger>
							<CollapsibleContent className="space-y-3">
								<TodoListSettingsControl
									todoListEnabled={apiConfiguration.todoListEnabled}
									onChange={(field, value) => setApiConfigurationField(field, value)}
								/>
								{selectedModelInfo?.supportsTemperature !== false && (
									<TemperatureControl
										value={apiConfiguration.modelTemperature}
										onChange={handleInputChange("modelTemperature", noTransform)}
										maxValue={2}
										defaultValue={selectedModelInfo?.defaultTemperature}
									/>
								)}
								<RateLimitSecondsControl
									value={apiConfiguration.rateLimitSeconds || 0}
									onChange={(value) => setApiConfigurationField("rateLimitSeconds", value)}
								/>
								<ConsecutiveMistakeLimitControl
									value={
										apiConfiguration.consecutiveMistakeLimit !== undefined
											? apiConfiguration.consecutiveMistakeLimit
											: DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
									}
									onChange={(value) => setApiConfigurationField("consecutiveMistakeLimit", value)}
								/>
							</CollapsibleContent>
						</Collapsible>
					)}
				</>
			)}
		</div>
	)
}

export default memo(ApiOptions)
