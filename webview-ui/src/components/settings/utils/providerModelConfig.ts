import type { ProviderName, ModelInfo, ProviderSettings } from "@alpha-code/types"
import { vertexDefaultModelId, stellarDefaultModelId } from "@alpha-code/types"

import { MODELS_BY_PROVIDER } from "../constants"

export interface ProviderServiceConfig {
	serviceName: string
	serviceUrl: string
}

export const PROVIDER_SERVICE_CONFIG: Partial<Record<ProviderName, ProviderServiceConfig>> = {
	vertex: { serviceName: "GCP Vertex AI", serviceUrl: "https://console.cloud.google.com/vertex-ai" },
	stellar: { serviceName: "Stellar", serviceUrl: "" },
	openai: { serviceName: "OpenAI Compatible", serviceUrl: "https://platform.openai.com/docs" },
	"vscode-lm": {
		serviceName: "VS Code LM",
		serviceUrl: "https://code.visualstudio.com/api/extension-guides/language-model",
	},
}

export const PROVIDER_DEFAULT_MODEL_IDS: Partial<Record<ProviderName, string>> = {
	vertex: vertexDefaultModelId,
	stellar: stellarDefaultModelId,
}

export const getProviderServiceConfig = (provider: ProviderName): ProviderServiceConfig => {
	return PROVIDER_SERVICE_CONFIG[provider] ?? { serviceName: provider, serviceUrl: "" }
}

export const getDefaultModelIdForProvider = (provider: ProviderName, _apiConfiguration?: ProviderSettings): string => {
	return PROVIDER_DEFAULT_MODEL_IDS[provider] ?? ""
}

export const getStaticModelsForProvider = (
	provider: ProviderName,
	_customArnLabel?: string,
): Record<string, ModelInfo> => {
	const models = MODELS_BY_PROVIDER[provider] ?? {}

	return models
}

/**
 * Checks if a provider uses static models from MODELS_BY_PROVIDER
 */
export const isStaticModelProvider = (provider: ProviderName): boolean => {
	return provider in MODELS_BY_PROVIDER
}

/**
 * List of providers that have their own custom model selection UI
 * and should not use the generic ModelPicker in ApiOptions
 */
export const PROVIDERS_WITH_CUSTOM_MODEL_UI: ProviderName[] = [
	"openai", // OpenAI Compatible
	"vscode-lm",
]

/**
 * Checks if a provider should use the generic ModelPicker
 */
export const shouldUseGenericModelPicker = (provider: ProviderName): boolean => {
	return isStaticModelProvider(provider) && !PROVIDERS_WITH_CUSTOM_MODEL_UI.includes(provider)
}

/**
 * Handles provider-specific side effects when a model is changed.
 * Centralizes provider-specific logic to keep it out of the ApiOptions template.
 */
export const handleModelChangeSideEffects = <K extends keyof ProviderSettings>(
	_provider: ProviderName,
	_modelId: string,
	setApiConfigurationField: (field: K, value: ProviderSettings[K]) => void,
): void => {
	// All providers: Clear reasoning settings when switching models to allow
	// the new model's defaults to take effect. Different models within the
	// same provider can have different reasoning defaults/options.
	setApiConfigurationField("reasoningEffort" as K, undefined as ProviderSettings[K])
	setApiConfigurationField("modelMaxTokens" as K, undefined as ProviderSettings[K])
	setApiConfigurationField("modelMaxThinkingTokens" as K, undefined as ProviderSettings[K])
}
