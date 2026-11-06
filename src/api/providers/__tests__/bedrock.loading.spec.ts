import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = {
	tokenModuleLoad: vi.fn(),
	credentialModuleLoad: vi.fn(),
	tokenProvider: vi.fn(),
	token: vi.fn(),
	fromIni: vi.fn(),
	defaultChain: vi.fn(),
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => (resolve = settle))
	return { promise, resolve }
}

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	mocks.token.mockResolvedValue("generated-bedrock-token")
	mocks.tokenProvider.mockReturnValue(mocks.token)
	mocks.fromIni.mockReturnValue(vi.fn())
	mocks.defaultChain.mockReturnValue(vi.fn())
	vi.doMock("@aws/bedrock-token-generator", () => {
		mocks.tokenModuleLoad()
		return { getTokenProvider: mocks.tokenProvider }
	})
	vi.doMock("@aws-sdk/credential-providers", () => {
		mocks.credentialModuleLoad()
		return { fromIni: mocks.fromIni, fromNodeProviderChain: mocks.defaultChain }
	})
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("Done")))
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.doUnmock("@aws/bedrock-token-generator")
	vi.doUnmock("@aws-sdk/credential-providers")
})

it("loads no AWS credential modules when importing the adapter or inspecting model capabilities", async () => {
	const { buildBedrockHandler } = await import("../bedrock")
	const handler = buildBedrockHandler({})
	expect(handler.getModel().id).toBeTypeOf("string")
	expect(mocks.tokenModuleLoad).not.toHaveBeenCalled()
	expect(mocks.credentialModuleLoad).not.toHaveBeenCalled()
})

it("loads no AWS credential modules for API-key authentication", async () => {
	const { createBedrockFetch } = await import("../bedrock")
	const bedrockFetch = createBedrockFetch({ awsUseApiKey: true, awsApiKey: " bedrock-key " }, "us-east-1")
	await bedrockFetch("https://bedrock.example.test", {
		headers: { "x-api-key": "other-key", "openai-organization": "other-org", "openai-project": "other-project" },
	})
	expect(mocks.tokenModuleLoad).not.toHaveBeenCalled()
	expect(mocks.credentialModuleLoad).not.toHaveBeenCalled()
	expect(mocks.tokenProvider).not.toHaveBeenCalled()
	const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers)
	expect(headers.get("authorization")).toBe("Bearer bedrock-key")
	expect(headers.has("x-api-key")).toBe(false)
	expect(headers.has("openai-organization")).toBe(false)
	expect(headers.has("openai-project")).toBe(false)
})

it("rejects an already cancelled request without loading credential modules", async () => {
	const { createBedrockFetch } = await import("../bedrock")
	const controller = new AbortController()
	const reason = new Error("cancel before authentication")
	controller.abort(reason)
	await expect(
		createBedrockFetch({}, "us-east-1")("https://bedrock.example.test", { signal: controller.signal }),
	).rejects.toBe(reason)
	expect(mocks.tokenModuleLoad).not.toHaveBeenCalled()
	expect(mocks.credentialModuleLoad).not.toHaveBeenCalled()
	expect(fetch).not.toHaveBeenCalled()
})

it("initializes credential modules and a connection's provider once for concurrent first requests", async () => {
	const { createBedrockFetch } = await import("../bedrock")
	const loading = deferred()
	const entered = deferred()
	vi.doMock("@aws/bedrock-token-generator", async () => {
		mocks.tokenModuleLoad()
		entered.resolve()
		await loading.promise
		return { getTokenProvider: mocks.tokenProvider }
	})
	const bedrockFetch = createBedrockFetch({}, "us-east-1")
	const first = bedrockFetch("https://bedrock.example.test")
	const second = bedrockFetch("https://bedrock.example.test")
	await entered.promise
	expect(mocks.tokenProvider).not.toHaveBeenCalled()
	loading.resolve()
	await Promise.all([first, second])
	expect(mocks.tokenModuleLoad).toHaveBeenCalledOnce()
	expect(mocks.credentialModuleLoad).toHaveBeenCalledOnce()
	expect(mocks.defaultChain).toHaveBeenCalledOnce()
	expect(mocks.tokenProvider).toHaveBeenCalledOnce()
	expect(mocks.token).toHaveBeenCalledTimes(2)
	expect(fetch).toHaveBeenCalledTimes(2)
})

it("cancels module loading promptly without blocking another request or starting cancelled authentication", async () => {
	const { createBedrockFetch } = await import("../bedrock")
	const loading = deferred()
	const entered = deferred()
	vi.doMock("@aws/bedrock-token-generator", async () => {
		mocks.tokenModuleLoad()
		entered.resolve()
		await loading.promise
		return { getTokenProvider: mocks.tokenProvider }
	})
	const bedrockFetch = createBedrockFetch({}, "us-east-1")
	const controller = new AbortController()
	const cancelled = bedrockFetch("https://bedrock.example.test", { signal: controller.signal })
	const active = bedrockFetch("https://bedrock.example.test")
	await entered.promise
	const reason = new Error("cancel dependency loading")
	controller.abort(reason)
	await expect(cancelled).rejects.toBe(reason)
	expect(mocks.tokenProvider).not.toHaveBeenCalled()
	expect(fetch).not.toHaveBeenCalled()
	loading.resolve()
	await active
	expect(mocks.tokenProvider).toHaveBeenCalledOnce()
	expect(mocks.token).toHaveBeenCalledOnce()
	expect(fetch).toHaveBeenCalledOnce()
})

it("rejects a late cancellation after dependency loading before initializing credentials", async () => {
	const { createBedrockFetch } = await import("../bedrock")
	const controller = new AbortController()
	const reason = new Error("cancel after dependency wait")
	const throwIfAborted = controller.signal.throwIfAborted.bind(controller.signal)
	let cancellationChecks = 0
	vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
		throwIfAborted()
		if (++cancellationChecks === 2) queueMicrotask(() => controller.abort(reason))
	})
	await expect(
		createBedrockFetch({}, "us-east-1")("https://bedrock.example.test", { signal: controller.signal }),
	).rejects.toBe(reason)
	expect(mocks.tokenModuleLoad).toHaveBeenCalledOnce()
	expect(mocks.credentialModuleLoad).toHaveBeenCalledOnce()
	expect(mocks.fromIni).not.toHaveBeenCalled()
	expect(mocks.defaultChain).not.toHaveBeenCalled()
	expect(mocks.tokenProvider).not.toHaveBeenCalled()
	expect(mocks.token).not.toHaveBeenCalled()
	expect(fetch).not.toHaveBeenCalled()
})

it("retries dependency loading when an unavailable credential module becomes available", async () => {
	const { createBedrockFetch } = await import("../bedrock")
	vi.doMock("@aws/bedrock-token-generator", () => {
		mocks.tokenModuleLoad()
		throw new Error("credential dependency unavailable")
	})
	const bedrockFetch = createBedrockFetch({}, "us-east-1")
	await expect(bedrockFetch("https://bedrock.example.test")).rejects.toThrow()
	expect(mocks.tokenProvider).not.toHaveBeenCalled()
	expect(fetch).not.toHaveBeenCalled()
	vi.doMock("@aws/bedrock-token-generator", () => {
		mocks.tokenModuleLoad()
		return { getTokenProvider: mocks.tokenProvider }
	})
	await bedrockFetch("https://bedrock.example.test")
	expect(mocks.tokenModuleLoad).toHaveBeenCalledTimes(2)
	expect(mocks.tokenProvider).toHaveBeenCalledOnce()
	expect(fetch).toHaveBeenCalledOnce()
})

it("retries provider initialization after a failure without retaining a rejected initialization", async () => {
	const { createBedrockFetch } = await import("../bedrock")
	const failure = new Error("credential provider initialization failed")
	mocks.tokenProvider.mockImplementationOnce(() => {
		throw failure
	})
	const bedrockFetch = createBedrockFetch({}, "us-east-1")
	await expect(bedrockFetch("https://bedrock.example.test")).rejects.toBe(failure)
	expect(fetch).not.toHaveBeenCalled()
	await bedrockFetch("https://bedrock.example.test")
	expect(mocks.tokenModuleLoad).toHaveBeenCalledOnce()
	expect(mocks.credentialModuleLoad).toHaveBeenCalledOnce()
	expect(mocks.tokenProvider).toHaveBeenCalledTimes(2)
	expect(fetch).toHaveBeenCalledOnce()
})
