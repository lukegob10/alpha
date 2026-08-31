import type { NextRequest } from "next/server"

import { SSEStream } from "@/lib/server/sse-stream"

const mocks = vi.hoisted(() => ({
	findRun: vi.fn(),
	redisClient: vi.fn(),
}))

vi.mock("@alpha-code/evals", () => ({ findRun: mocks.findRun }))
vi.mock("@alpha-code/types", () => ({ taskEventSchema: { parse: (value: unknown) => value } }))
vi.mock("@/lib/server/redis", () => ({ redisClient: mocks.redisClient }))
vi.mock("@/lib/server/sse-stream", async () => vi.importActual("../../../../../../lib/server/sse-stream"))

import { GET } from "../route"

type RedisMessageListener = (data: string) => void | Promise<void>

function createSubscriber() {
	let listener: RedisMessageListener | undefined
	const on = vi.fn()
	const client = {
		isOpen: false,
		on,
		connect: vi.fn(async () => {
			client.isOpen = true
		}),
		subscribe: vi.fn(async (_channel: string, nextListener: RedisMessageListener) => {
			listener = nextListener
		}),
		unsubscribe: vi.fn().mockResolvedValue(undefined),
		close: vi.fn(async () => {
			client.isOpen = false
		}),
		destroy: vi.fn(() => {
			client.isOpen = false
		}),
	}
	on.mockReturnValue(client)

	return { client, getListener: () => listener }
}

function request(signal: AbortSignal): NextRequest {
	return { signal } as NextRequest
}

const params = { params: Promise.resolve({ id: "42" }) }

describe("run event stream", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findRun.mockResolvedValue({ id: 42 })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("isolates Redis subscriptions and abort cleanup between concurrent streams", async () => {
		const first = createSubscriber()
		const second = createSubscriber()
		const duplicate = vi.fn().mockReturnValueOnce(first.client).mockReturnValueOnce(second.client)
		mocks.redisClient.mockResolvedValue({ duplicate })
		const firstController = new AbortController()
		const secondController = new AbortController()

		const firstResponse = await GET(request(firstController.signal), params)
		const secondResponse = await GET(request(secondController.signal), params)

		expect(firstResponse.headers.get("Content-Type")).toBe("text/event-stream")
		expect(secondResponse.headers.get("Content-Type")).toBe("text/event-stream")
		expect(duplicate).toHaveBeenCalledTimes(2)
		expect(first.client.connect).toHaveBeenCalledOnce()
		expect(second.client.connect).toHaveBeenCalledOnce()
		expect(first.client.subscribe).toHaveBeenCalledWith("evals:42", expect.any(Function))
		expect(second.client.subscribe).toHaveBeenCalledWith("evals:42", expect.any(Function))

		firstController.abort()
		await vi.waitFor(() => expect(first.client.close).toHaveBeenCalledOnce())

		expect(first.client.unsubscribe).toHaveBeenCalledWith("evals:42", first.getListener())
		expect(second.client.unsubscribe).not.toHaveBeenCalled()
		expect(second.client.close).not.toHaveBeenCalled()

		secondController.abort()
		await vi.waitFor(() => expect(second.client.close).toHaveBeenCalledOnce())
	})

	it("closes only the owning subscriber when an SSE write fails", async () => {
		const first = createSubscriber()
		const second = createSubscriber()
		const duplicate = vi.fn().mockReturnValueOnce(first.client).mockReturnValueOnce(second.client)
		mocks.redisClient.mockResolvedValue({ duplicate })
		const firstController = new AbortController()
		const secondController = new AbortController()
		await GET(request(firstController.signal), params)
		await GET(request(secondController.signal), params)
		vi.spyOn(SSEStream.prototype, "write").mockResolvedValueOnce(false)

		await first.getListener()?.(JSON.stringify({ eventName: "taskStarted", payload: ["roo-task"], taskId: 1 }))

		expect(first.client.unsubscribe).toHaveBeenCalledWith("evals:42", first.getListener())
		expect(first.client.close).toHaveBeenCalledOnce()
		expect(second.client.unsubscribe).not.toHaveBeenCalled()
		expect(second.client.close).not.toHaveBeenCalled()

		secondController.abort()
		await vi.waitFor(() => expect(second.client.close).toHaveBeenCalledOnce())
	})

	it("preserves a connect error without destroying an already-closed subscriber", async () => {
		const subscriber = createSubscriber()
		subscriber.client.connect.mockRejectedValueOnce(new Error("Redis unavailable"))
		mocks.redisClient.mockResolvedValue({ duplicate: vi.fn().mockReturnValue(subscriber.client) })

		await expect(GET(request(new AbortController().signal), params)).rejects.toThrow("Redis unavailable")
		expect(subscriber.client.destroy).not.toHaveBeenCalled()
		expect(subscriber.client.subscribe).not.toHaveBeenCalled()
	})

	it("destroys an open subscriber when subscription setup fails", async () => {
		const subscriber = createSubscriber()
		subscriber.client.subscribe.mockRejectedValueOnce(new Error("Subscription unavailable"))
		mocks.redisClient.mockResolvedValue({ duplicate: vi.fn().mockReturnValue(subscriber.client) })

		await expect(GET(request(new AbortController().signal), params)).rejects.toThrow("Subscription unavailable")
		expect(subscriber.client.destroy).toHaveBeenCalledOnce()
	})
})
