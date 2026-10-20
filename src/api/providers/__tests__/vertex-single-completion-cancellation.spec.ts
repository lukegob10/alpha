import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { SingleCompletionHandler } from "../../index"
import { AnthropicVertexHandler } from "../anthropic-vertex"
import { VertexHandler } from "../vertex"

const mocks = vi.hoisted(() => ({
	configureTransport: vi.fn(),
	getToken: vi.fn(),
	forceRefreshToken: vi.fn(),
	geminiRequest: vi.fn(),
	anthropicRequest: vi.fn(),
	requestTimeout: vi.fn(() => 600),
}))

vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: mocks.requestTimeout }) },
}))
vi.mock("../utils/vertex-gateway-transport", () => ({
	configureVertexGatewayTransport: mocks.configureTransport,
}))
vi.mock("../utils/helix-token-manager", () => ({
	HelixTokenManager: {
		getOrCreate: () => ({ getToken: mocks.getToken, forceRefreshToken: mocks.forceRefreshToken }),
	},
}))
vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@google/genai")>()),
	GoogleGenAI: vi.fn(function () {
		return { models: { generateContent: mocks.geminiRequest } }
	}),
}))
vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(function () {
		return { messages: { create: mocks.anthropicRequest } }
	}),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function observe(promise: Promise<string>) {
	let result: { status: "fulfilled"; value: string } | { status: "rejected"; reason: unknown } | undefined
	return {
		promise: promise.then(
			(value) => {
				result = { status: "fulfilled", value }
			},
			(reason: unknown) => {
				result = { status: "rejected", reason }
			},
		),
		get result() {
			return result
		},
	}
}

const gatewayOptions = {
	vertexProjectId: "fixture-project",
	vertexRegion: "global",
	vertexGatewayBaseUrl: "https://gateway.example.test/vertex",
	vertexGatewayCaBundlePath: "fixture-gateway.pem",
	vertexGatewayHelixCommand: "fixture-token-command",
}

const providers = [
	{
		name: "Vertex Gemini",
		create: (gateway: boolean): SingleCompletionHandler =>
			new VertexHandler({
				...(gateway ? gatewayOptions : {}),
				apiModelId: "gemini-3.7-flash",
			}),
		request: mocks.geminiRequest,
		response: { text: "answer" },
		signal: (request: Mock): AbortSignal | undefined => request.mock.calls[0]?.[0]?.config?.abortSignal,
	},
	{
		name: "Vertex Anthropic",
		create: (gateway: boolean): SingleCompletionHandler =>
			new AnthropicVertexHandler({
				...(gateway ? gatewayOptions : {}),
				apiModelId: "claude-sonnet-4-6",
			}),
		request: mocks.anthropicRequest,
		response: { content: [{ type: "text", text: "answer" }] },
		signal: (request: Mock): AbortSignal | undefined => request.mock.calls[0]?.[1]?.signal,
	},
]

beforeEach(() => {
	vi.useFakeTimers()
	vi.resetAllMocks()
	mocks.requestTimeout.mockReturnValue(600)
	mocks.configureTransport.mockResolvedValue("fixture-gateway.pem")
	mocks.getToken.mockResolvedValue("fixture-token")
	mocks.forceRefreshToken.mockResolvedValue("fixture-refreshed-token")
	for (const provider of providers) provider.request.mockResolvedValue(provider.response)
})

afterEach(() => {
	vi.useRealTimers()
})

describe.each(providers)("$name single completion cancellation", (provider) => {
	it("rejects before gateway setup, credentials or dispatch when already cancelled", async () => {
		const handler = provider.create(true)
		const controller = new AbortController()
		const reason = new Error("403: cancelled before authorization")
		controller.abort(reason)
		await expect(handler.completePrompt("prompt", { signal: controller.signal })).rejects.toBe(reason)
		expect(mocks.configureTransport).not.toHaveBeenCalled()
		expect(mocks.getToken).not.toHaveBeenCalled()
		expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
		expect(provider.request).not.toHaveBeenCalled()
	})

	it.each([
		["resolve", 600],
		["reject", 600],
		["resolve", 0],
		["reject", 0],
	] as const)(
		"settles a cancelled stalled SDK request promptly and ignores its late %s (timeout: %ss)",
		async (lateOutcome, timeoutSeconds) => {
			mocks.requestTimeout.mockReturnValue(timeoutSeconds)
			const handler = provider.create(true)
			const started = deferred<void>()
			const held = deferred<unknown>()
			provider.request.mockImplementationOnce(() => {
				started.resolve()
				return held.promise
			})
			const controller = new AbortController()
			const reason = new Error("403: cancelled SDK request")
			const completion = observe(handler.completePrompt("prompt", { signal: controller.signal }))
			await started.promise
			try {
				controller.abort(reason)
				await vi.advanceTimersByTimeAsync(0)
				expect(completion.result).toEqual({ status: "rejected", reason })
				expect(provider.signal(provider.request)?.aborted).toBe(true)
				expect(provider.signal(provider.request)?.reason).toBe(reason)
				expect(vi.getTimerCount()).toBe(0)
				expect(provider.request).toHaveBeenCalledOnce()
				expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
			} finally {
				if (lateOutcome === "resolve") held.resolve(provider.response)
				else held.reject(new Error("late transport failure"))
				await completion.promise
			}
			await expect(handler.completePrompt("fresh prompt")).resolves.toBe("answer")
		},
	)

	it.each(["setup", "token"] as const)(
		"does not dispatch after cancellation while gateway %s is stalled",
		async (stage) => {
			const handler = provider.create(true)
			const started = deferred<void>()
			const held = deferred<string>()
			const operation = stage === "setup" ? mocks.configureTransport : mocks.getToken
			operation.mockImplementationOnce(() => {
				started.resolve()
				return held.promise
			})
			const controller = new AbortController()
			const reason = { cancelledStage: stage }
			const completion = observe(handler.completePrompt("prompt", { signal: controller.signal }))
			await started.promise
			try {
				controller.abort(reason)
				await vi.advanceTimersByTimeAsync(0)
				expect(completion.result).toEqual({ status: "rejected", reason })
				expect(provider.request).not.toHaveBeenCalled()
			} finally {
				held.resolve("late setup or token")
				await completion.promise
			}
			await vi.advanceTimersByTimeAsync(0)
			expect(provider.request).not.toHaveBeenCalled()
			if (stage === "setup") expect(mocks.getToken).not.toHaveBeenCalled()
			await expect(handler.completePrompt("fresh prompt")).resolves.toBe("answer")
			expect(mocks.configureTransport).toHaveBeenCalledOnce()
		},
	)

	it("does not retry after cancellation while refreshing gateway credentials", async () => {
		const handler = provider.create(true)
		const started = deferred<void>()
		const held = deferred<string>()
		provider.request.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }))
		mocks.forceRefreshToken.mockImplementationOnce(() => {
			started.resolve()
			return held.promise
		})
		const controller = new AbortController()
		const reason = new Error("cancelled credential refresh")
		const completion = observe(handler.completePrompt("prompt", { signal: controller.signal }))
		await started.promise
		try {
			controller.abort(reason)
			await vi.advanceTimersByTimeAsync(0)
			expect(completion.result).toEqual({ status: "rejected", reason })
		} finally {
			held.resolve("late refreshed token")
			await completion.promise
		}
		await vi.advanceTimersByTimeAsync(0)
		expect(provider.request).toHaveBeenCalledOnce()
	})

	it("rejects a late SDK success with the original cancellation reason", async () => {
		const handler = provider.create(false)
		const controller = new AbortController()
		const reason = new Error("cancelled alongside SDK completion")
		provider.request.mockImplementationOnce(async () => {
			controller.abort(reason)
			return provider.response
		})
		await expect(handler.completePrompt("prompt", { signal: controller.signal })).rejects.toBe(reason)
		expect(provider.request).toHaveBeenCalledOnce()
		expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
	})

	it("retains the normal gateway authentication retry", async () => {
		const handler = provider.create(true)
		provider.request.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }))
		await expect(handler.completePrompt("prompt", { signal: new AbortController().signal })).resolves.toBe("answer")
		expect(provider.request).toHaveBeenCalledTimes(2)
		expect(mocks.forceRefreshToken).toHaveBeenCalledOnce()
	})
})

it("retains the Gemini completion deadline and cancels its SDK request", async () => {
	mocks.requestTimeout.mockReturnValue(1)
	const provider = providers[0]!
	const handler = provider.create(false)
	const started = deferred<void>()
	const held = deferred<unknown>()
	provider.request.mockImplementationOnce(() => {
		started.resolve()
		return held.promise
	})
	const completion = observe(handler.completePrompt("prompt"))
	try {
		await started.promise
		await vi.advanceTimersByTimeAsync(1_000)
		expect(completion.result).toMatchObject({ status: "rejected", reason: { code: "ProviderTimeout" } })
		expect(provider.signal(provider.request)?.aborted).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
		expect(provider.request).toHaveBeenCalledOnce()
		expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
	} finally {
		held.resolve(provider.response)
		await completion.promise
	}
})
