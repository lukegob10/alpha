import i18next from "i18next"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type ProviderName,
	type ModelInfo,
	modelIdKeysByProvider,
	isProviderName,
	isFauxProvider,
	isCustomProvider,
	isCuratedProvider,
	curatedProviderApiKeyFields,
	getModelId,
	getProviderDefaultModelId,
	getCuratedModelInfo,
	getUnsupportedCuratedProviderSettings,
	openAiModelInfoSaneDefaults,
	resolveOptionalOutputTokenLimit,
	resolveModelParameterApplicability,
	MIN_OPENAI_RESPONSES_OUTPUT_TOKENS,
	bedrockRegionPattern,
	bedrockDefaultRegion,
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

	return getCuratedModelValidationError(apiConfiguration)
}

function validateModelsAndKeysProvided(apiConfiguration: ProviderSettings): string | undefined {
	if (isCuratedProvider(apiConfiguration.apiProvider)) {
		const unsupportedFields = getUnsupportedCuratedProviderSettings(apiConfiguration.apiProvider, apiConfiguration)
		if (unsupportedFields.length > 0) {
			return i18next.t("settings:validation.unsupportedProviderSettings", {
				fields: unsupportedFields.join(", "),
			})
		}
		if (apiConfiguration.apiProvider === "bedrock") {
			const error = validateBedrockConfiguration(apiConfiguration)
			if (error) return error
		}
		const keyField = curatedProviderApiKeyFields[apiConfiguration.apiProvider]
		const key = keyField ? apiConfiguration[keyField] : undefined
		if (keyField && (typeof key !== "string" || !key.trim())) return i18next.t("settings:validation.apiKey")
		if (apiConfiguration.apiProvider === "openai-codex") return undefined
		const modelId = getModelId(apiConfiguration) ?? getProviderDefaultModelId(apiConfiguration.apiProvider)
		const model = getCuratedModelInfo(apiConfiguration.apiProvider, modelId)
		return model ? getOutputTokenLimitValidationError(apiConfiguration, modelId, model) : undefined
	}
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
		case "openai": {
			if (!apiConfiguration.openAiBaseUrl || !apiConfiguration.openAiApiKey || !apiConfiguration.openAiModelId) {
				return i18next.t("settings:validation.openAi")
			}
			const model = apiConfiguration.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults
			return getOutputTokenLimitValidationError(apiConfiguration, apiConfiguration.openAiModelId, model)
		}
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

function validateBedrockConfiguration(settings: ProviderSettings): string | undefined {
	if (settings.awsUseApiKey && settings.awsUseProfile) return i18next.t("settings:validation.bedrockAuthMethod")
	if (!bedrockRegionPattern.test((settings.awsRegion ?? bedrockDefaultRegion).trim())) {
		return i18next.t("settings:validation.bedrockRegion")
	}
	if (settings.awsUseApiKey) {
		return settings.awsApiKey?.trim() ? undefined : i18next.t("settings:validation.bedrockApiKey")
	}
	if (settings.awsUseProfile) {
		return settings.awsProfile?.trim() ? undefined : i18next.t("settings:validation.bedrockProfile")
	}
	const hasAccessKey = Boolean(settings.awsAccessKey?.trim())
	const hasSecretKey = Boolean(settings.awsSecretKey?.trim())
	if (hasAccessKey !== hasSecretKey || (settings.awsSessionToken?.trim() && !hasAccessKey)) {
		return i18next.t("settings:validation.bedrockCredentials")
	}
	return undefined
}

/** Validate the same captured model and route that the provider uses when dispatching a request. */
export function getOutputTokenLimitValidationError(
	apiConfiguration: ProviderSettings,
	modelId: string,
	model: ModelInfo,
): string | undefined {
	// Sign in with ChatGPT rejects output caps; inherited profile values are inert.
	if (apiConfiguration.apiProvider === "openai-codex") return undefined
	const { route } = resolveModelParameterApplicability({
		provider: apiConfiguration.apiProvider,
		modelId,
		model,
		settings: apiConfiguration,
	})
	try {
		resolveOptionalOutputTokenLimit({
			model,
			settings: apiConfiguration,
			route,
			enforceModelMaximum: isCuratedProvider(apiConfiguration.apiProvider),
		})
	} catch (error) {
		if (!(error instanceof RangeError)) throw error
		const limit = apiConfiguration.modelMaxTokens ?? model.maxTokens
		if (
			(route === "openai-responses" || route === "meta-responses") &&
			typeof limit === "number" &&
			Number.isSafeInteger(limit) &&
			limit > 0 &&
			limit < MIN_OPENAI_RESPONSES_OUTPUT_TOKENS
		) {
			return i18next.t("settings:validation.responsesOutputTokenLimit", {
				minimum: MIN_OPENAI_RESPONSES_OUTPUT_TOKENS,
			})
		}
		if (
			typeof limit === "number" &&
			Number.isSafeInteger(limit) &&
			typeof model.maxTokens === "number" &&
			model.maxTokens > 0 &&
			limit > model.maxTokens
		) {
			return i18next.t("settings:validation.modelOutputTokenLimit", { maximum: model.maxTokens })
		}
		return i18next.t("settings:validation.outputTokenLimit")
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
	if (isCuratedProvider(provider)) {
		return getModelId(apiConfiguration) ?? getProviderDefaultModelId(provider)
	}
	if (provider === "vscode-lm") {
		return getModelId(apiConfiguration)
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

	return getCuratedModelValidationError(apiConfiguration)
}

function getCuratedModelValidationError(apiConfiguration: ProviderSettings): string | undefined {
	const provider = apiConfiguration.apiProvider
	if (!isCuratedProvider(provider)) return undefined
	const modelId = getModelId(apiConfiguration) ?? getProviderDefaultModelId(provider)
	if (!getCuratedModelInfo(provider, modelId)) {
		return i18next.t("settings:validation.modelAvailability", { modelId })
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
