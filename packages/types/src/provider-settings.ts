import { z } from "zod"

import { modelInfoSchema, reasoningEffortSettingSchema, verbosityLevelsSchema } from "./model.js"
import { codebaseIndexProviderSchema } from "./codebase-index.js"
import { stellarModels, vertexModels, vscodeLlmModels } from "./providers/index.js"

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

/** Public provider IDs. Keep this list in sync with the executable factory. */
export const providerNames = ["vertex", "vscode-lm", "stellar", "openai"] as const
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
	"anthropic",
	"bedrock",
	"openrouter",
	"ollama",
	"lmstudio",
	"gemini",
	"gemini-cli",
	"openai-codex",
	"openai-native",
	"deepseek",
	"qwen-code",
	"moonshot",
	"mistral",
	"requesty",
	"unbound",
	"xai",
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
	"roo",
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
}

export const providerSettingsEntrySchema = z.object({
	id: z.string(),
	name: z.string(),
	apiProvider: persistedProviderNameSchema.optional(),
	modelId: z.string().optional(),
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
	vsCodeLmSchema.merge(z.object({ apiProvider: z.literal("vscode-lm") })),
	fakeAiSchema.merge(z.object({ apiProvider: z.literal("fake-ai") })),
	z.object({ apiProvider: z.undefined() }),
])

export const providerSettingsSchema = z.object({
	apiProvider: providerNamesWithRetiredSchema.optional(),
	...vertexSchema.shape,
	...stellarSchema.shape,
	...openAiSchema.shape,
	...vsCodeLmSchema.shape,
	...fakeAiSchema.shape,
	...codebaseIndexProviderSchema.shape,
})

export type ProviderSettings = z.infer<typeof providerSettingsSchema>

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

export const modelIdKeys = ["apiModelId", "openAiModelId"] as const satisfies readonly (keyof ProviderSettings)[]
export type ModelIdKey = (typeof modelIdKeys)[number]

export const getModelId = (settings: ProviderSettings): string | undefined => {
	const modelIdKey = modelIdKeys.find((key) => settings[key])
	return modelIdKey ? settings[modelIdKey] : undefined
}

export type TypicalProvider = Exclude<ProviderName, InternalProvider | CustomProvider>
export const isTypicalProvider = (key: unknown): key is TypicalProvider =>
	isProviderName(key) && !isInternalProvider(key) && !isCustomProvider(key)

export const modelIdKeysByProvider: Record<TypicalProvider, ModelIdKey> = {
	vertex: "apiModelId",
	stellar: "apiModelId",
}

/** Vertex Claude uses Anthropic wire semantics; all other approved paths use OpenAI/Gemini semantics. */
export const ANTHROPIC_STYLE_PROVIDERS: ProviderName[] = []

export const getApiProtocol = (provider: ProviderName | undefined, modelId?: string): "anthropic" | "openai" => {
	if (provider === "vertex" && modelId && modelId.toLowerCase().includes("claude")) {
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
}
