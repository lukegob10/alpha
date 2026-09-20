import {
	getApiProtocol,
	MODELS_BY_PROVIDER,
	persistedProviderSettingsSchema,
	providerNames,
	providerSettingsSchemaDiscriminated,
} from "../provider-settings.js"
import { stellarDefaultModelId } from "../providers/stellar.js"

describe("supported provider settings", () => {
	it("exposes exactly the four public provider IDs", () => {
		expect(providerNames).toEqual(["vertex", "vscode-lm", "stellar", "openai"])
		expect(Object.keys(MODELS_BY_PROVIDER)).toEqual(["vertex", "stellar", "vscode-lm"])
	})

	it.each(["openrouter", "unknown-future-provider"])(
		"rejects %s in executable profiles while preserving saved data",
		(apiProvider) => {
			const saved = { apiProvider, legacyModelId: "saved-model" }
			expect(providerSettingsSchemaDiscriminated.safeParse(saved).success).toBe(false)
			expect(persistedProviderSettingsSchema.parse(saved)).toEqual(saved)
		},
	)

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
	it("uses Anthropic wire semantics only for Vertex Claude models", () => {
		expect(getApiProtocol("vertex", "claude-3-opus")).toBe("anthropic")
		expect(getApiProtocol("vertex", "Claude-3-Sonnet")).toBe("anthropic")
		expect(getApiProtocol("vertex", "gemini-3.7-flash")).toBe("openai")
		expect(getApiProtocol("vertex", "xai/grok-4.6")).toBe("openai")
	})

	it("uses OpenAI semantics for all other approved providers and missing settings", () => {
		expect(getApiProtocol("openai", "claude-3-sonnet")).toBe("openai")
		expect(getApiProtocol("stellar", "Meta-Llama-3.3-70B-Instruct")).toBe("openai")
		expect(getApiProtocol("vscode-lm")).toBe("openai")
		expect(getApiProtocol(undefined, "claude-3-opus")).toBe("openai")
	})
})
