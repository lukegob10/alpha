import { setImmediate } from "node:timers/promises"

import {
	getApiStreamErrorMessage,
	iterateApiStreamWithAbort,
	normalizeApiStreamErrorMetadata,
	raceApiStreamAbort,
} from "../stream"

describe("API stream cancellation", () => {
	it("does not read an already-cancelled source and still closes its iterator", async () => {
		const controller = new AbortController()
		controller.abort()
		const next = vi.fn(async () => ({ done: false as const, value: "Stale output" }))
		const close = vi.fn(async () => ({ done: true as const, value: undefined }))
		const source = { [Symbol.asyncIterator]: () => ({ next, return: close }) }

		await expect(iterateApiStreamWithAbort(source, controller.signal).next()).resolves.toMatchObject({ done: true })
		expect(next).not.toHaveBeenCalled()
		expect(close).toHaveBeenCalledOnce()
	})

	it("does not request another source item after cancellation between chunks", async () => {
		const controller = new AbortController()
		const next = vi.fn(async () => ({ done: false as const, value: "Accepted output" }))
		const close = vi.fn(async () => ({ done: true as const, value: undefined }))
		const source = { [Symbol.asyncIterator]: () => ({ next, return: close }) }
		const consumer = iterateApiStreamWithAbort(source, controller.signal)

		await expect(consumer.next()).resolves.toMatchObject({ done: false, value: "Accepted output" })
		controller.abort()
		await expect(consumer.next()).resolves.toMatchObject({ done: true })
		expect(next).toHaveBeenCalledOnce()
		expect(close).toHaveBeenCalledOnce()
	})

	it.each([true, false])(
		"consumes late transport rejection when cancellation is already pending: %s",
		async (aborted) => {
			const controller = new AbortController()
			if (aborted) controller.abort()
			let rejectTransport!: (error: Error) => void
			const transport = new Promise<string>((_resolve, reject) => {
				rejectTransport = reject
			})
			const failures: unknown[] = []
			const onUnhandledRejection = (reason: unknown) => {
				failures.push(reason)
			}
			process.on("unhandledRejection", onUnhandledRejection)
			try {
				const result = raceApiStreamAbort(transport, controller.signal)
				controller.abort()
				await expect(result).resolves.toBeUndefined()
				rejectTransport(new Error("Abandoned transport failed"))
				await setImmediate()
				expect(failures).toEqual([])
			} finally {
				process.removeListener("unhandledRejection", onUnhandledRejection)
				await transport.catch(() => undefined)
			}
		},
	)

	it("preserves transport failures while the caller remains active", async () => {
		const failure = new Error("Provider unavailable")
		await expect(raceApiStreamAbort(Promise.reject(failure), new AbortController().signal)).rejects.toBe(failure)
	})
})

describe("API stream error metadata", () => {
	it("retains common retry, status and request fields without copying provider payloads", () => {
		const source: Record<string, unknown> = {
			error: {
				code: "rate_limit_exceeded",
				statusCode: 429,
				headers: { authorization: "private-credential" },
				request: { prompt: "private-prompt" },
			},
			body: "private-body".repeat(100_000),
			count: 1n,
		}
		source.self = source
		const result = normalizeApiStreamErrorMetadata(
			source,
			{ requestId: "request-1", attemptId: "attempt-2" },
			{ phase: "response-stream", semanticOutputObserved: false },
		)

		expect(result).toEqual({
			code: "rate_limit_exceeded",
			status: 429,
			statusCode: 429,
			retryable: true,
			phase: "response-stream",
			requestId: "request-1",
			attemptId: "attempt-2",
			semanticOutputObserved: false,
		})
		expect(JSON.stringify(result)).not.toContain("private-")
		expect(source.self).toBe(source)
	})

	it("preserves explicit non-retryable metadata over a transient HTTP status", () => {
		expect(normalizeApiStreamErrorMetadata({ status: 503, retryable: false })).toEqual({
			status: 503,
			retryable: false,
		})
	})

	it("never reads arbitrary provider properties or invokes custom serializers", () => {
		const unexpectedRead = vi.fn(() => {
			throw new Error("Provider details must not be read")
		})
		const source = Object.defineProperty({ code: "Unavailable", toJSON: unexpectedRead }, "request", {
			enumerable: true,
			get: unexpectedRead,
		})

		expect(JSON.stringify(normalizeApiStreamErrorMetadata(source))).toBe('{"code":"Unavailable","retryable":false}')
		expect(unexpectedRead).not.toHaveBeenCalled()
	})

	it.each([NaN, Infinity, -Infinity])("drops nonfinite statuses: %s", (status) => {
		expect(normalizeApiStreamErrorMetadata({ status, statusCode: status })).toEqual({ retryable: false })
	})

	it("drops oversized identifiers instead of copying unbounded provider text", () => {
		const oversized = "x".repeat(257)
		expect(
			normalizeApiStreamErrorMetadata(
				{ code: oversized, phase: oversized },
				{ requestId: oversized, attemptId: oversized },
			),
		).toEqual({ retryable: false })
	})

	it("extracts only bounded message text and stops at cyclic nested error envelopes", () => {
		const first: Record<string, unknown> = {}
		const second = { error: first }
		first.error = second
		expect(getApiStreamErrorMessage(first, "Unknown provider error")).toBe("Unknown provider error")
		expect(getApiStreamErrorMessage({ error: { detail: "Actionable failure" }, request: "private-prompt" })).toBe(
			"Actionable failure",
		)
		expect(getApiStreamErrorMessage({ message: "x".repeat(10_000) })).toHaveLength(4_096)
	})
})
