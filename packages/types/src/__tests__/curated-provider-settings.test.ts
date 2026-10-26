import {
	getUnsupportedCuratedProviderSettings,
	providerSettingsSchemaDiscriminated,
	type CuratedProvider,
	type ProviderSettings,
} from "../provider-settings.js"

const endpoints = [
	["openai-native", "openAiNativeBaseUrl", "https://api.openai.com/v1"],
	["anthropic", "anthropicBaseUrl", "https://api.anthropic.com"],
	["gemini", "googleGeminiBaseUrl", "https://generativelanguage.googleapis.com/v1beta"],
	["openrouter", "openRouterBaseUrl", "https://openrouter.ai/api/v1"],
] as const

describe("curated provider saved route validation", () => {
	it.each(endpoints)("accepts absent, blank, and canonical %s endpoints", (provider, field, endpoint) => {
		for (const value of [undefined, "", "  ", endpoint, `${endpoint}/`]) {
			expect(getUnsupportedCuratedProviderSettings(provider, { [field]: value })).toEqual([])
		}
	})

	it.each(endpoints)("rejects custom, malformed, and credential-bearing %s URLs", (provider, field, endpoint) => {
		const url = new URL(endpoint)
		for (const value of [
			"not-a-url",
			"https://custom.example/v1",
			endpoint.replace("https:", "http:"),
			`${endpoint}/other-route`,
			`${endpoint}?api_key=private-test-value`,
			`${endpoint}?`,
			`${endpoint}#private-test-value`,
			`${endpoint}#`,
			`${url.protocol}//user:private-test-value@${url.host}${url.pathname}`,
			`${url.protocol}//${url.hostname}:8443${url.pathname}`,
		]) {
			expect(getUnsupportedCuratedProviderSettings(provider, { [field]: value })).toEqual([field])
		}
	})

	it("accepts official Anthropic and Gemini paths without changing the saved value", () => {
		for (const [provider, field, endpoint] of [
			["anthropic", "anthropicBaseUrl", "https://api.anthropic.com/v1/"],
			["gemini", "googleGeminiBaseUrl", "https://generativelanguage.googleapis.com/"],
		] as const) {
			const settings = { apiProvider: provider, [field]: endpoint }
			expect(getUnsupportedCuratedProviderSettings(provider, settings)).toEqual([])
			expect(providerSettingsSchemaDiscriminated.parse(settings)).toEqual(settings)
		}
	})

	it("reports only unsupported field names, retaining saved auth and routing choices for repair", () => {
		const examples: [CuratedProvider, ProviderSettings, (keyof ProviderSettings)[]][] = [
			[
				"openai-native",
				{ openAiNativeBaseUrl: "https://custom.example", openAiNativeServiceTier: "priority" },
				["openAiNativeBaseUrl", "openAiNativeServiceTier"],
			],
			["anthropic", { anthropicUseAuthToken: true }, ["anthropicUseAuthToken"]],
			["openrouter", { openRouterSpecificProvider: "saved-provider" }, ["openRouterSpecificProvider"]],
		]
		for (const [provider, settings, expected] of examples) {
			expect(getUnsupportedCuratedProviderSettings(provider, settings)).toEqual(expected)
			expect(providerSettingsSchemaDiscriminated.parse({ apiProvider: provider, ...settings })).toEqual({
				apiProvider: provider,
				...settings,
			})
		}
	})

	it("accepts supported defaults without inheriting unrelated provider overrides", () => {
		expect(getUnsupportedCuratedProviderSettings("openai-native", { openAiNativeServiceTier: "default" })).toEqual(
			[],
		)
		expect(
			getUnsupportedCuratedProviderSettings("anthropic", {
				anthropicUseAuthToken: false,
				anthropicBeta1MContext: true,
			}),
		).toEqual([])
		expect(
			getUnsupportedCuratedProviderSettings("openrouter", {
				openRouterSpecificProvider: "  ",
				openRouterStreamingEnabled: false,
			}),
		).toEqual([])
		expect(
			getUnsupportedCuratedProviderSettings("xai", {
				openAiBaseUrl: "https://unrelated.example/v1",
				openAiUseAzure: true,
			}),
		).toEqual([])
	})
})
