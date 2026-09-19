import i18next from "i18next"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type ProviderName,
	modelIdKeysByProvider,
	isProviderName,
	isFauxProvider,
	isCustomProvider,
} from "@alpha-code/types"

const VERTEX_GATEWAY_REQUIRED_FIELDS = ["gatewayBaseUrl", "pemCaBundlePath", "helixCommand"] as const
const VERTEX_GATEWAY_TRIGGER_FIELDS = [...VERTEX_GATEWAY_REQUIRED_FIELDS] as const

export function validateApiConfiguration(
	apiConfiguration: ProviderSettings,
	_routerModels?: unknown,
	organizationAllowList?: OrganizationAllowList,
): string | undefined {
	const keysAndIdsPresentErrorMessage = validateModelsAndKeysProvided(apiConfiguration)

	if (keysAndIdsPresentErrorMessage) {
		return keysAndIdsPresentErrorMessage
	}

	const organizationAllowListError = validateProviderAgainstOrganizationSettings(
		apiConfiguration,
		organizationAllowList,
	)

	if (organizationAllowListError) {
		return organizationAllowListError.message
	}

	return undefined
}

function validateModelsAndKeysProvided(apiConfiguration: ProviderSettings): string | undefined {
	switch (apiConfiguration.apiProvider) {
		case "vertex":
			if (!hasVertexProjectAndLocation(apiConfiguration)) {
				return i18next.t("settings:validation.googleCloud")
			}
			if (hasVertexGatewayConfiguration(apiConfiguration) && !hasRequiredVertexGatewayFields(apiConfiguration)) {
				return i18next.t("settings:validation.vertexGateway")
			}
			if (
				!isValidVertexGatewayModelRoutingMap(
					apiConfiguration.modelRoutingMap ?? apiConfiguration.vertexGatewayModelRoutingMap,
				)
			) {
				return i18next.t("settings:validation.vertexGatewayModelRoutingMap")
			}
			break
		case "stellar":
			if (!hasValidStellarConfiguration(apiConfiguration)) {
				return i18next.t("settings:validation.stellar")
			}
			break
		case "openai":
			if (!apiConfiguration.openAiBaseUrl || !apiConfiguration.openAiApiKey || !apiConfiguration.openAiModelId) {
				return i18next.t("settings:validation.openAi")
			}
			break
		case "vscode-lm":
			if (!apiConfiguration.vsCodeLmModelSelector) {
				return i18next.t("settings:validation.modelSelector")
			}
			break
		case "fake-ai":
			break
		default:
			if (apiConfiguration.apiProvider) {
				return i18next.t("settings:providers.retiredProviderMessage")
			}
	}

	return undefined
}

type ValidationError = {
	message: string
	code: "PROVIDER_NOT_ALLOWED" | "MODEL_NOT_ALLOWED"
}

function validateProviderAgainstOrganizationSettings(
	apiConfiguration: ProviderSettings,
	organizationAllowList?: OrganizationAllowList,
): ValidationError | undefined {
	if (organizationAllowList && !organizationAllowList.allowAll) {
		const provider = apiConfiguration.apiProvider

		if (!provider) {
			return undefined
		}

		const providerConfig = organizationAllowList.providers?.[provider]

		if (!providerConfig) {
			return {
				message: i18next.t("settings:validation.providerNotAllowed", { provider }),
				code: "PROVIDER_NOT_ALLOWED",
			}
		}

		if (!providerConfig.allowAll) {
			const activeProvider = isProviderName(provider) ? provider : undefined
			const modelId = activeProvider ? getModelIdForProvider(apiConfiguration, activeProvider) : undefined
			const allowedModels = providerConfig.models || []

			if (modelId && !allowedModels.includes(modelId)) {
				return {
					message: i18next.t("settings:validation.modelNotAllowed", {
						model: modelId,
						provider,
					}),
					code: "MODEL_NOT_ALLOWED",
				}
			}
		}
	}
}

function hasConfiguredValue(value: unknown): boolean {
	return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null
}

function hasValidStellarConfiguration(apiConfiguration: ProviderSettings): boolean {
	if (
		!hasConfiguredValue(apiConfiguration.stellarBaseUrl) ||
		!hasConfiguredValue(apiConfiguration.stellarPemCaBundlePath)
	) {
		return false
	}

	try {
		return URL.canParse(apiConfiguration.stellarBaseUrl!.trim())
	} catch {
		return false
	}
}

function hasVertexProjectAndLocation(apiConfiguration: ProviderSettings): boolean {
	return (
		(hasConfiguredValue(apiConfiguration.projectId) || hasConfiguredValue(apiConfiguration.vertexProjectId)) &&
		(hasConfiguredValue(apiConfiguration.location) || hasConfiguredValue(apiConfiguration.vertexRegion))
	)
}

function hasVertexGatewayConfiguration(apiConfiguration: ProviderSettings): boolean {
	const hasCanonicalConfig = VERTEX_GATEWAY_TRIGGER_FIELDS.some((field) =>
		hasConfiguredValue(apiConfiguration[field]),
	)
	const hasLegacyConfig =
		hasConfiguredValue(apiConfiguration.vertexGatewayBaseUrl) ||
		hasConfiguredValue(apiConfiguration.vertexGatewayCaBundlePath) ||
		hasConfiguredValue(apiConfiguration.vertexGatewayHelixCommand)

	return hasCanonicalConfig || hasLegacyConfig
}

function hasRequiredVertexGatewayFields(apiConfiguration: ProviderSettings): boolean {
	const hasGatewayBaseUrl =
		hasConfiguredValue(apiConfiguration.gatewayBaseUrl) || hasConfiguredValue(apiConfiguration.vertexGatewayBaseUrl)
	const hasPemCaBundlePath =
		hasConfiguredValue(apiConfiguration.pemCaBundlePath) ||
		hasConfiguredValue(apiConfiguration.vertexGatewayCaBundlePath)
	const hasHelixCommand =
		hasConfiguredValue(apiConfiguration.helixCommand) ||
		hasConfiguredValue(apiConfiguration.vertexGatewayHelixCommand)

	return hasGatewayBaseUrl && hasPemCaBundlePath && hasHelixCommand
}

function isValidVertexGatewayModelRoutingMap(value: ProviderSettings["modelRoutingMap"] | string | undefined): boolean {
	if (typeof value !== "string") {
		return value === undefined || (typeof value === "object" && value !== null && !Array.isArray(value))
	}

	if (!value.trim()) {
		return true
	}

	try {
		const parsed = JSON.parse(value)

		return (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			Object.entries(parsed).every(([key, route]) => {
				if (key.trim().length === 0) {
					return false
				}
				if (typeof route === "string") {
					return route.trim().length > 0
				}
				return route !== null && typeof route === "object" && !Array.isArray(route)
			})
		)
	} catch {
		return false
	}
}

function getModelIdForProvider(apiConfiguration: ProviderSettings, provider: ProviderName): string | undefined {
	if (provider === "vscode-lm") {
		return apiConfiguration.vsCodeLmModelSelector?.id
	}

	if (isCustomProvider(provider)) {
		return apiConfiguration.openAiModelId
	}

	if (isFauxProvider(provider)) {
		return apiConfiguration.apiModelId
	}

	return apiConfiguration[modelIdKeysByProvider[provider]]
}

/**
 * Extracts model-specific validation errors from the API configuration.
 * This is used to show model errors specifically in the model selector components.
 */
export function getModelValidationError(
	apiConfiguration: ProviderSettings,
	_routerModels?: unknown,
	organizationAllowList?: OrganizationAllowList,
): string | undefined {
	const modelId = isProviderName(apiConfiguration.apiProvider)
		? getModelIdForProvider(apiConfiguration, apiConfiguration.apiProvider)
		: apiConfiguration.apiModelId

	const configWithModelId = {
		...apiConfiguration,
		apiModelId: modelId || "",
	}

	const orgError = validateProviderAgainstOrganizationSettings(configWithModelId, organizationAllowList)

	if (orgError && orgError.code === "MODEL_NOT_ALLOWED") {
		return orgError.message
	}

	return undefined
}

/**
 * Validates API configuration but excludes model-specific errors.
 * This is used for the general API error display to prevent duplication
 * when model errors are shown in the model selector.
 */
export function validateApiConfigurationExcludingModelErrors(
	apiConfiguration: ProviderSettings,
	_routerModels?: unknown, // Kept for compatibility with callers that still pass a model catalog.
	organizationAllowList?: OrganizationAllowList,
): string | undefined {
	const keysAndIdsPresentErrorMessage = validateModelsAndKeysProvided(apiConfiguration)

	if (keysAndIdsPresentErrorMessage) {
		return keysAndIdsPresentErrorMessage
	}

	const organizationAllowListError = validateProviderAgainstOrganizationSettings(
		apiConfiguration,
		organizationAllowList,
	)

	// Only return organization errors if they're not model-specific.
	if (organizationAllowListError && organizationAllowListError.code === "PROVIDER_NOT_ALLOWED") {
		return organizationAllowListError.message
	}

	// Skip model validation errors as they'll be shown in the model selector.
	return undefined
}
