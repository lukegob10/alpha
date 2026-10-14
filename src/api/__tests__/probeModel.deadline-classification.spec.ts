import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiHandler } from "../index"
import { ApiStreamDeadlineError, createLinkedAbortController, raceApiStreamAbort } from "../transform/stream"

const factory = vi.hoisted(() => vi.fn())
vi.mock("../index", () => ({ buildApiHandler: factory }))
import { probeModel } from "../probeModel"

function handler(stream: ApiHandler["createMessage"]) {
	const api = {
		streamCapabilities: { cancellation: true, lifecycle: true },
		getModel: () => ({ id: "selected", info: {} }),
		createMessage: vi.fn(stream),
		dispose: vi.fn(),
	}
	factory.mockReturnValue(api as unknown as ApiHandler)
	return api
}

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})

describe("readiness deadline classification at the adapter boundary", () => {
	it("keeps an independently due adapter deadline classified before the outer timer dispatches", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		let releaseTransport!: () => void
		const transport = new Promise<void>((resolve) => (releaseTransport = resolve))
		let observed:
			| { deadlineDue: boolean; adapterAborted: boolean; outerAborted: boolean; reason: unknown }
			| undefined
		const api = handler(async function* (_systemPrompt, _messages, metadata) {
			if (typeof metadata?.deadline !== "number" || !metadata.signal) throw new Error("Missing request control")
			const adapter = createLinkedAbortController({ signal: metadata.signal, deadline: metadata.deadline })
			try {
				metadata.onRequestPhase?.("request-admission")
				// The adapter also checks an already-due absolute deadline synchronously.
				// Move wall time to that boundary without dispatching either timer callback.
				vi.setSystemTime(metadata.deadline)
				if (metadata.deadline <= Date.now() && !adapter.signal.aborted) {
					adapter.controller.abort(new ApiStreamDeadlineError())
				}
				await raceApiStreamAbort(transport, adapter.signal)
				observed = {
					deadlineDue: metadata.deadline <= Date.now(),
					adapterAborted: adapter.signal.aborted,
					outerAborted: metadata.signal.aborted,
					reason: adapter.signal.reason,
				}
				adapter.signal.throwIfAborted()
				yield* []
			} finally {
				adapter.dispose()
			}
		})
		const pending = probeModel({})
		try {
			const result = await pending
			expect(observed).toMatchObject({ deadlineDue: true, adapterAborted: true, outerAborted: false })
			expect(observed?.reason).toBeInstanceOf(ApiStreamDeadlineError)
			expect(api.dispose).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)
			expect(result).toMatchObject({
				status: "failed",
				requests: 1,
				requestPhase: "request-admission",
				firstTextMs: null,
				usage: null,
				failureCode: "cancelled_or_deadline",
			})
		} finally {
			releaseTransport()
			await transport
			await pending
		}
	})

	it("retains accepted completion when iterator cleanup reports a late abort and progress", async () => {
		const caller = new AbortController()
		let closed = false
		const api = handler(async function* (_systemPrompt, _messages, metadata) {
			try {
				metadata?.onRequestPhase?.("response-stream")
				yield { type: "text", text: "OK" }
				yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
			} finally {
				caller.abort(new ApiStreamDeadlineError())
				metadata?.onRequestPhase?.("request-admission")
				closed = true
			}
		})
		try {
			const result = await probeModel({}, caller.signal)
			expect(closed).toBe(true)
			expect(caller.signal.aborted).toBe(true)
			expect(api.dispose).toHaveBeenCalledOnce()
			expect(result).toMatchObject({
				status: "completed",
				requests: 1,
				requestPhase: "response-stream",
				failureCode: null,
			})
		} finally {
			caller.abort()
		}
	})

	it("retains request_failed for an ordinary error before the deadline", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		let beforeDeadline = false
		let outerAborted: boolean | undefined
		const api = handler(async function* (_systemPrompt, _messages, metadata) {
			yield* []
			if (typeof metadata?.deadline !== "number" || !metadata.signal) throw new Error("Missing request control")
			metadata.onRequestPhase?.("request-admission")
			beforeDeadline = Date.now() < metadata.deadline
			outerAborted = metadata.signal.aborted
			throw new Error("Private provider diagnostic")
		})
		const result = await probeModel({})
		expect(beforeDeadline).toBe(true)
		expect(outerAborted).toBe(false)
		expect(api.dispose).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		expect(result).toMatchObject({
			status: "failed",
			requests: 1,
			requestPhase: "request-admission",
			failureCode: "request_failed",
		})
		expect(JSON.stringify(result)).not.toContain("Private provider diagnostic")
	})
})
