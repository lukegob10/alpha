import type { OrganizationAllowList, ProviderSettings } from "@alpha-code/types"

vi.mock("i18next", () => ({
	default: {
		t: (key: string) => key,
	},
}))

import { getModelValidationError, validateApiConfigurationExcludingModelErrors } from "../validate"

describe("provider configuration validation", () => {
	const allowAll: OrganizationAllowList = { allowAll: true, providers: {} }

	it("accepts a complete OpenAI Compatible configuration", () => {
		const configuration: ProviderSettings = {
			apiProvider: "openai",
			openAiBaseUrl: "https://api.example.com/v1",
			openAiApiKey: "test-key",
			openAiModelId: "model-a",
		}

		expect(validateApiConfigurationExcludingModelErrors(configuration, undefined, allowAll)).toBeUndefined()
		expect(getModelValidationError(configuration, undefined, allowAll)).toBeUndefined()
	})

	it("requires the OpenAI Compatible base URL, key, and model", () => {
		expect(
			validateApiConfigurationExcludingModelErrors(
				{ apiProvider: "openai", openAiApiKey: "test-key" },
				undefined,
				allowAll,
			),
		).toBe("settings:validation.openAi")
	})

	it("validates Vertex project and location plus optional gateway settings", () => {
		expect(validateApiConfigurationExcludingModelErrors({ apiProvider: "vertex" }, undefined, allowAll)).toBe(
			"settings:validation.googleCloud",
		)
		expect(
			validateApiConfigurationExcludingModelErrors(
				{ apiProvider: "vertex", projectId: "project", location: "global" },
				undefined,
				allowAll,
			),
		).toBeUndefined()
		expect(
			validateApiConfigurationExcludingModelErrors(
				{
					apiProvider: "vertex",
					projectId: "project",
					location: "global",
					gatewayBaseUrl: "https://gateway.example.com",
				},
				undefined,
				allowAll,
			),
		).toBe("settings:validation.vertexGateway")
	})

	it("validates Stellar URL and certificate settings", () => {
		expect(
			validateApiConfigurationExcludingModelErrors(
				{ apiProvider: "stellar", stellarBaseUrl: "not-a-url", stellarPemCaBundlePath: "cert.pem" },
				undefined,
				allowAll,
			),
		).toBe("settings:validation.stellar")
		expect(
			validateApiConfigurationExcludingModelErrors(
				{
					apiProvider: "stellar",
					stellarBaseUrl: "https://gateway.example.com/v1",
					stellarPemCaBundlePath: "cert.pem",
				},
				undefined,
				allowAll,
			),
		).toBeUndefined()
	})

	it("requires a VS Code LM selector", () => {
		expect(validateApiConfigurationExcludingModelErrors({ apiProvider: "vscode-lm" }, undefined, allowAll)).toBe(
			"settings:validation.modelSelector",
		)
		expect(
			validateApiConfigurationExcludingModelErrors(
				{ apiProvider: "vscode-lm", vsCodeLmModelSelector: { vendor: "test", id: "model" } },
				undefined,
				allowAll,
			),
		).toBeUndefined()
	})

	it("reports an explicit unsupported-provider error without rewriting the saved ID", () => {
		const configuration = {
			apiProvider: "openrouter",
			openRouterModelId: "legacy-model",
		} as unknown as ProviderSettings
		expect(validateApiConfigurationExcludingModelErrors(configuration, undefined, allowAll)).toBe(
			"settings:providers.retiredProviderMessage",
		)
	})
})
