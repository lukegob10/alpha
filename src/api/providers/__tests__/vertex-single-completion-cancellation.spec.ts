import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { SingleCompletionHandler } from "../../index"
import { AnthropicVertexHandler } from "../anthropic-vertex"
import { VertexHandler } from "../vertex"

const mocks = vi.hoisted(() => ({
	geminiRequest: vi.fn(),
	anthropicRequest: vi.fn(),
	requestTimeout: vi.fn(() => 600),
}))

vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: mocks.requestTimeout }) },
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

const googleOptions = {
	vertexProjectId: "fixture-project",
	vertexRegion: "global",
}

const providers = [
	{
		name: "Vertex Gemini",
		create: (_gateway: boolean): SingleCompletionHandler =>
			new VertexHandler({
				...googleOptions,
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
				...(gateway ? googleOptions : {}),
				apiModelId: "claude-sonnet-4-6",
			}),
		request: mocks.anthropicRequest,
		response: { content: [{ type: "text", text: "answer" }], stop_reason: "end_turn" },
		signal: (request: Mock): AbortSignal | undefined => request.mock.calls[0]?.[1]?.signal,
	},
]

beforeEach(() => {
	vi.useFakeTimers()
	vi.resetAllMocks()
	mocks.requestTimeout.mockReturnValue(600)

	for (const provider of providers) provider.request.mockResolvedValue(provider.response)
})

afterEach(() => {
	vi.useRealTimers()
})

describe.each(providers)("$name single completion cancellation", (provider) => {
	it("rejects before credentials or dispatch when already cancelled", async () => {
		const handler = provider.create(true)
		const controller = new AbortController()
		const reason = new Error("403: cancelled before authorization")
		controller.abort(reason)
		await expect(handler.completePrompt("prompt", { signal: controller.signal })).rejects.toBe(reason)

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
			} finally {
				if (lateOutcome === "resolve") held.resolve(provider.response)
				else held.reject(new Error("late transport failure"))
				await completion.promise
			}
			await expect(handler.completePrompt("fresh prompt")).resolves.toBe("answer")
		},
	)

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
	} finally {
		held.resolve(provider.response)
		await completion.promise
	}
})
