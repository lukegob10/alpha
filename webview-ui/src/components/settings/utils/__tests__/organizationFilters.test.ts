import type { ModelInfo } from "@alpha-code/types"

import { filterModels, filterProviders } from "../organizationFilters"

describe("organizationFilters", () => {
	const providers = [
		{ value: "openai", label: "OpenAI Compatible" },
		{ value: "vertex", label: "GCP Vertex AI" },
		{ value: "vscode-lm", label: "VS Code LM API" },
		{ value: "stellar", label: "Stellar" },
	]
	const models: Record<string, ModelInfo> = {
		model1: { maxTokens: 8000 } as ModelInfo,
		model2: { maxTokens: 16000 } as ModelInfo,
	}

	it("keeps the approved provider choices intact", () => {
		expect(filterProviders(providers)).toEqual(providers)
	})

	it("keeps the supplied model catalog intact", () => {
		expect(filterModels(models, "vertex")).toEqual(models)
		expect(filterModels(null, "stellar")).toBeNull()
	})
})
