import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	client: {
		on: vi.fn(),
		connect: vi.fn(),
		quit: vi.fn(),
		set: vi.fn(),
		get: vi.fn(),
		eval: vi.fn(),
		isOpen: true,
	},
}))
vi.mock("redis", () => ({ createClient: () => mocks.client }))

import { assertHeartbeatOwnership, disconnectRedis, getHeartbeatKey, startHeartbeat, stopHeartbeat } from "../redis"

const keys = new Map<string, string>()
beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
	keys.clear()
	mocks.client.set.mockImplementation(async (key: string, value: string) => {
		if (keys.has(key)) return null
		keys.set(key, value)
		return "OK"
	})
	mocks.client.get.mockImplementation(async (key: string) => keys.get(key) ?? null)
	mocks.client.eval.mockImplementation(async (script: string, input: { keys: string[]; arguments: string[] }) => {
		const key = input.keys[0]!
		if (keys.get(key) !== input.arguments[0]) return 0
		if (script.includes("'DEL'")) keys.delete(key)
		return 1
	})
})
afterEach(async () => {
	vi.clearAllTimers()
	vi.useRealTimers()
	await disconnectRedis()
})

describe("exclusive evaluation controller heartbeat", () => {
	it("rejects a concurrent controller instead of overwriting its lease", async () => {
		const heartbeat = await startHeartbeat(1)
		await expect(startHeartbeat(1)).rejects.toThrow("active controller")
		await assertHeartbeatOwnership(1, heartbeat)
		await stopHeartbeat(1, heartbeat)
		expect(keys.has(getHeartbeatKey(1))).toBe(false)
	})

	it("does not renew or delete a replacement controller's lease", async () => {
		const lost = vi.fn()
		const heartbeat = await startHeartbeat(1, 10, lost)
		keys.set(getHeartbeatKey(1), "replacement-controller")
		await vi.advanceTimersByTimeAsync(5000)
		expect(lost).toHaveBeenCalledOnce()
		await expect(assertHeartbeatOwnership(1, heartbeat)).rejects.toThrow("lost its controller lease")
		await stopHeartbeat(1, heartbeat)
		expect(keys.get(getHeartbeatKey(1))).toBe("replacement-controller")
	})

	it("notifies cancellation once when renewal becomes uncertain", async () => {
		const lost = vi.fn()
		const heartbeat = await startHeartbeat(1, 10, lost)
		mocks.client.eval.mockRejectedValue(new Error("Redis unavailable"))
		await vi.advanceTimersByTimeAsync(10000)
		expect(lost).toHaveBeenCalledOnce()
		await expect(assertHeartbeatOwnership(1, heartbeat)).rejects.toThrow("lost its controller lease")
	})

	it("expires locally without queuing unbounded renewals when Redis never answers", async () => {
		const lost = vi.fn()
		const heartbeat = await startHeartbeat(1, 10, lost)
		mocks.client.eval.mockImplementation(() => new Promise(() => {}))
		await vi.advanceTimersByTimeAsync(20000)
		expect(lost).toHaveBeenCalledOnce()
		expect(mocks.client.eval).toHaveBeenCalledOnce()
		await expect(assertHeartbeatOwnership(1, heartbeat)).rejects.toThrow("lost its controller lease")
	})
})
