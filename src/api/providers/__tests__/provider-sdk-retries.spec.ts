import type { ApiHandler } from "../../index"
import { OpenAiHandler } from "../openai"
import { OpenAiNativeHandler } from "../openai-native"
import { OpenRouterHandler } from "../openrouter"
import { XAIHandler } from "../xai"
import { StellarHandler } from "../stellar"
import { VertexOpenAiHandler } from "../vertex-openai"

const { getToken, forceRefreshToken } = vi.hoisted(() => ({ getToken: vi.fn(), forceRefreshToken: vi.fn() }))

vi.mock("../utils/helix-token-manager", () => ({
	HelixTokenManager: { getOrCreate: () => ({ getToken, forceRefreshToken }) },
}))
vi.mock("../utils/vertex-gateway-transport", () => ({
	configurePemCaTransport: vi.fn().mockResolvedValue("fixture.pem"),
	configureVertexGatewayTransport: vi.fn().mockResolvedValue("fixture.pem"),
}))

const stellar = () =>
	new StellarHandler({
		stellarBaseUrl: "https://fixture.test/v1",
		stellarPemCaBundlePath: "fixture.pem",
		apiModelId: "fixture-model",
	})
const vertex = () =>
	new VertexOpenAiHandler({
		apiModelId: "xai/grok-4.6",
		gatewayBaseUrl: "https://fixture.test/v1",
		projectId: "fixture-project",
		location: "global",
		pemCaBundlePath: "fixture.pem",
		helixCommand: "fixture-token-command",
	})

async function consume(handler: ApiHandler) {
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "fixture" }])) {
		// Exercise the real SDK transport without making a network request.
	}
}

function errorResponse(status: number) {
	return new Response(JSON.stringify({ error: { message: "Fixture unavailable", type: "server_error" } }), {
		status,
		headers: { "content-type": "application/json", "retry-after-ms": "1" },
	})
}

describe("provider SDK retry ownership", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		getToken.mockResolvedValue("fixture-token")
		forceRefreshToken.mockResolvedValue("refreshed-fixture-token")
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	// The SDK retries HTTP 503 twice by default. Alpha's shared policy owns every
	// provider attempt instead: https://github.com/openai/openai-node#retries (2026-10-26).
	it.each([
		["compatible", () => new OpenAiHandler({ openAiApiKey: "fixture-key", openAiModelId: "fixture-model" })],
		[
			"Azure",
			() =>
				new OpenAiHandler({
					openAiApiKey: "fixture-key",
					openAiModelId: "fixture-model",
					openAiBaseUrl: "https://fixture.openai.azure.com",
				}),
		],
		[
			"Azure inference",
			() =>
				new OpenAiHandler({
					openAiApiKey: "fixture-key",
					openAiModelId: "fixture-model",
					openAiBaseUrl: "https://fixture.services.ai.azure.com",
				}),
		],
		["native OpenAI", () => new OpenAiNativeHandler({ openAiNativeApiKey: "fixture-key" })],
		["OpenRouter", () => new OpenRouterHandler({ openRouterApiKey: "fixture-key" })],
		["xAI", () => new XAIHandler({ xaiApiKey: "fixture-key" })],
		["Stellar", stellar],
		["Vertex compatible", vertex],
	] satisfies Array<[string, () => ApiHandler]>)(
		"makes one HTTP attempt per %s invocation",
		async (_name, create) => {
			const fetch = vi.fn().mockImplementation(async () => errorResponse(503))
			vi.stubGlobal("fetch", fetch)

			await expect(consume(create())).rejects.toMatchObject({ status: 503 })

			expect(fetch).toHaveBeenCalledOnce()
		},
	)

	it.each([
		["Stellar", stellar],
		["Vertex compatible", vertex],
	] satisfies Array<[string, () => ApiHandler]>)(
		"preserves the explicit %s credential-refresh retry",
		async (_name, create) => {
			const fetch = vi
				.fn()
				.mockImplementation(async () => errorResponse(503))
				.mockResolvedValueOnce(errorResponse(401))
			vi.stubGlobal("fetch", fetch)

			await expect(consume(create())).rejects.toMatchObject({ status: 503 })

			expect(forceRefreshToken).toHaveBeenCalledOnce()
			expect(fetch).toHaveBeenCalledTimes(2)
		},
	)
})
