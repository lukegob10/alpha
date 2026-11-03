import type { ApiHandlerSingleCompletionMetadata } from "../../index"
import { OpenAiHandler } from "../openai"
import { VertexOpenAiHandler } from "../vertex-openai"

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn(function () {
		return { chat: { completions: { create: mocks.create } } }
	}),
	AzureOpenAI: vi.fn(function () {
		return { chat: { completions: { create: mocks.create } } }
	}),
}))

vi.mock("google-auth-library", () => ({
	GoogleAuth: vi.fn(function () {
		return { getAccessToken: vi.fn().mockResolvedValue("fixture-token") }
	}),
}))

const providers = [
	{ name: "OpenAI", create: () => new OpenAiHandler({ openAiModelId: "gpt-4.1" }) },
	{
		name: "Vertex OpenAI",
		create: () =>
			new VertexOpenAiHandler({
				apiModelId: "xai/grok-4.6",

				projectId: "fixture-project",
				location: "global",
			}),
	},
]

const answer = { choices: [{ message: { content: "enhanced prompt" }, finish_reason: "stop" }] }

beforeEach(() => {
	vi.clearAllMocks()

	mocks.create.mockResolvedValue(answer)
})

afterEach(() => vi.useRealTimers())

describe.each(providers)("$name single completion cancellation", ({ create }) => {
	it("rejects pre-cancellation before authentication or SDK dispatch with the original reason", async () => {
		const controller = new AbortController()
		const reason = Object.assign(new Error("fixture authentication cancelled"), { status: 401 })
		controller.abort(reason)

		await expect(create().completePrompt("Enhance", { signal: controller.signal })).rejects.toBe(reason)

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
