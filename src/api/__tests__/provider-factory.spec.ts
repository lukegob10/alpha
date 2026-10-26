import { type ProviderSettings, retiredProviderNames, curatedProviders } from "@alpha-code/types"

vi.mock("../providers", () => ({
	VertexHandler: vi.fn(),
	AnthropicVertexHandler: vi.fn(),
	VertexOpenAiHandler: vi.fn(),
	OpenAiHandler: vi.fn(),
	OpenAiNativeHandler: vi.fn(),
	AnthropicHandler: vi.fn(),
	GeminiHandler: vi.fn(),
	XAIHandler: vi.fn(),
	OpenRouterHandler: vi.fn(),
	VsCodeLmHandler: vi.fn(),
	StellarHandler: vi.fn(),
}))

import { buildApiHandler } from "../index"
import {
	AnthropicVertexHandler,
	VertexHandler,
	VertexOpenAiHandler,
	OpenAiHandler,
	OpenAiNativeHandler,
	AnthropicHandler,
	GeminiHandler,
	XAIHandler,
	OpenRouterHandler,
	VsCodeLmHandler,
	StellarHandler,
} from "../providers"

describe("public provider factory", () => {
	it.each([...retiredProviderNames, "future-provider"])("rejects %s without falling back", (provider) => {
		expect(() => buildApiHandler({ apiProvider: provider as ProviderSettings["apiProvider"] })).toThrow(
			`Unsupported API provider: ${provider}`,
		)
	})

	it.each([
		[{ apiProvider: "vertex", apiModelId: "claude-sonnet-4" }, AnthropicVertexHandler],
		[{ apiProvider: "vertex", apiModelId: "gemini-2.5-pro" }, VertexHandler],
		[{ apiProvider: "vertex", apiModelId: "partner-model" }, VertexOpenAiHandler],
		[{ apiProvider: "openai" }, OpenAiHandler],
		[{ apiProvider: "openai-native" }, OpenAiNativeHandler],
		[{ apiProvider: "anthropic" }, AnthropicHandler],
		[{ apiProvider: "gemini" }, GeminiHandler],
		[{ apiProvider: "xai" }, XAIHandler],
		[{ apiProvider: "openrouter" }, OpenRouterHandler],
		[{ apiProvider: "vscode-lm" }, VsCodeLmHandler],
		[{ apiProvider: "stellar" }, StellarHandler],
	] as const)("routes the supported configuration %j", (configuration, Handler) => {
		expect(buildApiHandler(configuration)).toBeInstanceOf(Handler)
	})

	it("defaults only an absent provider to Vertex", () => {
		expect(buildApiHandler({})).toBeInstanceOf(AnthropicVertexHandler)
	})

	it.each(curatedProviders)("rejects an unknown saved %s model before constructing an adapter", (apiProvider) => {
		vi.clearAllMocks()
		expect(() => buildApiHandler({ apiProvider, apiModelId: "retired-or-unknown-model" })).toThrow(
			/Unsupported .* model/,
		)
		for (const Handler of [OpenAiNativeHandler, AnthropicHandler, GeminiHandler, XAIHandler, OpenRouterHandler]) {
			expect(Handler).not.toHaveBeenCalled()
		}
	})

	it.each([
		{ apiProvider: "openai-native", openAiNativeBaseUrl: "https://custom.example/v1" },
		{ apiProvider: "anthropic", anthropicUseAuthToken: true },
		{ apiProvider: "gemini", googleGeminiBaseUrl: "https://custom.example" },
		{ apiProvider: "openrouter", openRouterSpecificProvider: "unverified-route" },
	] as const)("rejects unsupported saved routing for $apiProvider", (settings) => {
		expect(() => buildApiHandler(settings)).toThrow(/Unsupported .* settings/)
	})
})
