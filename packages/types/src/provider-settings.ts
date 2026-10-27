import { z } from "zod"

import {
	modelInfoSchema,
	reasoningEffortSettingSchema,
	serviceTierSchema,
	verbosityLevelsSchema,
	type ModelInfo,
} from "./model.js"
import { codebaseIndexProviderSchema } from "./codebase-index.js"
import {
	stellarModels,
	vertexModels,
	vscodeLlmModels,
	openAiNativeModels,
	anthropicModels,
	geminiModels,
	xaiModels,
	openRouterModels,
} from "./providers/index.js"

/**
 * Shared provider settings and the public provider registry.
 *
 * The executable provider surface is intentionally small. `fake-ai` remains a
 * process-local harness provider, while retired names are accepted only by
 * compatibility readers so old profiles can be surfaced and rejected instead
 * of being routed to an unrelated adapter.
 */

export const DEFAULT_CONSECUTIVE_MISTAKE_LIMIT = 3

/** VS Code LM is an internal host API, but remains a supported public choice. */
export const internalProviders = ["vscode-lm"] as const
export type InternalProvider = (typeof internalProviders)[number]
export const isInternalProvider = (key: string): key is InternalProvider =>
	internalProviders.includes(key as InternalProvider)

/** OpenAI-compatible is the configurable endpoint provider. */
export const customProviders = ["openai"] as const
export type CustomProvider = (typeof customProviders)[number]
export const isCustomProvider = (key: string): key is CustomProvider => customProviders.includes(key as CustomProvider)

/**
 * `fake-ai` is available only to in-process tests and the deterministic local
 * harness. It is deliberately excluded from the public provider registry.
 */
export const fauxProviders = ["fake-ai"] as const
export type FauxProvider = (typeof fauxProviders)[number]
export const isFauxProvider = (key: string): key is FauxProvider => fauxProviders.includes(key as FauxProvider)

/** Curated native and router paths share explicit model capabilities. */
export const curatedProviders = ["openai-native", "anthropic", "gemini", "xai", "openrouter"] as const
export type CuratedProvider = (typeof curatedProviders)[number]
export const isCuratedProvider = (value: unknown): value is CuratedProvider =>
	typeof value === "string" && curatedProviders.includes(value as CuratedProvider)

/** Public provider IDs. Keep this list in sync with the executable factory. */
export const providerNames = ["vertex", "vscode-lm", "stellar", "openai", ...curatedProviders] as const
export const providerNamesSchema = z.enum(providerNames)
export type ProviderName = z.infer<typeof providerNamesSchema>
export const isProviderName = (key: unknown): key is ProviderName =>
	typeof key === "string" && providerNames.includes(key as ProviderName)

export type OrganizationAllowList = {
	allowAll?: boolean
	providers?: Record<string, { allowAll?: boolean; models?: string[] }>
}

/** Provider IDs that are retained only for deterministic compatibility errors. */
export const retiredProviderNames = [
	"bedrock",
	"ollama",
	"lmstudio",
	"gemini-cli",
	"openai-codex",
	"deepseek",
	"qwen-code",
	"moonshot",
	"mistral",
	"requesty",
	"unbound",
	"litellm",
	"sambanova",
	"zai",
	"fireworks",
	"vercel-ai-gateway",
	"minimax",
	"baseten",
	"poe",
	"cerebras",
	"chutes",
	"deepinfra",
	"doubao",
	"featherless",
	"groq",
	"huggingface",
	"io-intelligence",
] as const

export const retiredProviderNamesSchema = z.enum(retiredProviderNames)
export type RetiredProviderName = z.infer<typeof retiredProviderNamesSchema>
export const isRetiredProvider = (value: string): value is RetiredProviderName =>
	retiredProviderNames.includes(value as RetiredProviderName)

export const providerNamesWithRetiredSchema = z.union([
	providerNamesSchema,
	z.enum(fauxProviders),
	retiredProviderNamesSchema,
])
export type ProviderNameWithRetired = z.infer<typeof providerNamesWithRetiredSchema>

/**
 * A loose persisted provider schema keeps unknown IDs available to recovery and
 * lets the API factory produce an explicit unsupported-provider error.
 */
export const persistedProviderNameSchema = z.string().min(1)
export const isKnownProvider = (value: unknown): value is ProviderNameWithRetired =>
	typeof value === "string" &&
	(providerNames.includes(value as ProviderName) ||
		fauxProviders.includes(value as FauxProvider) ||
		retiredProviderNames.includes(value as RetiredProviderName))

export type ProviderSettingsEntry = {
	id: string
	name: string
	apiProvider?: string
	modelId?: string
	availability?: "invalid" | "unsupported"
	invalidFields?: string[]
}

export const providerSettingsEntrySchema = z.object({
	id: z.string(),
	name: z.string(),
	apiProvider: persistedProviderNameSchema.optional(),
	modelId: z.string().optional(),
	availability: z.enum(["invalid", "unsupported"]).optional(),
	invalidFields: z.array(z.string()).max(10).optional(),
})

const baseProviderSettingsSchema = z.object({
	includeMaxTokens: z.boolean().optional(),
	todoListEnabled: z.boolean().optional(),
	modelTemperature: z.number().nullish(),
	rateLimitSeconds: z.number().optional(),
	consecutiveMistakeLimit: z.number().min(0).optional(),

	// Model reasoning.
	enableReasoningEffort: z.boolean().optional(),
	reasoningEffort: reasoningEffortSettingSchema.optional(),
	modelMaxTokens: z.number().optional(),
	modelMaxThinkingTokens: z.number().optional(),

	// Model verbosity.
	verbosity: verbosityLevelsSchema.optional(),
})

const apiModelIdProviderModelSchema = baseProviderSettingsSchema.extend({
	apiModelId: z.string().optional(),
})

const vertexSchema = apiModelIdProviderModelSchema.extend({
	vertexKeyFile: z.string().optional(),
	vertexJsonCredentials: z.string().optional(),
	vertexProjectId: z.string().optional(),
	vertexRegion: z.string().optional(),
	gatewayBaseUrl: z.string().optional(),
	projectId: z.string().optional(),
	location: z.string().optional(),
	pemCaBundlePath: z.string().optional(),
	helixCommand: z.string().optional(),
	helixParseMode: z.enum(["raw_stdout", "json_field"]).optional(),
	helixTokenKey: z.string().optional(),
	refreshIntervalMinutes: z.number().int().min(1).optional(),
	modelRoutingMap: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
	vertexGatewayBaseUrl: z.string().optional(),
	vertexGatewayCaBundlePath: z.string().optional(),
	vertexGatewayHelixCommand: z.string().optional(),
	vertexGatewayTokenRefreshMinutes: z.number().int().positive().optional(),
	vertexGatewayModelRoutingMap: z.string().optional(),
	vertexStreamingEnabled: z.boolean().optional(),
	vertex1MContext: z.boolean().optional(),
})

const stellarSchema = apiModelIdProviderModelSchema.extend({
	stellarBaseUrl: z.string().optional(),
	stellarPemCaBundlePath: z.string().optional(),
	stellarHelixCommand: z.string().optional(),
	stellarHelixParseMode: z.enum(["raw_stdout", "json_field"]).optional(),
	stellarHelixTokenKey: z.string().optional(),
	stellarTokenRefreshMinutes: z.number().int().min(1).optional(),
	stellarStreamingEnabled: z.boolean().optional(),
})

const openAiSchema = baseProviderSettingsSchema.extend({
	openAiBaseUrl: z.string().optional(),
	openAiApiKey: z.string().optional(),
	openAiR1FormatEnabled: z.boolean().optional(),
	openAiModelId: z.string().optional(),
	openAiCustomModelInfo: modelInfoSchema.nullish(),
	openAiUseAzure: z.boolean().optional(),
	azureApiVersion: z.string().optional(),
	openAiStreamingEnabled: z.boolean().optional(),
	openAiHostHeader: z.string().optional(),
	openAiHeaders: z.record(z.string(), z.string()).optional(),
})

const openAiNativeSchema = apiModelIdProviderModelSchema.extend({
	openAiNativeApiKey: z.string().optional(),
	// Retain historical route settings so adapters can validate them before dispatch.
	openAiNativeBaseUrl: z.string().optional(),
	openAiNativeServiceTier: serviceTierSchema.optional(),
})

const anthropicSchema = apiModelIdProviderModelSchema.extend({
	apiKey: z.string().optional(),
	anthropicBaseUrl: z.string().optional(),
	anthropicUseAuthToken: z.boolean().optional(),
	anthropicBeta1MContext: z.boolean().optional(),
})

const geminiSchema = apiModelIdProviderModelSchema.extend({
	geminiApiKey: z.string().optional(),
	googleGeminiBaseUrl: z.string().optional(),
})

const xaiSchema = apiModelIdProviderModelSchema.extend({
	xaiApiKey: z.string().optional(),
})

const openRouterSchema = apiModelIdProviderModelSchema.extend({
	openRouterApiKey: z.string().optional(),
	/** Reader compatibility; new selections use apiModelId. */
	openRouterModelId: z.string().optional(),
	openRouterBaseUrl: z.string().optional(),
	openRouterSpecificProvider: z.string().optional(),
	openRouterStreamingEnabled: z.boolean().optional(),
})

const vsCodeLmSchema = baseProviderSettingsSchema.extend({
	vsCodeLmModelSelector: z
		.object({
			vendor: z.string().optional(),
			family: z.string().optional(),
			version: z.string().optional(),
			id: z.string().optional(),
		})
		.optional(),
	vsCodeLmContextSize: z.number().int().positive().optional(),
})

const fakeAiSchema = baseProviderSettingsSchema.extend({
	fakeAi: z.unknown().optional(),
})

export const providerSettingsSchemaDiscriminated = z.discriminatedUnion("apiProvider", [
	vertexSchema.merge(z.object({ apiProvider: z.literal("vertex") })),
	stellarSchema.merge(z.object({ apiProvider: z.literal("stellar") })),
	openAiSchema.merge(z.object({ apiProvider: z.literal("openai") })),
	openAiNativeSchema.merge(z.object({ apiProvider: z.literal("openai-native") })),
	anthropicSchema.merge(z.object({ apiProvider: z.literal("anthropic") })),
	geminiSchema.merge(z.object({ apiProvider: z.literal("gemini") })),
	xaiSchema.merge(z.object({ apiProvider: z.literal("xai") })),
	openRouterSchema.merge(z.object({ apiProvider: z.literal("openrouter") })),
	vsCodeLmSchema.merge(z.object({ apiProvider: z.literal("vscode-lm") })),
	fakeAiSchema.merge(z.object({ apiProvider: z.literal("fake-ai") })),
	z.object({ apiProvider: z.undefined() }),
])

export const providerSettingsSchema = z.object({
	apiProvider: providerNamesWithRetiredSchema.optional(),
	...vertexSchema.shape,
	...stellarSchema.shape,
	...openAiSchema.shape,
	...openAiNativeSchema.shape,
	...anthropicSchema.shape,
	...geminiSchema.shape,
	...xaiSchema.shape,
	...openRouterSchema.shape,
	...vsCodeLmSchema.shape,
	...fakeAiSchema.shape,
	...codebaseIndexProviderSchema.shape,
})

export type ProviderSettings = z.infer<typeof providerSettingsSchema>

export const curatedProviderApiKeyFields = {
	"openai-native": "openAiNativeApiKey",
	anthropic: "apiKey",
	gemini: "geminiApiKey",
	xai: "xaiApiKey",
	openrouter: "openRouterApiKey",
} as const satisfies Record<CuratedProvider, keyof ProviderSettings>

function isUnsupportedCuratedEndpoint(value: string | undefined, origin: string, paths: readonly string[]): boolean {
	if (value === undefined || value.trim() === "") return false
	try {
		const url = new URL(value)
		return (
			url.origin !== origin ||
			url.username !== "" ||
			url.password !== "" ||
			url.href.includes("?") ||
			url.href.includes("#") ||
			!paths.includes(url.pathname.replace(/\/+$/, ""))
		)
	} catch {
		return true
	}
}

/** Preserve saved route intent: unsupported overrides must be repaired before an official-endpoint request. */
export function getUnsupportedCuratedProviderSettings(
	provider: CuratedProvider,
	settings: ProviderSettings,
): (keyof ProviderSettings)[] {
	const unsupported: (keyof ProviderSettings)[] = []
	switch (provider) {
		case "openai-native":
			if (isUnsupportedCuratedEndpoint(settings.openAiNativeBaseUrl, "https://api.openai.com", ["/v1"])) {
				unsupported.push("openAiNativeBaseUrl")
			}
			if (settings.openAiNativeServiceTier !== undefined && settings.openAiNativeServiceTier !== "default") {
				unsupported.push("openAiNativeServiceTier")
			}
			break
		case "anthropic":
			if (isUnsupportedCuratedEndpoint(settings.anthropicBaseUrl, "https://api.anthropic.com", ["", "/v1"])) {
				unsupported.push("anthropicBaseUrl")
			}
			if (settings.anthropicUseAuthToken) unsupported.push("anthropicUseAuthToken")
			break
		case "gemini":
			if (
				isUnsupportedCuratedEndpoint(
					settings.googleGeminiBaseUrl,
					"https://generativelanguage.googleapis.com",
					["", "/v1beta"],
				)
			) {
				unsupported.push("googleGeminiBaseUrl")
			}
			break
		case "openrouter":
			if (isUnsupportedCuratedEndpoint(settings.openRouterBaseUrl, "https://openrouter.ai", ["/api/v1"])) {
				unsupported.push("openRouterBaseUrl")
			}
			if (settings.openRouterSpecificProvider?.trim()) unsupported.push("openRouterSpecificProvider")
			break
		case "xai":
			break
	}
	return unsupported
}

export const providerSettingsWithIdSchema = providerSettingsSchema.extend({ id: z.string().optional() })
export const discriminatedProviderSettingsWithIdSchema = providerSettingsSchemaDiscriminated.and(
	z.object({ id: z.string().optional() }),
)
export type ProviderSettingsWithId = z.infer<typeof providerSettingsWithIdSchema>

/** Use these schemas for persisted/imported profiles before executable validation. */
export const persistedProviderSettingsSchema = providerSettingsSchema
	.extend({ apiProvider: persistedProviderNameSchema.optional() })
	.passthrough()
export const persistedProviderSettingsWithIdSchema = persistedProviderSettingsSchema.extend({
	id: z.string().optional(),
})

export const PROVIDER_SETTINGS_KEYS = providerSettingsSchema.keyof().options

export const modelIdKeys = [
	"apiModelId",
	"openAiModelId",
	"openRouterModelId",
] as const satisfies readonly (keyof ProviderSettings)[]
export type ModelIdKey = (typeof modelIdKeys)[number]

export const getModelId = (settings: ProviderSettings): string | undefined => {
	if (settings.apiProvider === "openrouter") return settings.apiModelId ?? settings.openRouterModelId
	if (settings.apiProvider === "openai") return settings.openAiModelId
	if (isProviderName(settings.apiProvider)) return settings.apiModelId
	// Unknown saved profiles retain the historical diagnostic reader without gaining execution authority.
	const modelIdKey = modelIdKeys.find((key) => settings[key])
	return modelIdKey ? settings[modelIdKey] : undefined
}

export type TypicalProvider = Exclude<ProviderName, InternalProvider | CustomProvider>
export const isTypicalProvider = (key: unknown): key is TypicalProvider =>
	isProviderName(key) && !isInternalProvider(key) && !isCustomProvider(key)

export const modelIdKeysByProvider: Record<TypicalProvider, ModelIdKey> = {
	vertex: "apiModelId",
	stellar: "apiModelId",
	"openai-native": "apiModelId",
	anthropic: "apiModelId",
	gemini: "apiModelId",
	xai: "apiModelId",
	openrouter: "apiModelId",
}

/** Direct Anthropic and Vertex Claude preserve the native Messages wire semantics. */
export const ANTHROPIC_STYLE_PROVIDERS: ProviderName[] = ["anthropic"]

export const getApiProtocol = (provider: ProviderName | undefined, modelId?: string): "anthropic" | "openai" => {
	if (provider === "anthropic" || (provider === "vertex" && modelId && modelId.toLowerCase().includes("claude"))) {
		return "anthropic"
	}

	return "openai"
}

export const MODELS_BY_PROVIDER: Record<
	Exclude<ProviderName, CustomProvider>,
	{ id: ProviderName; label: string; models: string[] }
> = {
	vertex: {
		id: "vertex",
		label: "GCP Vertex AI",
		models: Object.keys(vertexModels),
	},
	stellar: {
		id: "stellar",
		label: "Stellar",
		models: Object.keys(stellarModels),
	},
	"vscode-lm": {
		id: "vscode-lm",
		label: "VS Code LM API",
		models: Object.keys(vscodeLlmModels),
	},
	"openai-native": { id: "openai-native", label: "OpenAI", models: Object.keys(openAiNativeModels) },
	anthropic: { id: "anthropic", label: "Anthropic", models: Object.keys(anthropicModels) },
	gemini: { id: "gemini", label: "Google Gemini", models: Object.keys(geminiModels) },
	xai: { id: "xai", label: "xAI", models: Object.keys(xaiModels) },
	openrouter: { id: "openrouter", label: "OpenRouter", models: Object.keys(openRouterModels) },
}

export const CURATED_MODELS_BY_PROVIDER: Record<CuratedProvider, Record<string, ModelInfo>> = {
	"openai-native": openAiNativeModels,
	anthropic: anthropicModels,
	gemini: geminiModels,
	xai: xaiModels,
	openrouter: openRouterModels,
}

export const getCuratedProviderModels = (provider: CuratedProvider): Record<string, ModelInfo> =>
	CURATED_MODELS_BY_PROVIDER[provider]

/** Unknown IDs, including object prototype keys, must never acquire model capabilities. */
export const getCuratedModelInfo = (provider: CuratedProvider, modelId: string): ModelInfo | undefined => {
	const models = getCuratedProviderModels(provider)
	return Object.hasOwn(models, modelId) ? models[modelId] : undefined
}
