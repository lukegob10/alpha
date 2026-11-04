import { describe, expect, it, vi } from "vitest"
import type { ApiStream, ApiStreamChunk } from "../../../api/transform/stream"
import { ApiStreamDeadlineError } from "../../../api/transform/stream"
import { observeModelRequestStream, type ModelRequestHookEvent } from "../ModelRequestHooks"

const collect = async (stream: ApiStream) => {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}
const stream = (chunks: ApiStreamChunk[] = []): ApiStream =>
	(async function* () {
		yield* chunks
	})()
const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}
const observer = (controller = new AbortController()) => ({
	signal: controller.signal,
	onEvent: vi.fn(async (_event: ModelRequestHookEvent) => undefined),
	onError: vi.fn(),
})

describe("physical model request observations", () => {
	it("preserves provider chunks and reports additive provider usage before EOF", async () => {
		const hooks = observer()
		const chunks: ApiStreamChunk[] = [
			{ type: "text", text: "Answer" },
			{ type: "usage", usageSource: "provider", inputTokens: 8, outputTokens: 2, cacheReadTokens: 3 },
			{ type: "usage", usageSource: "provider", inputTokens: 0, outputTokens: 1, reasoningTokens: 1 },
		]
		expect(await collect(observeModelRequestStream(() => stream(chunks), hooks))).toEqual(chunks)
		expect(hooks.onEvent.mock.calls.map(([event]) => event)).toEqual([
			{ hook_event_name: "PreModelRequest" },
			{
				hook_event_name: "PostModelRequest",
				status: "completed",
				error: null,
				token_usage: {
					input_tokens: 8,
					cached_input_tokens: 3,
					output_tokens: 3,
					reasoning_output_tokens: 1,
					total_tokens: 11,
				},
			},
		])
	})

	it.each([undefined, "estimate", "unknown"] as const)(
		"keeps %s usage nullable instead of claiming provider tokens",
		async (usageSource) => {
			const hooks = observer()
			await collect(
				observeModelRequestStream(
					() => stream([{ type: "usage", usageSource, inputTokens: 20, outputTokens: 10 }]),
					hooks,
				),
			)
			expect(hooks.onEvent).toHaveBeenLastCalledWith({
				hook_event_name: "PostModelRequest",
				status: "completed",
				error: null,
				token_usage: null,
			})
		},
	)

	it("does not let observer failures mask provider failure, leak error bodies, or issue retries", async () => {
		const hooks = observer()
		hooks.onEvent.mockRejectedValue(new Error("Observer failed"))
		const failure = new Error("Authorization: Bearer private-key; prompt=private body")
		const create = vi.fn(() =>
			(async function* (): ApiStream {
				yield* []
				throw failure
			})(),
		)
		await expect(collect(observeModelRequestStream(create, hooks))).rejects.toBe(failure)
		expect(create).toHaveBeenCalledOnce()
		expect(hooks.onEvent).toHaveBeenLastCalledWith({
			hook_event_name: "PostModelRequest",
			status: "failed",
			error: "Model request failed.",
			token_usage: null,
		})
		expect(hooks.onError).toHaveBeenCalledTimes(2)
	})

	it("reports a failed error chunk without changing the stream", async () => {
		const hooks = observer()
		const chunks: ApiStreamChunk[] = [{ type: "error", error: "ProviderFailure", message: "private provider body" }]
		expect(await collect(observeModelRequestStream(() => stream(chunks), hooks))).toEqual(chunks)
		expect(hooks.onEvent).toHaveBeenLastCalledWith({
			hook_event_name: "PostModelRequest",
			status: "failed",
			error: "Model request failed.",
			token_usage: null,
		})
	})

	it("retains failure when a completed marker follows a provider error chunk", async () => {
		const hooks = observer()
		const chunks: ApiStreamChunk[] = [
			{ type: "error", error: "ProviderFailure", message: "Private body" },
			{ type: "outcome", status: "completed", terminal: true, semanticOutputObserved: false },
		]
		expect(await collect(observeModelRequestStream(() => stream(chunks), hooks))).toEqual(chunks)
		expect(hooks.onEvent).toHaveBeenLastCalledWith({
			hook_event_name: "PostModelRequest",
			status: "failed",
			error: "Model request failed.",
			token_usage: null,
		})
	})

	it.each(["cancel", "close"] as const)("retains a completed response across late consumer %s", async (action) => {
		const controller = new AbortController()
		const hooks = observer(controller)
		const observed = observeModelRequestStream(
			() => stream([{ type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }]),
			hooks,
		)
		await observed.next()
		if (action === "cancel") {
			controller.abort(new Error("Cancelled after response completion"))
			await expect(observed.next()).rejects.toBe(controller.signal.reason)
		} else await observed.return(undefined)
		expect(hooks.onEvent).toHaveBeenLastCalledWith({
			hook_event_name: "PostModelRequest",
			status: "completed",
			error: null,
			token_usage: null,
		})
		expect(hooks.onEvent).toHaveBeenCalledTimes(2)
	})

	it.each(["failed", "incomplete"] as const)(
		"retains an explicit %s response when the consumer closes",
		async (status) => {
			const hooks = observer()
			const observed = observeModelRequestStream(
				() =>
					stream([{ type: "outcome", status, terminal: status === "failed", semanticOutputObserved: false }]),
				hooks,
			)
			await observed.next()
			await observed.return(undefined)
			expect(hooks.onEvent).toHaveBeenLastCalledWith({
				hook_event_name: "PostModelRequest",
				status: "failed",
				error: "Model request failed.",
				token_usage: null,
			})
		},
	)

	it("emits one cancelled post promptly even when a provider ignores abort, without late replacement", async () => {
		const controller = new AbortController()
		const hooks = observer(controller)
		const entered = barrier()
		const release = barrier()
		const provider = (async function* (): ApiStream {
			entered.resolve()
			await release.promise
			yield { type: "usage", usageSource: "provider", inputTokens: 100, outputTokens: 200 }
		})()
		const collecting = collect(observeModelRequestStream(() => provider, hooks))
		const cancellation = new Error("Request cancelled by user")
		const rejected = expect(collecting).rejects.toBe(cancellation)
		await entered.promise
		controller.abort(cancellation)
		expect(hooks.onEvent).toHaveBeenLastCalledWith({
			hook_event_name: "PostModelRequest",
			status: "cancelled",
			error: null,
			token_usage: null,
		})
		release.resolve()
		await rejected
		expect(hooks.onEvent).toHaveBeenCalledTimes(2)
	})

	it("does not describe an explicit incomplete response as a completed request", async () => {
		const hooks = observer()
		const chunks: ApiStreamChunk[] = [
			{ type: "outcome", status: "incomplete", terminal: false, semanticOutputObserved: false },
		]
		expect(await collect(observeModelRequestStream(() => stream(chunks), hooks))).toEqual(chunks)
		expect(hooks.onEvent).toHaveBeenLastCalledWith({
			hook_event_name: "PostModelRequest",
			status: "failed",
			error: "Model request failed.",
			token_usage: null,
		})
	})

	it("reports a request timeout as failure instead of user cancellation", async () => {
		const controller = new AbortController()
		const hooks = observer(controller)
		const entered = barrier()
		const release = barrier()
		const provider = (async function* (): ApiStream {
			entered.resolve()
			await release.promise
			yield* []
		})()
		const collecting = collect(observeModelRequestStream(() => provider, hooks))
		await entered.promise
		const timeout = new ApiStreamDeadlineError()
		controller.abort(timeout)
		expect(hooks.onEvent).toHaveBeenLastCalledWith({
			hook_event_name: "PostModelRequest",
			status: "failed",
			error: "Model request timed out.",
			token_usage: null,
		})
		release.resolve()
		await expect(collecting).rejects.toBe(timeout)
		expect(hooks.onEvent).toHaveBeenCalledTimes(2)
	})

	it("finishes observations when a consumer closes at a semantic chunk", async () => {
		const hooks = observer()
		const observed = observeModelRequestStream(() => stream([{ type: "text", text: "partial" }]), hooks)
		await observed.next()
		await observed.return(undefined)
		expect(hooks.onEvent).toHaveBeenLastCalledWith({
			hook_event_name: "PostModelRequest",
			status: "cancelled",
			error: null,
			token_usage: null,
		})
	})
})
