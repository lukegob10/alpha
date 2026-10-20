import { StellarHandler } from "../stellar"
import { VertexHandler } from "../vertex"

const mocks = vi.hoisted(() => ({
	configureTransport: vi.fn(),
	getToken: vi.fn(),
	forceRefreshToken: vi.fn(),
	openAiCreate: vi.fn(),
	geminiStream: vi.fn(),
	geminiResponse: vi.fn(),
}))

vi.mock("../utils/vertex-gateway-transport", () => ({
	configurePemCaTransport: mocks.configureTransport,
	configureVertexGatewayTransport: mocks.configureTransport,
}))
vi.mock("../utils/helix-token-manager", () => ({
	HelixTokenManager: {
		getOrCreate: () => ({ getToken: mocks.getToken, forceRefreshToken: mocks.forceRefreshToken }),
	},
}))
vi.mock("openai", () => ({
	default: vi.fn(function () {
		return { chat: { completions: { create: mocks.openAiCreate } } }
	}),
	AzureOpenAI: vi.fn(),
}))
vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@google/genai")>()),
	GoogleGenAI: vi.fn(function () {
		return { models: { generateContentStream: mocks.geminiStream, generateContent: mocks.geminiResponse } }
	}),
}))

type Surface = "stream" | "response" | "single-prompt"
type GatewayHandler = StellarHandler | VertexHandler

const providers = [
	{
		name: "Stellar",
		create: (surface: Surface) =>
			new StellarHandler({
				stellarBaseUrl: "https://gateway.example.test/stellar/v1",
				stellarPemCaBundlePath: "fixture-gateway.pem",
				stellarStreamingEnabled: surface === "stream",
			}),
	},
	{
		name: "Vertex Gemini",
		create: (surface: Surface) =>
			new VertexHandler({
				apiModelId: "gemini-3.5-flash",
				vertexProjectId: "fixture-project",
				vertexRegion: "global",
				vertexGatewayBaseUrl: "https://gateway.example.test/vertex",
				vertexGatewayCaBundlePath: "fixture-gateway.pem",
				vertexGatewayHelixCommand: "fixture-token-command",
				vertexStreamingEnabled: surface === "stream",
			}),
	},
]

async function request(handler: GatewayHandler, surface: Surface): Promise<string> {
	if (surface === "single-prompt") return handler.completePrompt("hello")
	let text = ""
	for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
		if (chunk.type === "text") text += chunk.text
	}
	return text
}

beforeEach(() => {
	vi.resetAllMocks()
	mocks.configureTransport.mockResolvedValue("fixture-gateway.pem")
	mocks.getToken.mockResolvedValue("fixture-access-token")
	mocks.forceRefreshToken.mockResolvedValue("fixture-refreshed-token")
	mocks.openAiCreate.mockImplementation(async ({ stream }: { stream?: boolean }) => {
		if (stream) {
			return {
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }
				},
			}
		}
		return { choices: [{ message: { content: "answer" }, finish_reason: "stop" }] }
	})
	const geminiResponse = {
		text: "answer",
		candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
	}
	mocks.geminiResponse.mockResolvedValue(geminiResponse)
	mocks.geminiStream.mockResolvedValue({
		async *[Symbol.asyncIterator]() {
			yield geminiResponse
		},
	})
})

describe.each(providers)("$name gateway setup", ({ create }) => {
	it.each<Surface>(["stream", "response", "single-prompt"])(
		"retries a failed setup on the next %s request and retains the successful setup",
		async (surface) => {
			mocks.configureTransport.mockRejectedValueOnce(new Error("fixture PEM temporarily unavailable"))
			const handler = create(surface)

			await expect(request(handler, surface)).rejects.toThrow("fixture PEM temporarily unavailable")
			expect(mocks.getToken).not.toHaveBeenCalled()
			expect(mocks.openAiCreate).not.toHaveBeenCalled()
			expect(mocks.geminiStream).not.toHaveBeenCalled()
			expect(mocks.geminiResponse).not.toHaveBeenCalled()
			expect(mocks.configureTransport).toHaveBeenCalledTimes(1)

			await expect(request(handler, surface)).resolves.toBe("answer")
			await expect(request(handler, surface)).resolves.toBe("answer")
			expect(mocks.configureTransport).toHaveBeenCalledTimes(2)
			expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
		},
	)

	it("shares concurrent failed setup and allows one shared setup on the next requests", async () => {
		let rejectSetup!: (error: Error) => void
		mocks.configureTransport.mockImplementationOnce(
			() => new Promise<string>((_resolve, reject) => (rejectSetup = reject)),
		)
		const handler = create("single-prompt")
		const pendingRequests = Promise.allSettled([
			request(handler, "single-prompt"),
			request(handler, "single-prompt"),
		])
		expect(mocks.configureTransport).toHaveBeenCalledTimes(1)
		rejectSetup(new Error("fixture shared setup failure"))
		const failed = await pendingRequests
		expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"])

		await expect(
			Promise.all([request(handler, "single-prompt"), request(handler, "single-prompt")]),
		).resolves.toEqual(["answer", "answer"])
		expect(mocks.configureTransport).toHaveBeenCalledTimes(2)
	})
})
