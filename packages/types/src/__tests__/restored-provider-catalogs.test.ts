import { GLOBAL_STATE_KEYS, SECRET_STATE_KEYS } from "../global-settings.js"
import { resolveModelParameterApplicability, resolveOptionalOutputTokenLimit } from "../model-parameters.js"
import {
	curatedProviderApiKeyFields,
	getApiProtocol,
	getCuratedModelInfo,
	getCuratedProviderModels,
	getModelId,
	providerSettingsSchemaDiscriminated,
	retiredProviderNames,
} from "../provider-settings.js"
import {
	bedrockDefaultModelId,
	bedrockModels,
	bedrockRegionPattern,
	getBedrockModelRoute,
	getProviderDefaultModelId,
	metaDefaultModelId,
	metaModels,
	openAiCodexModels,
	openAiNativeModels,
	getVscodeLlmCatalogModels,
	getVscodeLlmModelInfo,
} from "../providers/index.js"

describe("restored and frontier provider contracts", () => {
	it.each(["sol", "terra", "luna"])("makes GPT-5.6 %s and its reasoning available without discovery", (variant) => {
		const modelId = `gpt-5.6-${variant}`
		for (const [provider, id] of [
			["openai-native", modelId],
			["openai-codex", modelId],
			["openrouter", `openai/${modelId}`],
			["bedrock", `global.openai.${modelId}`],
		] as const) {
			expect(getCuratedModelInfo(provider, id), `${provider}: ${id}`).toMatchObject({
				supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
				requiredReasoningEffort: false,
				reasoningEffort: "medium",
			})
		}
		const copilot = getVscodeLlmCatalogModels().find((model) => model.family === modelId)
		expect(copilot).toMatchObject({ vendor: "copilot", family: modelId })
		expect(getVscodeLlmModelInfo({ vendor: "copilot", family: modelId })).toMatchObject({
			supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
			requiredReasoningEffort: false,
		})
	})

	it("shares the exact OpenAI choices across API-key and ChatGPT access", () => {
		expect(openAiCodexModels).toBe(openAiNativeModels)
		expect(Object.keys(openAiCodexModels)).toEqual([
			"gpt-6.1-sol",
			"gpt-6-astra",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		])
		expect(getProviderDefaultModelId("openai-codex")).toBe(getProviderDefaultModelId("openai-native"))
		expect(curatedProviderApiKeyFields["openai-codex"]).toBeUndefined()
		expect(retiredProviderNames).not.toContain("openai-codex")
		expect(
			providerSettingsSchemaDiscriminated.parse({
				apiProvider: "openai-codex",
				apiModelId: "gpt-6.1-sol",
				accessToken: "must-not-enter-profile",
				refreshToken: "must-not-enter-profile",
				openAiApiKey: "unrelated-key",
			}),
		).toEqual({ apiProvider: "openai-codex", apiModelId: "gpt-6.1-sol" })
	})

	it("keeps native Meta's documented capability limits separate from Router metadata", () => {
		expect(Object.keys(metaModels)).toEqual(["muse-wonder-1.0"])
		expect(getProviderDefaultModelId("meta")).toBe(metaDefaultModelId)
		expect(metaModels[metaDefaultModelId]).toMatchObject({
			contextWindow: 1_048_576,
			contextWindowIncludesOutput: true,
			maxTokens: -1,
			supportsReasoningEffort: ["minimal", "low", "medium", "high", "xhigh", "max"],
			requiredReasoningEffort: true,
			reasoningEffort: "high",
			inputPrice: 4,
			outputPrice: 20,
			cacheReadsPrice: 0.2,
		})
		const model = metaModels[metaDefaultModelId]
		expect(resolveModelParameterApplicability({ provider: "meta", modelId: metaDefaultModelId })).toEqual({
			route: "meta-responses",
			supportsTemperature: false,
			supportsVerbosity: false,
		})
		expect(
			resolveOptionalOutputTokenLimit({ model, route: "meta-responses", settings: { includeMaxTokens: true } }),
		).toBeUndefined()
		expect(() =>
			resolveOptionalOutputTokenLimit({
				model,
				route: "meta-responses",
				settings: { includeMaxTokens: true, modelMaxTokens: 15 },
			}),
		).toThrow(/at least 16/)
	})

	it("retains explicit AWS authentication settings and stores every credential only as a secret", () => {
		const settings = {
			apiProvider: "bedrock",
			apiModelId: bedrockDefaultModelId,
			awsAccessKey: "access-key",
			awsSecretKey: "secret-key",
			awsSessionToken: "session-token",
			awsApiKey: "bedrock-api-key",
			awsUseApiKey: false,
			awsRegion: "us-east-1",
			awsProfile: "alpha",
			awsUseProfile: true,
			awsCustomArn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/example",
		}
		expect(providerSettingsSchemaDiscriminated.parse(settings)).toEqual(settings)
		expect(curatedProviderApiKeyFields.bedrock).toBeUndefined()
		expect(retiredProviderNames).not.toContain("bedrock")
		for (const key of ["awsAccessKey", "awsSecretKey", "awsSessionToken", "awsApiKey", "metaApiKey"] as const) {
			expect(SECRET_STATE_KEYS).toContain(key)
			expect(GLOBAL_STATE_KEYS).not.toContain(key)
		}
		for (const region of ["us-east-1", "eu-west-3", "us-gov-west-1"])
			expect(bedrockRegionPattern.test(region)).toBe(true)
		for (const region of ["", "https://invalid.example", "us-east-1/other"])
			expect(bedrockRegionPattern.test(region)).toBe(false)
	})

	it("keeps each trusted Bedrock model on its explicit wire route", () => {
		expect(Object.keys(bedrockModels)).toEqual([
			"global.anthropic.claude-opus-5-5",
			"global.anthropic.claude-sonnet-5-5",
			"global.anthropic.claude-fable-5-1",
			"global.openai.gpt-6.1-sol",
			"global.openai.gpt-6-astra",
			"global.openai.gpt-5.6-sol",
			"global.openai.gpt-5.6-terra",
			"global.openai.gpt-5.6-luna",
		])
		for (const modelId of Object.keys(bedrockModels)) {
			const route = modelId.startsWith("global.anthropic.") ? "anthropic-messages" : "openai-responses"
			expect(getBedrockModelRoute(modelId)).toBe(route)
			expect(resolveModelParameterApplicability({ provider: "bedrock", modelId }).route).toBe(route)
			expect(getApiProtocol("bedrock", modelId)).toBe(route === "anthropic-messages" ? "anthropic" : "openai")
		}
		expect(getBedrockModelRoute("global.openai.unknown")).toBeUndefined()
		expect(getBedrockModelRoute("__proto__")).toBeUndefined()
		expect(bedrockModels["global.openai.gpt-6.1-sol"]).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 131_072,
		})
		expect(bedrockModels["global.openai.gpt-6-astra"]).toMatchObject({
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		})
	})

	it.each([
		["global.anthropic.claude-opus-5-5", 4, 20, 5, 0.2],
		["global.anthropic.claude-sonnet-5-5", 2, 10, 2.5, 0.1],
		["global.anthropic.claude-fable-5-1", 10, 50, 12.5, 0.25],
		["global.openai.gpt-6.1-sol", 2, 10, 2.5, 0.1],
		["global.openai.gpt-6-astra", 10, 50, 12.5, 1],
		["global.openai.gpt-5.6-sol", 4, 20, 5, 0.4],
		["global.openai.gpt-5.6-terra", 2, 12, 2.5, 0.2],
		["global.openai.gpt-5.6-luna", 0.2, 1.2, 0.25, 0.02],
	] as const)(
		"accounts for the verified Global Standard token prices of %s",
		(modelId, inputPrice, outputPrice, cacheWritesPrice, cacheReadsPrice) => {
			const model = bedrockModels[modelId]
			expect(model).toMatchObject({ inputPrice, outputPrice, cacheWritesPrice, cacheReadsPrice })
			for (const field of ["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice"] as const) {
				expect(model[field]).toBeGreaterThan(0)
			}
		},
	)

	it("applies long-context rate changes only to the Bedrock GPT models", () => {
		for (const modelId of [
			"global.openai.gpt-6.1-sol",
			"global.openai.gpt-6-astra",
			"global.openai.gpt-5.6-sol",
			"global.openai.gpt-5.6-terra",
			"global.openai.gpt-5.6-luna",
		] as const) {
			expect(bedrockModels[modelId]).toMatchObject({
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					cacheReadsPriceMultiplier: 2,
					cacheWritesPriceMultiplier: 2,
				},
			})
		}
		for (const modelId of [
			"global.anthropic.claude-opus-5-5",
			"global.anthropic.claude-sonnet-5-5",
			"global.anthropic.claude-fable-5-1",
		] as const) {
			expect(bedrockModels[modelId]).not.toHaveProperty("longContextPricing")
		}
	})

	it.each([
		["openai-native", "gpt-5.5"],
		["openai-codex", "gpt-6-luna"],
		["anthropic", "claude-haiku-5-5"],
		["gemini", "gemini-3.8-flash"],
		["xai", "grok-4.6"],
		["openrouter", "z-ai/glm-5.3"],
	] as const)(
		"preserves removed %s identity %s for explicit recovery instead of remapping",
		(apiProvider, apiModelId) => {
			const settings = providerSettingsSchemaDiscriminated.parse({ apiProvider, apiModelId })
			expect(getModelId(settings)).toBe(apiModelId)
			expect(getCuratedModelInfo(apiProvider, apiModelId)).toBeUndefined()
			expect(getCuratedProviderModels(apiProvider)).not.toHaveProperty(apiModelId)
		},
	)
})
