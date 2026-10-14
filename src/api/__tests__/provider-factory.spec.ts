import { type ProviderSettings, retiredProviderNames } from "@alpha-code/types"

vi.mock("../providers", () => ({
	VertexHandler: vi.fn(),
	AnthropicVertexHandler: vi.fn(),
	VertexOpenAiHandler: vi.fn(),
	OpenAiHandler: vi.fn(),
	VsCodeLmHandler: vi.fn(),
	StellarHandler: vi.fn(),
}))

import { buildApiHandler } from "../index"
import {
	AnthropicVertexHandler,
	VertexHandler,
	VertexOpenAiHandler,
	OpenAiHandler,
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
		[{ apiProvider: "vscode-lm" }, VsCodeLmHandler],
		[{ apiProvider: "stellar" }, StellarHandler],
	] as const)("routes the supported configuration %j", (configuration, Handler) => {
		expect(buildApiHandler(configuration)).toBeInstanceOf(Handler)
	})

	it("defaults only an absent provider to Vertex", () => {
		expect(buildApiHandler({})).toBeInstanceOf(AnthropicVertexHandler)
	})
})
