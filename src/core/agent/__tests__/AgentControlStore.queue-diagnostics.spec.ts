import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	AgentControlStore,
	FileAgentControlPersistence,
	type AgentControlTransactionDiagnostic,
} from "../AgentControlStore"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("AgentControlStore queue diagnostics", () => {
	let directory: string
	let persistence: FileAgentControlPersistence
	let store: AgentControlStore
	let diagnostics: AgentControlTransactionDiagnostic[]
	let release: ReturnType<typeof barrier>
	let holding: Promise<unknown> | undefined
	let cancellation: AbortController

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-queue-diagnostics-"))
		diagnostics = []
		persistence = new FileAgentControlPersistence(directory, {
			transactionWaitTimeoutMs: 75,
			maxPendingTransactions: 1,
			onTransactionDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		})
		store = new AgentControlStore(persistence)
		await store.initialize()
		await store.ensureRoot({ taskId: "root", status: "running" })
		diagnostics.length = 0
		release = barrier()
		holding = undefined
		cancellation = new AbortController()
	})

	afterEach(async () => {
		cancellation.abort()
		vi.useRealTimers()
		release.resolve()
		if (holding) await Promise.allSettled([holding])
		vi.restoreAllMocks()
		await store.shutdown()
		await fs.rm(directory, { recursive: true, force: true })
	})

	const blockStoreTransaction = async () => {
		const entered = barrier()
		const read = persistence.read.bind(persistence)
		vi.spyOn(persistence, "read").mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			return read()
		})
		holding = store.updateAgentSnapshot("root", { phase: "holding store queue" })
		await entered.promise
	}

	const reserve = (token = "reservation") =>
		store.reservePrimaryMutation("root", "root", directory, token, { signal: cancellation.signal })

	const reservationDiagnostics = () => diagnostics.filter(({ operation }) => operation === "reserve-primary-mutation")

	const expectQueueFailure = (error: unknown, code: string, outcome: "error" | "cancelled", queueWaitMs: number) => {
		const diagnostic = {
			operation: "reserve-primary-mutation",
			outcome,
			queueWaitMs,
			acquisitionWaitMs: 0,
			holdMs: 0,
			releaseMs: 0,
			attempts: 0,
			ownerState: "none",
			committed: false,
			releaseFailed: false,
		}
		expect(error).toMatchObject({ code, diagnostic })
		expect(reservationDiagnostics()).toEqual([diagnostic])
	}

	it("uses the configured acquisition deadline while still queued in the store", async () => {
		await blockStoreTransaction()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
		let failure: unknown
		const waiting = reserve().catch((error: unknown) => {
			failure = error
		})
		try {
			await vi.advanceTimersByTimeAsync(75)
			expectQueueFailure(failure, "ELOCKED", "error", 75)
			expect(store.getVerificationObligations()).toEqual([])
		} finally {
			cancellation.abort()
			await waiting
		}
	})

	it("reports one cancellation diagnostic before the preceding store transaction releases", async () => {
		await blockStoreTransaction()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
		const waiting = reserve().catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(25)
		cancellation.abort("sensitive caller reason")
		const error = await waiting
		expectQueueFailure(error, "ABORT_ERR", "cancelled", 25)
		expect(JSON.stringify(reservationDiagnostics())).not.toContain("sensitive caller reason")
		expect(store.getVerificationObligations()).toEqual([])
	})

	it("uses the configured pending limit and reports saturation before reaching persistence", async () => {
		await blockStoreTransaction()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
		const pending = reserve("pending").catch((error: unknown) => error)
		let failure: unknown
		const overflow = reserve("overflow").catch((error: unknown) => {
			failure = error
		})
		try {
			await vi.advanceTimersByTimeAsync(0)
			expectQueueFailure(failure, "EQUEUEFULL", "error", 0)
			expect(store.getVerificationObligations()).toEqual([])
		} finally {
			cancellation.abort()
			await Promise.all([pending, overflow])
		}
	})

	it("does not report a second diagnostic when disk acquisition fails", async () => {
		const lockPath = `${persistence.filePath}.transaction.lock`
		await fs.mkdir(lockPath)
		try {
			const error = await reserve().catch((failure: unknown) => failure)
			expect(error).toMatchObject({
				code: "ELOCKLEGACY",
				diagnostic: expect.objectContaining({
					operation: "reserve-primary-mutation",
					outcome: "error",
					ownerState: "legacy",
					holdMs: 0,
					releaseMs: 0,
				}),
			})
			const reported = reservationDiagnostics()
			expect(reported).toHaveLength(1)
			expect(reported[0].attempts).toBeGreaterThan(0)
			expect(reported[0].acquisitionWaitMs).toBeGreaterThan(0)
			expect(error).toMatchObject({ diagnostic: reported[0] })
		} finally {
			await fs.rmdir(lockPath)
		}
	})

	it("does not report a second diagnostic when the admitted reservation body fails", async () => {
		await expect(
			store.reservePrimaryMutation("missing-parent", "root", directory, "must-not-commit"),
		).rejects.toThrow()
		const reported = reservationDiagnostics()
		expect(reported).toHaveLength(1)
		expect(reported[0]).toMatchObject({ outcome: "error", attempts: 1, committed: false, releaseFailed: false })
		expect(store.getVerificationObligations()).toEqual([])
		await expect(fs.stat(`${persistence.filePath}.transaction.lock`)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("reports a successful reservation once with its outer queue wait included", async () => {
		await blockStoreTransaction()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
		const waiting = reserve()
		await vi.advanceTimersByTimeAsync(25)
		release.resolve()
		await Promise.all([holding, waiting])
		const reported = reservationDiagnostics()
		expect(reported).toHaveLength(1)
		expect(reported[0]).toMatchObject({
			operation: "reserve-primary-mutation",
			outcome: "success",
			queueWaitMs: 25,
			acquisitionWaitMs: 0,
			holdMs: 0,
			releaseMs: 0,
			attempts: 1,
			committed: true,
			releaseFailed: false,
		})
		expect(store.getVerificationObligations()[0].mutationReservations).toEqual(["reservation"])
	})

	it("drains a running transaction beyond the admission deadline before releasing its shutdown lease", async () => {
		await blockStoreTransaction()
		const releaseLease = vi.spyOn(persistence, "releaseOwnerLease")
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
		let shutdownCompleted = false
		let shutdownError: unknown
		const shutdown = store.shutdown().then(
			() => {
				shutdownCompleted = true
			},
			(error: unknown) => {
				shutdownError = error
			},
		)
		let admissionError: unknown
		const rejectedAdmission = reserve("after-shutdown").catch((error: unknown) => {
			admissionError = error
		})
		try {
			await vi.advanceTimersByTimeAsync(100)
			expect(shutdownError).toBeUndefined()
			expect(shutdownCompleted).toBe(false)
			expect(releaseLease).not.toHaveBeenCalled()
			expect(admissionError).toMatchObject({ message: expect.stringContaining("shutdown") })
			release.resolve()
			await Promise.all([holding, shutdown, rejectedAdmission])
			expect(shutdownError).toBeUndefined()
			expect(shutdownCompleted).toBe(true)
			expect(releaseLease).toHaveBeenCalledTimes(1)
		} finally {
			cancellation.abort()
			release.resolve()
			await Promise.allSettled([holding, shutdown, rejectedAdmission])
		}
	})

	it("joins concurrent shutdown callers until the single lease release completes", async () => {
		const entered = barrier()
		const finishRelease = barrier()
		const originalRelease = persistence.releaseOwnerLease.bind(persistence)
		const releaseLease = vi.spyOn(persistence, "releaseOwnerLease").mockImplementation(async (ownerId) => {
			entered.resolve()
			await finishRelease.promise
			await originalRelease(ownerId)
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let firstCompleted = false
		let secondCompleted = false
		const first = store.shutdown().then(() => {
			firstCompleted = true
		})
		await entered.promise
		const second = store.shutdown().then(() => {
			secondCompleted = true
		})

		try {
			await vi.advanceTimersByTimeAsync(0)
			expect(releaseLease).toHaveBeenCalledTimes(1)
			expect(firstCompleted).toBe(false)
			expect(secondCompleted).toBe(false)
			finishRelease.resolve()
			await Promise.all([first, second])
			expect(firstCompleted).toBe(true)
			expect(secondCompleted).toBe(true)
			expect(releaseLease).toHaveBeenCalledTimes(1)
		} finally {
			finishRelease.resolve()
			await Promise.allSettled([first, second])
		}
	})
})
