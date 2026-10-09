import { withEmbeddingTimeout } from "../embedding-request"
import { EMBEDDING_REQUEST_TIMEOUT_MS } from "../../constants"

afterEach(() => vi.useRealTimers())

it("bounds an unresponsive request and releases its owned deadline", async () => {
	vi.useFakeTimers()
	let signal: AbortSignal | undefined
	const run = withEmbeddingTimeout(async (requestSignal) => {
		signal = requestSignal
		return new Promise<void>(() => {})
	})
	const failed = expect(run).rejects.toThrow(/timeout/i)
	await vi.advanceTimersByTimeAsync(EMBEDDING_REQUEST_TIMEOUT_MS)
	await failed
	expect(signal?.aborted).toBe(true)
	expect(vi.getTimerCount()).toBe(0)
})

it("cancels promptly when the caller aborts even if the request ignores cancellation", async () => {
	vi.useFakeTimers()
	const controller = new AbortController()
	const run = withEmbeddingTimeout(async () => new Promise<void>(() => {}), controller.signal)
	const failed = expect(run).rejects.toMatchObject({ name: "AbortError" })
	controller.abort()
	await failed
	expect(vi.getTimerCount()).toBe(0)
})

it("clears the deadline for a successful request", async () => {
	vi.useFakeTimers()
	await expect(withEmbeddingTimeout(async () => "done")).resolves.toBe("done")
	expect(vi.getTimerCount()).toBe(0)
})
