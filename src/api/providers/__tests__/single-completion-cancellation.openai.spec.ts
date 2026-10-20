import type { ApiHandlerSingleCompletionMetadata } from "../../index"
import { OpenAiHandler } from "../openai"
import { StellarHandler } from "../stellar"
import { VertexOpenAiHandler } from "../vertex-openai"

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	getToken: vi.fn(),
	forceRefreshToken: vi.fn(),
	configureTransport: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn(function () {
		return { chat: { completions: { create: mocks.create } } }
	}),
	AzureOpenAI: vi.fn(function () {
		return { chat: { completions: { create: mocks.create } } }
	}),
}))
vi.mock("../utils/helix-token-manager", () => ({
	HelixTokenManager: {
		getOrCreate: () => ({ getToken: mocks.getToken, forceRefreshToken: mocks.forceRefreshToken }),
	},
}))
vi.mock("../utils/vertex-gateway-transport", () => ({
	configurePemCaTransport: mocks.configureTransport,
	configureVertexGatewayTransport: mocks.configureTransport,
}))

const providers = [
	{ name: "OpenAI", create: () => new OpenAiHandler({ openAiModelId: "gpt-4.1" }) },
	{
		name: "Stellar",
		create: () =>
			new StellarHandler({
				stellarBaseUrl: "https://gateway.example.test/stellar/v1",
				stellarPemCaBundlePath: "fixture-gateway.pem",
			}),
	},
	{
		name: "Vertex OpenAI",
		create: () =>
			new VertexOpenAiHandler({
				apiModelId: "xai/grok-4.6",
				gatewayBaseUrl: "https://gateway.example.test/v1",
				projectId: "fixture-project",
				location: "global",
				pemCaBundlePath: "fixture-gateway.pem",
				helixCommand: "fixture-token-command",
			}),
	},
]

const answer = { choices: [{ message: { content: "enhanced prompt" }, finish_reason: "stop" }] }

beforeEach(() => {
	vi.clearAllMocks()
	mocks.configureTransport.mockResolvedValue("fixture-gateway.pem")
	mocks.getToken.mockResolvedValue("fixture-access-token")
	mocks.forceRefreshToken.mockResolvedValue("fixture-refreshed-token")
	mocks.create.mockResolvedValue(answer)
})

afterEach(() => vi.useRealTimers())

describe.each(providers)("$name single completion cancellation", ({ create }) => {
	it("rejects pre-cancellation before authentication or SDK dispatch with the original reason", async () => {
		const controller = new AbortController()
		const reason = Object.assign(new Error("fixture authentication cancelled"), { status: 401 })
		controller.abort(reason)

		await expect(create().completePrompt("Enhance", { signal: controller.signal })).rejects.toBe(reason)
		expect(mocks.configureTransport).not.toHaveBeenCalled()
		expect(mocks.getToken).not.toHaveBeenCalled()
		expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it("passes the caller signal to the native SDK request", async () => {
		const controller = new AbortController()

		await expect(create().completePrompt("Enhance", { signal: controller.signal })).resolves.toBe("enhanced prompt")
		expect(mocks.create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal })
	})

	it("settles a stalled SDK request on abort and ignores a late response", async () => {
		vi.useFakeTimers()
		let resolveResponse!: (response: typeof answer) => void
		mocks.create.mockImplementationOnce(() => new Promise<typeof answer>((resolve) => (resolveResponse = resolve)))
		const controller = new AbortController()
		const reason = Object.assign(new Error("fixture authentication cancelled during SDK request"), { status: 401 })
		const handler = create()
		const observed = vi.fn()
		void handler.completePrompt("Enhance", { signal: controller.signal }).then(observed, observed)
		await vi.advanceTimersByTimeAsync(0)
		expect(mocks.create).toHaveBeenCalledOnce()

		controller.abort(reason)
		await vi.advanceTimersByTimeAsync(0)
		expect(observed).toHaveBeenCalledExactlyOnceWith(reason)
		expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
		resolveResponse(answer)
		await vi.advanceTimersByTimeAsync(0)
		expect(observed).toHaveBeenCalledOnce()
		await expect(handler.completePrompt("Next request")).resolves.toBe("enhanced prompt")
	})

	it("rejects an abort that races the SDK response without publishing the late text", async () => {
		const controller = new AbortController()
		const reason = "fixture caller no longer needs the enhancement"
		mocks.create.mockImplementationOnce(() => {
			controller.abort(reason)
			return Promise.resolve(answer)
		})

		await expect(create().completePrompt("Enhance", { signal: controller.signal })).rejects.toBe(reason)
		expect(mocks.create).toHaveBeenCalledOnce()
		expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
	})
})

describe.each(providers.slice(1))("$name credential preparation cancellation", ({ create }) => {
	it.each(["certificate", "token"] as const)(
		"stops waiting for stalled %s setup and never dispatches after cancellation",
		async (phase) => {
			vi.useFakeTimers()
			let resolvePreparation!: (value: string) => void
			const stalledPreparation = new Promise<string>((resolve) => (resolvePreparation = resolve))
			const preparation = phase === "certificate" ? mocks.configureTransport : mocks.getToken
			preparation.mockReturnValueOnce(stalledPreparation)
			const controller = new AbortController()
			const reason = new Error("fixture enhancement replaced during preparation")
			const metadata: ApiHandlerSingleCompletionMetadata = { signal: controller.signal }
			const handler = create()
			const observed = vi.fn()
			void handler.completePrompt("Enhance", metadata).then(observed, observed)
			await vi.advanceTimersByTimeAsync(0)
			expect(preparation).toHaveBeenCalledOnce()

			controller.abort(reason)
			await vi.advanceTimersByTimeAsync(0)
			expect(observed).toHaveBeenCalledExactlyOnceWith(reason)
			resolvePreparation(phase === "certificate" ? "fixture-gateway.pem" : "fixture-access-token")
			await vi.advanceTimersByTimeAsync(0)
			expect(mocks.create).not.toHaveBeenCalled()
			if (phase === "certificate") expect(mocks.getToken).not.toHaveBeenCalled()

			await expect(handler.completePrompt("Next request")).resolves.toBe("enhanced prompt")
			expect(mocks.configureTransport).toHaveBeenCalledOnce()
			expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
		},
	)

	it("does not poison a shared certificate setup when one caller cancels", async () => {
		vi.useFakeTimers()
		let resolvePreparation!: (value: string) => void
		mocks.configureTransport.mockImplementationOnce(
			() => new Promise<string>((resolve) => (resolvePreparation = resolve)),
		)
		const controller = new AbortController()
		const reason = new Error("fixture first caller cancelled")
		const handler = create()
		const cancelled = vi.fn()
		const active = vi.fn()
		void handler.completePrompt("First", { signal: controller.signal }).then(cancelled, cancelled)
		void handler.completePrompt("Second").then(active, active)
		await vi.advanceTimersByTimeAsync(0)
		expect(mocks.configureTransport).toHaveBeenCalledOnce()

		controller.abort(reason)
		await vi.advanceTimersByTimeAsync(0)
		expect(cancelled).toHaveBeenCalledExactlyOnceWith(reason)
		expect(active).not.toHaveBeenCalled()
		resolvePreparation("fixture-gateway.pem")
		await vi.advanceTimersByTimeAsync(0)
		expect(active).toHaveBeenCalledExactlyOnceWith("enhanced prompt")
		expect(mocks.configureTransport).toHaveBeenCalledOnce()
		expect(mocks.create).toHaveBeenCalledOnce()
	})

	it("evicts an actual certificate failure even after its waiting caller cancelled", async () => {
		vi.useFakeTimers()
		let rejectPreparation!: (reason: Error) => void
		mocks.configureTransport.mockImplementationOnce(
			() => new Promise<string>((_resolve, reject) => (rejectPreparation = reject)),
		)
		const controller = new AbortController()
		const reason = new Error("fixture caller cancelled before certificate failure")
		const handler = create()
		const observed = vi.fn()
		void handler.completePrompt("First", { signal: controller.signal }).then(observed, observed)
		await vi.advanceTimersByTimeAsync(0)
		controller.abort(reason)
		await vi.advanceTimersByTimeAsync(0)
		expect(observed).toHaveBeenCalledExactlyOnceWith(reason)

		rejectPreparation(new Error("fixture certificate unavailable"))
		await vi.advanceTimersByTimeAsync(0)
		await expect(handler.completePrompt("Retry after repair")).resolves.toBe("enhanced prompt")
		expect(mocks.configureTransport).toHaveBeenCalledTimes(2)
		expect(mocks.create).toHaveBeenCalledOnce()
	})

	it("does not retry dispatch after cancellation during authentication refresh", async () => {
		vi.useFakeTimers()
		let resolveRefresh!: (value: string) => void
		mocks.forceRefreshToken.mockImplementationOnce(
			() => new Promise<string>((resolve) => (resolveRefresh = resolve)),
		)
		mocks.create.mockRejectedValueOnce(Object.assign(new Error("fixture unauthorized"), { status: 401 }))
		const controller = new AbortController()
		const reason = new Error("fixture cancelled during authentication refresh")
		const observed = vi.fn()
		void create().completePrompt("Enhance", { signal: controller.signal }).then(observed, observed)
		await vi.advanceTimersByTimeAsync(0)
		expect(mocks.forceRefreshToken).toHaveBeenCalledOnce()

		controller.abort(reason)
		await vi.advanceTimersByTimeAsync(0)
		expect(observed).toHaveBeenCalledExactlyOnceWith(reason)
		resolveRefresh("fixture-refreshed-token")
		await vi.advanceTimersByTimeAsync(0)
		expect(mocks.create).toHaveBeenCalledOnce()
		expect(mocks.forceRefreshToken).toHaveBeenCalledOnce()
	})
})

it("retains the Azure AI Inference path while supplying SDK cancellation", async () => {
	const controller = new AbortController()
	const handler = new OpenAiHandler({
		openAiBaseUrl: "https://fixture.services.ai.azure.com",
		openAiModelId: "deepseek-v3",
	})

	await expect(handler.completePrompt("Enhance", { signal: controller.signal })).resolves.toBe("enhanced prompt")
	expect(mocks.create).toHaveBeenCalledWith(expect.any(Object), {
		path: "/models/chat/completions",
		signal: controller.signal,
	})
})
