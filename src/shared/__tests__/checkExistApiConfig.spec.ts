import type { ProviderSettings } from "@alpha-code/types"
import { checkExistKey } from "../checkExistApiConfig"

describe("checkExistKey", () => {
	it("rejects absent and unconfigured connections", () => {
		expect(checkExistKey(undefined)).toBe(false)
		expect(checkExistKey({})).toBe(false)
		expect(checkExistKey({ apiProvider: "openai", openAiApiKey: undefined })).toBe(false)
		expect(checkExistKey({ apiProvider: "openrouter" })).toBe(false)
	})

	it.each<ProviderSettings>([
		{ apiProvider: "openai", openAiApiKey: "test-key" },
		{ apiProvider: "openrouter", openRouterApiKey: "test-key" },
		{ apiProvider: "vertex", vertexProjectId: "test-project" },
		{ apiProvider: "vscode-lm", vsCodeLmModelSelector: { id: "test-model" } },
		{ apiProvider: "openai-codex", apiModelId: "gpt-6.1-sol" },
		{ apiProvider: "bedrock", awsRegion: "us-east-1" },
		{ apiProvider: "bedrock" },
		{ apiProvider: "meta", metaApiKey: "meta-key" },
		{
			apiProvider: "stellar",
			stellarBaseUrl: "https://gateway.example.com/stellar/v1",
			stellarPemCaBundlePath: "C:\\certs\\corp.pem",
		},
	])("recognizes configured supported provider $apiProvider", (config) => {
		expect(checkExistKey(config)).toBe(true)
	})

	it("allows the process-local scripted harness seam", () => {
		expect(checkExistKey({ apiProvider: "fake-ai" })).toBe(true)
	})

	it.each(["gemini-cli", "qwen-code"] as const)(
		"rejects retired %s even with unrelated credentials",
		(apiProvider) => {
			expect(checkExistKey({ apiProvider, openAiApiKey: "test-key" })).toBe(false)
		},
	)

	it("rejects an unsupported saved provider even with credentials", () => {
		const savedConfig = {
			apiProvider: "unsupported-provider",
			openRouterApiKey: "test-key",
		} as unknown as ProviderSettings
		expect(checkExistKey(savedConfig)).toBe(false)
	})
})
