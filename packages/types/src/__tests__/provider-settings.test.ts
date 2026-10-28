import {
	getApiProtocol,
	getModelId,
	curatedProviders,
	getCuratedModelInfo,
	getCuratedProviderModels,
	curatedProviderApiKeyFields,
	isCuratedProvider,
	MODELS_BY_PROVIDER,
	persistedProviderSettingsSchema,
	providerNames,
	providerSettingsSchemaDiscriminated,
	providerSettingsEntrySchema,
} from "../provider-settings.js"
import { GLOBAL_STATE_KEYS, SECRET_STATE_KEYS } from "../global-settings.js"
import { stellarDefaultModelId } from "../providers/stellar.js"
import { getProviderDefaultModelId } from "../providers/index.js"

describe("supported provider settings", () => {
	it("keeps old profile metadata compatible and preserves bounded availability metadata", () => {
		expect(providerSettingsEntrySchema.parse({ id: "saved", name: "Saved" })).toEqual({
			id: "saved",
			name: "Saved",
		})
		expect(
			providerSettingsEntrySchema.parse({
				id: "saved",
				name: "Saved",
				availability: "invalid",
				invalidFields: ["rateLimitSeconds"],
				value: { openAiApiKey: "must-not-cross-metadata-boundary" },
			}),
		).toEqual({ id: "saved", name: "Saved", availability: "invalid", invalidFields: ["rateLimitSeconds"] })
	})

	it("rejects unknown availability states and unbounded field lists", () => {
		expect(
			providerSettingsEntrySchema.safeParse({ id: "saved", name: "Saved", availability: "enabled" }).success,
		).toBe(false)
		expect(
			providerSettingsEntrySchema.safeParse({ id: "saved", name: "Saved", invalidFields: Array(11).fill("id") })
				.success,
		).toBe(false)
	})

	it("exposes the curated native providers without changing the compatible endpoint identity", () => {
		expect(providerNames).toEqual([
			"vertex",
			"vscode-lm",
			"stellar",
			"openai",
			"openai-native",
			"openai-codex",
			"anthropic",
			"gemini",
			"xai",
			"openrouter",
			"bedrock",
			"meta",
		])
		expect(Object.keys(MODELS_BY_PROVIDER)).toEqual([
			"vertex",
			"stellar",
			"vscode-lm",
			"openai-native",
			"openai-codex",
			"meta",
			"bedrock",
			"anthropic",
			"gemini",
			"xai",
			"openrouter",
		])
	})

	it.each(["ollama", "unknown-future-provider"])(
		"rejects %s in executable profiles while preserving saved data",
		(apiProvider) => {
			const saved = { apiProvider, legacyModelId: "saved-model" }
			expect(providerSettingsSchemaDiscriminated.safeParse(saved).success).toBe(false)
			expect(persistedProviderSettingsSchema.parse(saved)).toEqual(saved)
		},
	)

	it.each([
		["openai-native", "openAiNativeApiKey"],
		["anthropic", "apiKey"],
		["gemini", "geminiApiKey"],
		["xai", "xaiApiKey"],
		["openrouter", "openRouterApiKey"],
		["meta", "metaApiKey"],
	])("keeps %s credentials in SecretStorage and filters other provider fields", (apiProvider, credential) => {
		const parsed = providerSettingsSchemaDiscriminated.parse({
			apiProvider,
			apiModelId: "selected-model",
			[credential]: "saved-secret",
			openAiApiKey: "unrelated-secret",
			openAiBaseUrl: "https://unrelated.example/v1",
		})
		expect(parsed).toEqual({ apiProvider, apiModelId: "selected-model", [credential]: "saved-secret" })
		expect(SECRET_STATE_KEYS).toContain(credential)
		expect(GLOBAL_STATE_KEYS).not.toContain(credential)
	})

	it.each(curatedProviders)("shares %s defaults and model metadata without accepting prototype keys", (provider) => {
		const models = getCuratedProviderModels(provider)
		const defaultModelId = getProviderDefaultModelId(provider)
		expect(Object.keys(models).length).toBeGreaterThan(0)
		expect(getCuratedModelInfo(provider, defaultModelId)).toBe(models[defaultModelId])
		expect(MODELS_BY_PROVIDER[provider].models).toEqual(Object.keys(models))
		expect(getCuratedModelInfo(provider, "unknown-model")).toBeUndefined()
		expect(getCuratedModelInfo(provider, "__proto__")).toBeUndefined()
		expect(getCuratedModelInfo(provider, "constructor")).toBeUndefined()
		expect(isCuratedProvider(provider)).toBe(true)
		const apiKeyField = curatedProviderApiKeyFields[provider]
		if (apiKeyField) expect(SECRET_STATE_KEYS).toContain(apiKeyField)
	})

	it("does not apply curated model capabilities to compatible, retired, or unknown providers", () => {
		for (const provider of ["openai", "vertex", "ollama", "unknown-provider", undefined]) {
			expect(isCuratedProvider(provider)).toBe(false)
		}
	})

	it("preserves legacy OpenRouter selection without allowing stale provider fields to override it", () => {
		const saved = providerSettingsSchemaDiscriminated.parse({
			apiProvider: "openrouter",
			openRouterModelId: "legacy-model",
			openRouterApiKey: "saved-secret",
			openRouterBaseUrl: "https://openrouter.ai/api/v1",
			openRouterSpecificProvider: "saved-provider",
		})
		expect(saved).toMatchObject({ openRouterModelId: "legacy-model", openRouterSpecificProvider: "saved-provider" })
		expect(getModelId(saved)).toBe("legacy-model")
		expect(getModelId({ ...saved, apiModelId: "selected-model" })).toBe("selected-model")
		expect(getModelId({ ...saved, apiModelId: "" })).toBe("")
		expect(getModelId({ apiProvider: "openai-native", openAiModelId: "unrelated-model" })).toBeUndefined()
		expect(getModelId({ apiProvider: "openai", apiModelId: "stale-model", openAiModelId: "selected-model" })).toBe(
			"selected-model",
		)
	})

	it("retains Stellar connection and Helix settings in provider profiles", () => {
		const parsed = providerSettingsSchemaDiscriminated.parse({
			apiProvider: "stellar",
			apiModelId: stellarDefaultModelId,
			stellarBaseUrl: "https://gateway.example.com/stellar/v1",
			stellarPemCaBundlePath: "C:\\certs\\corp.pem",
			stellarHelixCommand: "helix auth access-token print -a",
			stellarHelixParseMode: "json_field",
			stellarHelixTokenKey: "token.value",
			stellarTokenRefreshMinutes: 15,
			stellarStreamingEnabled: false,
		})

		expect(parsed).toMatchObject({
			apiProvider: "stellar",
			apiModelId: stellarDefaultModelId,
			stellarBaseUrl: "https://gateway.example.com/stellar/v1",
			stellarPemCaBundlePath: "C:\\certs\\corp.pem",
			stellarHelixCommand: "helix auth access-token print -a",
			stellarHelixParseMode: "json_field",
			stellarHelixTokenKey: "token.value",
			stellarTokenRefreshMinutes: 15,
			stellarStreamingEnabled: false,
		})
	})

	it("accepts an internal fake-ai profile only through the discriminated harness schema", () => {
		expect(
			providerSettingsSchemaDiscriminated.parse({ apiProvider: "fake-ai", fakeAi: { id: "fixture" } }),
		).toEqual(expect.objectContaining({ apiProvider: "fake-ai" }))
	})

	it("preserves arbitrary persisted provider identifiers for explicit recovery errors", () => {
		expect(
			persistedProviderSettingsSchema.parse({
				apiProvider: "removed-provider-from-an-older-release",
				legacyApiKey: "retained-for-diagnostics",
			}),
		).toEqual(
			expect.objectContaining({
				apiProvider: "removed-provider-from-an-older-release",
				legacyApiKey: "retained-for-diagnostics",
			}),
		)
	})
})

describe("getApiProtocol", () => {
	it("uses Anthropic usage semantics for Bedrock's omitted model default", () => {
		expect(getApiProtocol("bedrock")).toBe("anthropic")
	})

	it.each([
		["global.anthropic.claude-opus-5-5", "anthropic"],
		["global.anthropic.claude-sonnet-5-5", "anthropic"],
		["global.anthropic.claude-fable-5-1", "anthropic"],
		["global.openai.gpt-6.1-sol", "openai"],
		["global.openai.gpt-6-astra", "openai"],
	] as const)("uses the verified Bedrock route for %s", (modelId, protocol) => {
		expect(getApiProtocol("bedrock", modelId)).toBe(protocol)
		expect(getApiProtocol("bedrock", ` ${modelId} `)).toBe(protocol)
	})

	it("uses Anthropic wire semantics for direct Anthropic and Vertex Claude models", () => {
		expect(getApiProtocol("anthropic", "claude-sonnet-5")).toBe("anthropic")
		expect(getApiProtocol("vertex", "claude-3-opus")).toBe("anthropic")
		expect(getApiProtocol("vertex", "Claude-3-Sonnet")).toBe("anthropic")
		expect(getApiProtocol("vertex", "gemini-3.7-flash")).toBe("openai")
		expect(getApiProtocol("vertex", "xai/grok-4.6")).toBe("openai")
	})

	it("uses OpenAI semantics for all other approved providers and missing settings", () => {
		expect(getApiProtocol("openrouter", "anthropic/claude-sonnet-5")).toBe("openai")
		expect(getApiProtocol("openai", "claude-3-sonnet")).toBe("openai")
		expect(getApiProtocol("stellar", "Meta-Llama-3.3-70B-Instruct")).toBe("openai")
		expect(getApiProtocol("vscode-lm")).toBe("openai")
		expect(getApiProtocol(undefined, "claude-3-opus")).toBe("openai")
	})
})
