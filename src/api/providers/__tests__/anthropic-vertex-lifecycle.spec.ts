import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ApiHandlerCreateMessageMetadata } from "../../index"
import type { ApiStreamChunk } from "../../transform/stream"
import { AnthropicVertexHandler } from "../anthropic-vertex"

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
}))
vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(function () {
		return { messages: { create: mocks.create } }
	}),
}))

const completeResponse = {
	content: [{ type: "text", text: "answer" }],
	stop_reason: "end_turn",
}
const completeEvents = [
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
	{ type: "message_stop" },
]

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function stream() {
	return {
		async *[Symbol.asyncIterator]() {
			yield* completeEvents
		},
	}
}

function handler(streaming = true) {
	return new AnthropicVertexHandler({
		apiModelId: "claude-sonnet-4-6",
		vertexProjectId: "fixture-project",
		vertexRegion: "global",

		vertexStreamingEnabled: streaming,
	})
}

async function collect(target: AnthropicVertexHandler, metadata?: ApiHandlerCreateMessageMetadata) {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of target.createMessage("system", [{ role: "user", content: "hello" }], metadata)) {
		chunks.push(chunk)
	}
	return chunks
}

function observe<T>(promise: Promise<T>) {
	let result: { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown } | undefined
	return {
		promise: promise.then(
			(value) => (result = { status: "fulfilled", value }),
			(reason: unknown) => (result = { status: "rejected", reason }),
		),
		get result() {
			return result
		},
	}
}

beforeEach(() => {
	vi.resetAllMocks()

	mocks.create.mockImplementation(async ({ stream: streaming }: { stream?: boolean }) =>
		streaming ? stream() : completeResponse,
	)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("Vertex Claude request lifecycle", () => {
	it("rejects cancellation and elapsed deadlines before credentials or dispatch", async () => {
		const target = handler()
		const controller = new AbortController()
		const reason = new Error("fixture cancelled admission")
		controller.abort(reason)
		await expect(collect(target, { taskId: "fixture", signal: controller.signal })).rejects.toBe(reason)
		await expect(collect(target, { taskId: "fixture", deadline: Date.now() - 1 })).rejects.toMatchObject({
			name: "ApiStreamDeadlineError",
		})

		expect(mocks.create).not.toHaveBeenCalled()
	})

	it.each([true, false])("settles a stalled SDK request promptly with streaming=%s", async (streaming) => {
		vi.useFakeTimers()
		const target = handler(streaming)
		const started = deferred<void>()
		const held = deferred<unknown>()
		let requestSignal: AbortSignal | undefined
		mocks.create.mockImplementationOnce((_request: unknown, options?: { signal?: AbortSignal }) => {
			requestSignal = options?.signal
			started.resolve()
			return held.promise
		})
		const controller = new AbortController()
		const reason = new Error("fixture cancelled SDK request")
		const completion = observe(collect(target, { taskId: "fixture", signal: controller.signal }))
		await started.promise
		try {
			controller.abort(reason)
			await vi.advanceTimersByTimeAsync(0)
			expect(completion.result).toEqual({ status: "rejected", reason })
			expect(requestSignal?.aborted).toBe(true)
			expect(requestSignal?.reason).toBe(reason)
			expect(mocks.create).toHaveBeenCalledOnce()
		} finally {
			held.resolve(streaming ? stream() : completeResponse)
			await completion.promise
		}
	})

	it.each(["cancellation", "deadline"] as const)("settles a stalled SDK iterator on %s", async (interruption) => {
		vi.useFakeTimers()
		const target = handler()
		const started = deferred<void>()
		const held = deferred<IteratorResult<unknown>>()
		mocks.create.mockResolvedValue({
			[Symbol.asyncIterator]: () => ({
				next: () => {
					started.resolve()
					return held.promise
				},
			}),
		})
		const controller = new AbortController()
		const completion = observe(
			collect(target, { taskId: "fixture", signal: controller.signal, deadline: Date.now() + 20 }),
		)
		await started.promise
		try {
			if (interruption === "cancellation") controller.abort(new Error("fixture cancelled iterator"))
			await vi.advanceTimersByTimeAsync(interruption === "deadline" ? 20 : 0)
			expect(completion.result).toMatchObject({
				status: "rejected",
				reason: interruption === "deadline" ? { code: "ProviderTimeout" } : controller.signal.reason,
			})
			expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(true)

			expect(vi.getTimerCount()).toBe(0)
		} finally {
			held.resolve({ done: true, value: undefined })
			await completion.promise
		}
	})

	it.each(["max_tokens", "model_context_window_exceeded", "tool_use", "pause_turn", "refusal", undefined])(
		"rejects auxiliary completion stop reason %s",
		async (stop_reason) => {
			mocks.create.mockResolvedValue({ ...completeResponse, stop_reason })
			await expect(handler().completePrompt("hello")).rejects.toThrow("complete text response")
			expect(mocks.create).toHaveBeenCalledOnce()
		},
	)

	it.each(["end_turn", "stop_sequence"])("accepts complete auxiliary text with %s", async (stop_reason) => {
		mocks.create.mockResolvedValue({
			stop_reason,
			content: [
				{ type: "thinking", thinking: "summary", signature: "fixture-signature" },
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			],
		})
		await expect(handler().completePrompt("hello")).resolves.toBe("firstsecond")
	})
})
