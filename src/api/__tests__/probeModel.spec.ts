import { describe, expect, it, vi } from "vitest"
import type { ModelRequestPhase } from "@alpha-code/types"
import type { ApiHandler } from "../index"
const factory = vi.hoisted(() => vi.fn())
vi.mock("../index", () => ({ buildApiHandler: factory }))
import { probeModel } from "../probeModel"

function handler(stream: ApiHandler["createMessage"]) {
	const result = {
		streamCapabilities: { cancellation: true, lifecycle: true },
		getModel: () => ({ id: "selected", info: {} }),
		createMessage: vi.fn(stream),
		dispose: vi.fn(),
	}
	factory.mockReturnValue(result as unknown as ApiHandler)
	return result
}

describe("actual adapter readiness", () => {
	it("requires semantic output and completion, records one request with usage provenance, and disposes", async () => {
		const api = handler(async function* () {
			yield { type: "text", text: "OK" }
			yield { type: "usage", inputTokens: 10, outputTokens: 1, usageSource: "provider" }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
		})
		const result = await probeModel({ apiProvider: "vscode-lm" })
		expect(result).toMatchObject({
			status: "completed",
			requests: 1,
			modelId: "selected",
			usage: { inputTokens: 10, outputTokens: 1, source: "provider", cost: null },
			failureCode: null,
		})
		expect(result.firstTextMs).toBeTypeOf("number")
		expect(api.createMessage).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({ tools: [], tool_choice: "none", signal: expect.any(AbortSignal) }),
		)
		expect(api.dispose).toHaveBeenCalledOnce()
	})
	it("does not count metadata-only or incomplete output as readiness and preserves unknown usage", async () => {
		handler(async function* () {
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: false }
		})
		expect(await probeModel({})).toMatchObject({
			status: "failed",
			requests: 1,
			firstTextMs: null,
			usage: null,
			failureCode: "empty_response",
		})
		handler(async function* () {
			yield { type: "text", text: "visible" }
		})
		expect(await probeModel({})).toMatchObject({ status: "failed", failureCode: "incomplete_response" })
	})
	it("cancels before dispatch and never exports provider exception text", async () => {
		const api = handler(async function* () {
			yield* []
			throw new Error("SECRET-provider-error")
		})
		const controller = new AbortController()
		controller.abort()
		expect(await probeModel({}, controller.signal)).toMatchObject({
			status: "failed",
			requests: 0,
			failureCode: "cancelled_or_deadline",
		})
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(JSON.stringify(await probeModel({}))).not.toContain("SECRET")
	})
	it("reports cancellation after dispatch while the provider stream is stalled", async () => {
		const controller = new AbortController()
		let markDispatched!: () => void
		const dispatched = new Promise<void>((resolve) => {
			markDispatched = resolve
		})
		let releaseProvider!: () => void
		const providerRelease = new Promise<void>((resolve) => {
			releaseProvider = resolve
		})
		let markProviderClosed!: () => void
		const providerClosed = new Promise<void>((resolve) => {
			markProviderClosed = resolve
		})
		const api = handler(async function* () {
			yield* []
			markDispatched()
			try {
				await providerRelease
			} finally {
				markProviderClosed()
			}
		})
		const pending = probeModel({}, controller.signal)
		try {
			await dispatched
			controller.abort()
			expect(await pending).toMatchObject({
				status: "failed",
				requests: 1,
				modelId: "selected",
				firstTextMs: null,
				usage: null,
				failureCode: "cancelled_or_deadline",
			})
			expect(api.createMessage).toHaveBeenCalledOnce()
			expect(api.dispose).toHaveBeenCalledOnce()
		} finally {
			controller.abort()
			releaseProvider()
			await providerClosed
			await pending
		}
	})
	it.each([false, true])(
		"keeps cancellation terminal after visible output (completion received: %s)",
		async (complete) => {
			const controller = new AbortController()
			const api = handler(async function* () {
				yield { type: "text", text: "OK" }
				controller.abort()
				if (complete)
					yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
			})
			expect(await probeModel({}, controller.signal)).toMatchObject({
				status: "failed",
				requests: 1,
				failureCode: "cancelled_or_deadline",
			})
			expect(api.dispose).toHaveBeenCalledOnce()
		},
	)
	it("recognizes a provider cancellation outcome even without a caller abort", async () => {
		handler(async function* () {
			yield { type: "outcome", status: "cancelled", terminal: true, semanticOutputObserved: false }
		})
		expect(await probeModel({})).toMatchObject({
			status: "failed",
			requests: 1,
			usage: null,
			failureCode: "cancelled_or_deadline",
		})
	})
	it("uses one absolute deadline for preparation and streaming and releases its timer", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		let dispatch!: () => void
		const dispatched = new Promise<void>((resolve) => {
			dispatch = resolve
		})
		let release!: () => void
		const providerRelease = new Promise<void>((resolve) => {
			release = resolve
		})
		const api = handler(async function* () {
			dispatch()
			await providerRelease
			yield* []
		})
		const prepareModel = vi.fn(async () => {
			await vi.advanceTimersByTimeAsync(10_000)
		})
		factory.mockReturnValue({ ...api, prepareModel })
		const pending = probeModel({})
		try {
			await dispatched
			expect(prepareModel).toHaveBeenCalledWith(expect.objectContaining({ deadline: 61_000 }))
			expect(api.createMessage).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Array),
				expect.objectContaining({ deadline: 61_000 }),
			)
			await vi.advanceTimersByTimeAsync(50_000)
			expect(await pending).toMatchObject({ requests: 1, status: "failed", failureCode: "cancelled_or_deadline" })
			expect(api.dispose).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			release()
			await vi.runAllTimersAsync()
			await pending
			vi.useRealTimers()
		}
	})
	it("settles at accepted terminal completion without waiting for a stalled EOF", async () => {
		vi.useFakeTimers()
		let release!: () => void
		const providerRelease = new Promise<void>((resolve) => {
			release = resolve
		})
		const api = handler(async function* () {
			yield { type: "text", text: "OK" }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
			await providerRelease
		})
		const pending = probeModel({})
		try {
			await vi.advanceTimersByTimeAsync(60_000)
			expect(await pending).toMatchObject({ status: "completed", requests: 1, failureCode: null })
			expect(api.dispose).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			release()
			await pending
			vi.useRealTimers()
		}
	})
	it("does not mark a response requiring continuation as readiness", async () => {
		handler(async function* () {
			yield { type: "text", text: "Working" }
			yield {
				type: "outcome",
				status: "completed",
				terminal: true,
				semanticOutputObserved: true,
				requiresContinuation: true,
			}
		})
		expect(await probeModel({})).toMatchObject({
			status: "failed",
			failureCode: "incomplete_response",
			requests: 1,
		})
	})
	it("keeps cancellation observable if disposal fails without exporting exception text", async () => {
		const controller = new AbortController()
		const api = handler(async function* () {
			controller.abort()
			yield* []
		})
		api.dispose.mockImplementation(() => {
			throw new Error("SECRET-disposal-error")
		})
		const result = await probeModel({}, controller.signal)
		expect(result).toMatchObject({ status: "failed", requests: 1, failureCode: "cancelled_or_deadline" })
		expect(JSON.stringify(result)).not.toContain("SECRET")
	})
	it.each([
		"model-selection",
		"request-admission",
		"first-response-chunk",
		"response-stream",
	] satisfies ModelRequestPhase[])(
		"preserves the last observed %s phase when an outer abort ends iteration",
		async (phase) => {
			const controller = new AbortController()
			let reached!: () => void
			const phaseReached = new Promise<void>((resolve) => (reached = resolve))
			let release!: () => void
			const providerRelease = new Promise<void>((resolve) => (release = resolve))
			let closed!: () => void
			const providerClosed = new Promise<void>((resolve) => (closed = resolve))
			handler(async function* (_systemPrompt, _messages, metadata) {
				metadata?.onRequestPhase?.(phase)
				reached()
				try {
					await providerRelease
					yield* []
				} finally {
					metadata?.onRequestPhase?.(phase === "model-selection" ? "response-stream" : "model-selection")
					closed()
				}
			})
			const pending = probeModel({}, controller.signal)
			let result: Awaited<ReturnType<typeof probeModel>> | undefined
			try {
				await phaseReached
				controller.abort()
				result = await pending
				expect(result).toMatchObject({
					status: "failed",
					requests: 1,
					failureCode: "cancelled_or_deadline",
					requestPhase: phase,
					usage: null,
				})
			} finally {
				controller.abort()
				release()
				await providerClosed
				await pending
			}
			expect(result?.requestPhase).toBe(phase)
		},
	)
	it("ignores unknown phase values without retaining provider content", async () => {
		handler(async function* (_systemPrompt, _messages, metadata) {
			metadata?.onRequestPhase?.("SECRET-provider-phase" as ModelRequestPhase)
			yield { type: "text", text: "OK" }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
		})
		const result = await probeModel({})
		expect(result).toMatchObject({ status: "completed", requests: 1, failureCode: null })
		expect(result.requestPhase).toBeUndefined()
		expect(JSON.stringify(result)).not.toContain("SECRET")
	})
	it("keeps an accepted completion immutable when the adapter reports progress later", async () => {
		let reportPhase: ((phase: ModelRequestPhase) => void) | undefined
		handler(async function* (_systemPrompt, _messages, metadata) {
			reportPhase = metadata?.onRequestPhase
			reportPhase?.("response-stream")
			yield { type: "text", text: "OK" }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
		})
		const result = await probeModel({})
		expect(result).toMatchObject({ status: "completed", requests: 1, requestPhase: "response-stream" })
		reportPhase?.("model-selection")
		expect(result.requestPhase).toBe("response-stream")
	})
})
