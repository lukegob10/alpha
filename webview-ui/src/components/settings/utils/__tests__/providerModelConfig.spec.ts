import {
	PROVIDER_DEFAULT_MODEL_IDS,
	PROVIDER_SERVICE_CONFIG,
	PROVIDERS_WITH_CUSTOM_MODEL_UI,
	getDefaultModelIdForProvider,
	getProviderServiceConfig,
	getStaticModelsForProvider,
	isStaticModelProvider,
	shouldUseGenericModelPicker,
} from "../providerModelConfig"
import { curatedProviders, getProviderDefaultModelId, providerNames } from "@alpha-code/types"

describe("providerModelConfig", () => {
	it("contains service metadata for every public provider", () => {
		expect(Object.keys(PROVIDER_SERVICE_CONFIG).sort()).toEqual([...providerNames].sort())
		expect(getProviderServiceConfig("openai")).toEqual({
			serviceName: "OpenAI Compatible",
			serviceUrl: "https://platform.openai.com/docs",
		})
		expect(getProviderServiceConfig("vscode-lm").serviceUrl).toContain("language-model")
	})

	it("provides defaults and static catalogs for every curated provider", () => {
		expect(Object.keys(PROVIDER_DEFAULT_MODEL_IDS).sort()).toEqual(
			[...curatedProviders, "stellar", "vertex"].sort(),
		)
		expect(getDefaultModelIdForProvider("vertex")).toBe(PROVIDER_DEFAULT_MODEL_IDS.vertex)
		expect(getDefaultModelIdForProvider("stellar")).toBe(PROVIDER_DEFAULT_MODEL_IDS.stellar)
		expect(getStaticModelsForProvider("vertex")).not.toEqual({})
		expect(getStaticModelsForProvider("stellar")).not.toEqual({})
		expect(getStaticModelsForProvider("openai")).toEqual({})
		for (const provider of curatedProviders) {
			expect(getDefaultModelIdForProvider(provider)).toBe(getProviderDefaultModelId(provider))
			expect(getStaticModelsForProvider(provider)).toHaveProperty(getProviderDefaultModelId(provider))
			expect(shouldUseGenericModelPicker(provider)).toBe(true)
		}
	})

	it("uses custom model controls only for OpenAI Compatible and VS Code LM", () => {
		expect(PROVIDERS_WITH_CUSTOM_MODEL_UI).toEqual(["openai", "vscode-lm"])
		expect(shouldUseGenericModelPicker("vertex")).toBe(true)
		expect(shouldUseGenericModelPicker("stellar")).toBe(true)
		expect(shouldUseGenericModelPicker("openai")).toBe(false)
		expect(shouldUseGenericModelPicker("vscode-lm")).toBe(false)
	})

	it("returns an empty fallback for an unsupported saved provider", () => {
		expect(getProviderServiceConfig("future-provider" as never)).toEqual({
			serviceName: "future-provider",
			serviceUrl: "",
		})
		expect(getDefaultModelIdForProvider("future-provider" as never)).toBe("")
		expect(isStaticModelProvider("future-provider" as never)).toBe(false)
	})
})
