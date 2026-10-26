import { PROVIDERS } from "../constants"

describe("ApiOptions provider choices", () => {
	it("exposes exactly the supported public providers", () => {
		expect(PROVIDERS.map(({ value }) => value).sort()).toEqual([
			"anthropic",
			"gemini",
			"openai",
			"openai-native",
			"openrouter",
			"stellar",
			"vertex",
			"vscode-lm",
			"xai",
		])
	})

	it("uses the product labels for the supported providers", () => {
		expect(PROVIDERS).toEqual([
			{ value: "anthropic", label: "Anthropic", proxy: false },
			{ value: "vertex", label: "GCP Vertex AI", proxy: false },
			{ value: "gemini", label: "Google Gemini", proxy: false },
			{ value: "openai-native", label: "OpenAI", proxy: false },
			{ value: "openai", label: "OpenAI Compatible", proxy: true },
			{ value: "openrouter", label: "OpenRouter", proxy: true },
			{ value: "stellar", label: "Stellar", proxy: false },
			{ value: "vscode-lm", label: "VS Code LM API", proxy: false },
			{ value: "xai", label: "xAI", proxy: false },
		])
	})
})
