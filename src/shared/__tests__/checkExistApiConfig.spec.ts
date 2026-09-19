import type { ProviderSettings } from "@alpha-code/types"
import { checkExistKey } from "../checkExistApiConfig"

describe("checkExistKey", () => {
	it("rejects absent and unconfigured connections", () => {
		expect(checkExistKey(undefined)).toBe(false)
		expect(checkExistKey({})).toBe(false)
		expect(checkExistKey({ apiProvider: "openai", openAiApiKey: undefined })).toBe(false)
	})

	it.each<ProviderSettings>([
		{ apiProvider: "openai", openAiApiKey: "test-key" },
		{ apiProvider: "vertex", vertexProjectId: "test-project" },
		{ apiProvider: "vscode-lm", vsCodeLmModelSelector: { id: "test-model" } },
		{
			apiProvider: "stellar",
			stellarBaseUrl: "https://gateway.example.com/stellar/v1",
			stellarPemCaBundlePath: "C:\\certs\\corp.pem",
		},
	])("recognizes configured retained provider $apiProvider", (config) => {
		expect(checkExistKey(config)).toBe(true)
	})

	it("allows the process-local scripted harness seam", () => {
		expect(checkExistKey({ apiProvider: "fake-ai" })).toBe(true)
	})

	it.each(["openai-codex", "qwen-code", "openrouter"] as const)(
		"rejects retired %s even with unrelated credentials",
		(apiProvider) => {
			expect(checkExistKey({ apiProvider, openAiApiKey: "test-key" })).toBe(false)
		},
	)
})
