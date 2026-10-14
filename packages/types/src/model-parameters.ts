import type { ModelInfo } from "./model.js"
import type { ProviderSettings } from "./provider-settings.js"
import { getNativeOpenAiModelCapabilities } from "./providers/openai.js"
import { resolveVertexGatewayRoute } from "./providers/vertex.js"

type OpenAiRouteSettings = Pick<ProviderSettings, "openAiBaseUrl" | "openAiUseAzure" | "openAiR1FormatEnabled">

export const MIN_OPENAI_RESPONSES_OUTPUT_TOKENS = 16

/** The adapter route is independent of tools, mode, and approval authority. */
export function usesOpenAiResponsesApi(modelId: string, settings: OpenAiRouteSettings = {}): boolean {
	const usesR1Format = modelId.includes("deepseek-reasoner") || settings.openAiR1FormatEnabled === true
	return (
		!usesR1Format &&
		getNativeOpenAiModelCapabilities(modelId, settings.openAiBaseUrl, settings.openAiUseAzure)?.responses === true
	)
}

/** Preserve the existing Chat Completions reasoning-family request contract. */
export function usesOpenAiReasoningFamilyChat(modelId: string): boolean {
	return modelId.includes("o1") || modelId.includes("o3") || modelId.includes("o4")
}

export type ModelParameterRoute =
	| "openai-responses"
	| "openai-chat-completions"
	| "vertex-anthropic"
	| "vertex-gemini"
	| "vscode-lm"
	| "unsupported"

export interface ModelParameterApplicability {
	route: ModelParameterRoute
	supportsTemperature: boolean
	/** A model-required value rather than an editable sampling preference. */
	fixedTemperature?: number
	supportsVerbosity: boolean
}

/** Capability precedence shared by the custom-model editor and request resolver. */
export function supportsModelTemperature(model?: ModelInfo, allowCompatibleDefault = false): boolean {
	if (!model || model.supportsTemperature === false) return false
	if (model.supportsTemperature === true) return true
	if (model.supportedParameters !== undefined) return model.supportedParameters.includes("temperature")
	return allowCompatibleDefault
}

/** Project only controls consumed by the selected adapter and supported model. */
export function resolveModelParameterApplicability({
	provider,
	modelId,
	model,
	settings = {},
	requestKind = "task",
}: {
	provider?: string
	modelId: string
	model?: ModelInfo
	settings?: ProviderSettings
	/** Auxiliary text completions retain their established Chat Completions route. */
	requestKind?: "task" | "single-completion"
}): ModelParameterApplicability {
	const selectedProvider = provider ?? settings.apiProvider ?? "vertex"
	let route: ModelParameterRoute = "unsupported"
	let requestModelId = modelId
	let hasNativeOpenAiRoute = false
	if (selectedProvider === "openai") {
		hasNativeOpenAiRoute = usesOpenAiResponsesApi(modelId, settings)
		route = hasNativeOpenAiRoute && requestKind === "task" ? "openai-responses" : "openai-chat-completions"
	} else if (selectedProvider === "stellar") {
		hasNativeOpenAiRoute = Boolean(
			settings.stellarBaseUrl &&
				usesOpenAiResponsesApi(modelId, { ...settings, openAiBaseUrl: settings.stellarBaseUrl }),
		)
		route = hasNativeOpenAiRoute && requestKind === "task" ? "openai-responses" : "openai-chat-completions"
	} else if (selectedProvider === "vertex") {
		const family = modelId.trim().toLowerCase()
		route = family.includes("claude")
			? "vertex-anthropic"
			: family.startsWith("gemini")
				? "vertex-gemini"
				: "openai-chat-completions"
		if (route === "openai-chat-completions") {
			try {
				requestModelId = resolveVertexGatewayRoute(settings, modelId.trim()).modelOverride ?? modelId.trim()
			} catch {
				// The request validator reports malformed maps. An incomplete settings
				// edit must not advertise controls for a route that cannot be sent.
				route = "unsupported"
			}
		}
	} else if (selectedProvider === "vscode-lm") {
		route = "vscode-lm"
	}

	// Preserve the legacy compatible adapter's sampling contract for saved model
	// descriptors that predate capability flags. Explicit opt-outs and declared
	// parameter lists remain authoritative; other routes need advertised support.
	const consumesTemperature =
		route === "vertex-anthropic" ||
		route === "vertex-gemini" ||
		(route === "openai-chat-completions" && !hasNativeOpenAiRoute && !usesOpenAiReasoningFamilyChat(requestModelId))
	const hasTemperatureCapability = supportsModelTemperature(
		model,
		route === "openai-chat-completions" && !hasNativeOpenAiRoute,
	)
	const hasActiveReasoningBudget =
		model?.requiredReasoningBudget === true ||
		(model?.supportsReasoningBudget === true && settings.enableReasoningEffort === true)
	const requiresFixedTemperature =
		consumesTemperature && hasTemperatureCapability && hasActiveReasoningBudget && route !== "vertex-gemini"
	return {
		route,
		supportsTemperature: consumesTemperature && hasTemperatureCapability && !requiresFixedTemperature,
		...(requiresFixedTemperature ? { fixedTemperature: 1 } : {}),
		// Native text-only Chat Completions consumes top-level verbosity; task
		// Responses consumes text.verbosity. Gate both by the same model metadata.
		supportsVerbosity: hasNativeOpenAiRoute && model?.supportsVerbosity === true,
	}
}

/** Unset saved profiles retain their historical server-selected output limit. */
export function isMaxOutputTokensIncluded(settings: Pick<ProviderSettings, "includeMaxTokens"> = {}): boolean {
	return settings.includeMaxTokens === true
}

/** -1 is the legacy server-default sentinel; other explicit caps must be integers. */
export function validateOptionalOutputTokenLimit(value: number | null | undefined): number | undefined {
	if (value === undefined || value === null || value === -1) return undefined
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError("Output token limit must be a positive safe integer or -1 for the server default.")
	}
	return value
}

/** Resolve the per-response request cap separately from context or task budgets. */
export function resolveOptionalOutputTokenLimit({
	model,
	settings = {},
	route,
}: {
	model: ModelInfo
	settings?: Pick<ProviderSettings, "includeMaxTokens" | "modelMaxTokens">
	route?: ModelParameterRoute
}): number | undefined {
	if (!isMaxOutputTokensIncluded(settings)) return undefined
	const limit = validateOptionalOutputTokenLimit(settings.modelMaxTokens ?? model.maxTokens)
	if (limit !== undefined && route === "openai-responses" && limit < MIN_OPENAI_RESPONSES_OUTPUT_TOKENS) {
		throw new RangeError(
			`Native Responses output token limit must be at least ${MIN_OPENAI_RESPONSES_OUTPUT_TOKENS} or -1 for the server default.`,
		)
	}
	return limit
}
