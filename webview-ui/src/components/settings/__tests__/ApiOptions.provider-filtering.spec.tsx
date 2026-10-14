import { PROVIDERS } from "../constants"

describe("ApiOptions provider choices", () => {
	it("exposes exactly the supported public providers", () => {
		expect(PROVIDERS.map(({ value }) => value).sort()).toEqual(["openai", "stellar", "vertex", "vscode-lm"])
	})

	it("uses the product labels for the supported providers", () => {
		expect(PROVIDERS).toEqual([
			{ value: "vertex", label: "GCP Vertex AI", proxy: false },
			{ value: "openai", label: "OpenAI Compatible", proxy: true },
			{ value: "stellar", label: "Stellar", proxy: false },
			{ value: "vscode-lm", label: "VS Code LM API", proxy: false },
		])
	})
})
