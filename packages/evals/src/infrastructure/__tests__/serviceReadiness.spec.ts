import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), connect: vi.fn(), ping: vi.fn(), destroy: vi.fn() }))
vi.mock("postgres", () => ({ default: () => Object.assign(mocks.query, { end: mocks.end }) }))
vi.mock("redis", () => ({ createClient: () => ({ ...mocks, isOpen: true, on: vi.fn() }) }))
import { checkServices } from "../serviceReadiness"
beforeEach(() => {
	vi.clearAllMocks()
	mocks.query.mockResolvedValue([])
	mocks.connect.mockResolvedValue(undefined)
})
it("requires explicit endpoints", async () => {
	await expect(checkServices({})).rejects.toThrow("required")
	expect(mocks.query).not.toHaveBeenCalled()
})
it("uses read-only probes and closes both clients", async () => {
	await checkServices({ DATABASE_URL: "postgres://secret", REDIS_URL: "redis://secret" })
	expect(mocks.query.mock.calls[0]?.[0]).toEqual(["SELECT 1"])
	expect(mocks.ping).toHaveBeenCalledOnce()
	expect(mocks.destroy).toHaveBeenCalledOnce()
	expect(mocks.end).toHaveBeenCalledOnce()
})
it("sanitizes failures and closes clients", async () => {
	mocks.query.mockRejectedValueOnce(new Error("postgres://user:secret@host"))
	await expect(checkServices({ DATABASE_URL: "x", REDIS_URL: "y" })).rejects.toThrow(
		"Evaluator service readiness failed",
	)
	expect(mocks.destroy).toHaveBeenCalledOnce()
	expect(mocks.end).toHaveBeenCalledOnce()
})

it("bounds a stalled service probe and still closes clients", async () => {
	vi.useFakeTimers()
	try {
		mocks.query.mockImplementationOnce(() => new Promise(() => {}))
		const rejected = expect(checkServices({ DATABASE_URL: "x", REDIS_URL: "y" })).rejects.toThrow(
			"Evaluator service readiness failed",
		)
		await vi.advanceTimersByTimeAsync(6000)
		await rejected
		expect(mocks.destroy).toHaveBeenCalledOnce()
		expect(mocks.end).toHaveBeenCalledWith({ timeout: 1 })
	} finally {
		vi.useRealTimers()
	}
})
