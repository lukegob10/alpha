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

describe("providerModelConfig", () => {
	it("contains service metadata for every public provider", () => {
		expect(Object.keys(PROVIDER_SERVICE_CONFIG).sort()).toEqual(["openai", "stellar", "vertex", "vscode-lm"])
		expect(getProviderServiceConfig("openai")).toEqual({
			serviceName: "OpenAI Compatible",
			serviceUrl: "https://platform.openai.com/docs",
		})
		expect(getProviderServiceConfig("vscode-lm").serviceUrl).toContain("language-model")
	})

	it("keeps defaults and static catalogs limited to Vertex and Stellar", () => {
		expect(Object.keys(PROVIDER_DEFAULT_MODEL_IDS).sort()).toEqual(["stellar", "vertex"])
		expect(getDefaultModelIdForProvider("vertex")).toBe(PROVIDER_DEFAULT_MODEL_IDS.vertex)
		expect(getDefaultModelIdForProvider("stellar")).toBe(PROVIDER_DEFAULT_MODEL_IDS.stellar)
		expect(getStaticModelsForProvider("vertex")).not.toEqual({})
		expect(getStaticModelsForProvider("stellar")).not.toEqual({})
		expect(getStaticModelsForProvider("openai")).toEqual({})
	})

	it("uses custom model controls only for OpenAI Compatible and VS Code LM", () => {
		expect(PROVIDERS_WITH_CUSTOM_MODEL_UI).toEqual(["openai", "vscode-lm"])
		expect(shouldUseGenericModelPicker("vertex")).toBe(true)
		expect(shouldUseGenericModelPicker("stellar")).toBe(true)
		expect(shouldUseGenericModelPicker("openai")).toBe(false)
		expect(shouldUseGenericModelPicker("vscode-lm")).toBe(false)
	})

	it("returns an empty fallback for an unsupported saved provider", () => {
		expect(getProviderServiceConfig("openrouter" as never)).toEqual({ serviceName: "openrouter", serviceUrl: "" })
		expect(getDefaultModelIdForProvider("openrouter" as never)).toBe("")
		expect(isStaticModelProvider("openrouter" as never)).toBe(false)
	})
})
