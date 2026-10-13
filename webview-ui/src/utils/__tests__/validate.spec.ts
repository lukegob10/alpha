import { type OrganizationAllowList, type ProviderSettings, openAiModelInfoSaneDefaults } from "@alpha-code/types"

vi.mock("i18next", () => ({
	default: {
		t: (key: string) => key,
	},
}))

import {
	getModelValidationError,
	validateApiConfiguration,
	validateApiConfigurationExcludingModelErrors,
} from "../validate"

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

	it.each<[boolean | undefined, number, string | undefined]>([
		[true, 512, undefined],
		[true, -1, undefined],
		[true, 0, "settings:validation.outputTokenLimit"],
		[true, 1.5, "settings:validation.outputTokenLimit"],
		[true, -2, "settings:validation.outputTokenLimit"],
		[true, Number.POSITIVE_INFINITY, "settings:validation.outputTokenLimit"],
		[false, 0, undefined],
		[undefined, 0, undefined],
	])("validates the emitted cap when inclusion=%s and limit=%s", (includeMaxTokens, maxTokens, expected) => {
		const configuration: ProviderSettings = {
			apiProvider: "openai",
			openAiBaseUrl: "https://api.example.com/v1",
			openAiApiKey: "test-key",
			openAiModelId: "model-a",
			includeMaxTokens,
			openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens },
		}
		expect(validateApiConfigurationExcludingModelErrors(configuration, undefined, allowAll)).toBe(expected)
		expect(validateApiConfiguration(configuration, undefined, allowAll)).toBe(expected)
		expect(configuration.openAiCustomModelInfo?.maxTokens).toBe(maxTokens)
	})

	it("validates the effective override without rejecting an inert saved model cap", () => {
		const configuration: ProviderSettings = {
			apiProvider: "openai",
			openAiBaseUrl: "https://api.example.com/v1",
			openAiApiKey: "test-key",
			openAiModelId: "model-a",
			includeMaxTokens: true,
			openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 0 },
			modelMaxTokens: 256,
		}
		expect(validateApiConfigurationExcludingModelErrors(configuration, undefined, allowAll)).toBeUndefined()
		expect(
			validateApiConfigurationExcludingModelErrors({ ...configuration, modelMaxTokens: -1 }, undefined, allowAll),
		).toBeUndefined()
		expect(
			validateApiConfigurationExcludingModelErrors({ ...configuration, modelMaxTokens: 0 }, undefined, allowAll),
		).toBe("settings:validation.outputTokenLimit")
	})

	it.each<[boolean | undefined, number, string | undefined]>([
		[true, 15, "settings:validation.responsesOutputTokenLimit"],
		[true, 16, undefined],
		[false, 15, undefined],
		[undefined, 15, undefined],
	])("validates the Responses minimum only when inclusion=%s and cap=%s", (includeMaxTokens, maxTokens, expected) => {
		const configuration: ProviderSettings = {
			apiProvider: "openai",
			openAiBaseUrl: "https://api.openai.com/v1",
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.4",
			includeMaxTokens,
			openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens },
		}
		expect(validateApiConfigurationExcludingModelErrors(configuration, undefined, allowAll)).toBe(expected)
		expect(validateApiConfiguration(configuration, undefined, allowAll)).toBe(expected)
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
