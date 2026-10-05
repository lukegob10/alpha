import { describe, expect, it, vi } from "vitest"

import type { TelemetryClient } from "@alpha-code/types"

import { TelemetryService } from "../TelemetryService"

function createClientWithPendingCleanup() {
	let finishCleanup!: () => void
	let failCleanup!: (error: Error) => void
	const cleanup = new Promise<void>((resolve, reject) => {
		finishCleanup = resolve
		failCleanup = reject
	})
	const client: TelemetryClient = {
		setProvider: vi.fn(),
		capture: vi.fn().mockResolvedValue(undefined),
		captureException: vi.fn().mockResolvedValue(undefined),
		updateTelemetryState: vi.fn(),
		isTelemetryEnabled: vi.fn().mockReturnValue(false),
		shutdown: vi.fn(() => cleanup),
	}

	return { client, cleanup, finishCleanup, failCleanup }
}

describe("TelemetryService", () => {
	it("waits for every client to finish shutdown before resolving", async () => {
		const first = createClientWithPendingCleanup()
		const second = createClientWithPendingCleanup()
		const service = new TelemetryService([first.client, second.client])
		let shutdownFinished = false
		const shutdown = service.shutdown().then(() => {
			shutdownFinished = true
		})

		try {
			await Promise.resolve()
			expect(shutdownFinished).toBe(false)

			first.finishCleanup()
			await first.cleanup
			await Promise.resolve()
			expect(shutdownFinished).toBe(false)

			second.finishCleanup()
			await shutdown
			expect(shutdownFinished).toBe(true)
		} finally {
			first.finishCleanup()
			second.finishCleanup()
			await Promise.all([first.cleanup, second.cleanup, shutdown])
		}
	})

	it("starts every client and reports cleanup failures in registration order after all clients settle", async () => {
		const first = createClientWithPendingCleanup()
		const second = createClientWithPendingCleanup()
		const third = createClientWithPendingCleanup()
		const firstError = new Error("first cleanup failed")
		const secondError = new Error("second cleanup failed")
		second.client.shutdown = vi.fn(() => {
			throw secondError
		})
		const service = new TelemetryService([first.client, second.client, third.client])
		let shutdownFinished = false
		const outcome = service.shutdown().then(
			() => undefined,
			(error: unknown) => error,
		)
		void outcome.then(() => {
			shutdownFinished = true
		})

		try {
			await Promise.resolve()
			expect(first.client.shutdown).toHaveBeenCalledTimes(1)
			expect(second.client.shutdown).toHaveBeenCalledTimes(1)
			expect(third.client.shutdown).toHaveBeenCalledTimes(1)
			first.failCleanup(firstError)
			await first.cleanup.catch(() => undefined)
			await Promise.resolve()
			expect(shutdownFinished).toBe(false)
			third.finishCleanup()
			const error = await outcome
			expect(error).toBeInstanceOf(AggregateError)
			if (!(error instanceof AggregateError)) throw new Error("Missing aggregate cleanup failure")
			expect(error.errors).toEqual([firstError, secondError])
			expect(error.message).toBe("Failed to shut down 2 telemetry clients")
		} finally {
			first.finishCleanup()
			second.finishCleanup()
			third.finishCleanup()
			await Promise.allSettled([first.cleanup, second.cleanup, third.cleanup, outcome])
		}
	})

	it("shares cleanup between concurrent and later shutdown callers", async () => {
		const owned = createClientWithPendingCleanup()
		const service = new TelemetryService([owned.client])
		const first = service.shutdown()
		const second = service.shutdown()
		try {
			expect(second).toBe(first)
			await Promise.resolve()
			expect(owned.client.shutdown).toHaveBeenCalledTimes(1)
			owned.finishCleanup()
			await Promise.all([first, second])
			expect(service.shutdown()).toBe(first)
			expect(owned.client.shutdown).toHaveBeenCalledTimes(1)
		} finally {
			owned.finishCleanup()
			await Promise.allSettled([owned.cleanup, first, second])
		}
	})

	it("preserves the same failed cleanup outcome without retrying clients", async () => {
		const owned = createClientWithPendingCleanup()
		const service = new TelemetryService([owned.client])
		const first = service.shutdown()
		const outcome = first.catch((error: unknown) => error)
		const cleanup = owned.cleanup.catch(() => undefined)
		try {
			owned.failCleanup(new Error("cleanup failed"))
			const error = await outcome
			expect(error).toBeInstanceOf(AggregateError)
			expect(service.shutdown()).toBe(first)
			expect(await service.shutdown().catch((failure: unknown) => failure)).toBe(error)
			expect(owned.client.shutdown).toHaveBeenCalledTimes(1)
		} finally {
			owned.finishCleanup()
			await Promise.allSettled([cleanup, outcome])
		}
	})

	it("shares the shutdown boundary with a reentrant client", async () => {
		const owned = createClientWithPendingCleanup()
		const service = new TelemetryService([owned.client])
		let entered = false
		let nested: Promise<void> | undefined
		owned.client.shutdown = vi.fn(() => {
			if (!entered) {
				entered = true
				nested = service.shutdown()
			}
			return owned.cleanup
		})
		const shutdown = service.shutdown()
		try {
			await Promise.resolve()
			expect(nested).toBe(shutdown)
			expect(owned.client.shutdown).toHaveBeenCalledTimes(1)
			owned.finishCleanup()
			await shutdown
		} finally {
			owned.finishCleanup()
			await Promise.allSettled([owned.cleanup, shutdown, nested])
		}
	})

	it("settles an empty service once and rejects new ownership after shutdown", async () => {
		const service = new TelemetryService([])
		const shutdown = service.shutdown()
		await shutdown
		expect(service.shutdown()).toBe(shutdown)
		const late = createClientWithPendingCleanup()
		expect(() => service.register(late.client)).toThrow("Cannot register a telemetry client after shutdown starts")
		expect(late.client.shutdown).not.toHaveBeenCalled()
		late.finishCleanup()
		await late.cleanup
	})

	it("rejects registration while existing owned cleanup remains pending", async () => {
		const owned = createClientWithPendingCleanup()
		const late = createClientWithPendingCleanup()
		const service = new TelemetryService([owned.client])
		const shutdown = service.shutdown()
		try {
			expect(() => service.register(late.client)).toThrow(
				"Cannot register a telemetry client after shutdown starts",
			)
			expect(late.client.shutdown).not.toHaveBeenCalled()
			owned.finishCleanup()
			await shutdown
		} finally {
			owned.finishCleanup()
			late.finishCleanup()
			await Promise.allSettled([owned.cleanup, late.cleanup, shutdown])
		}
	})
})
