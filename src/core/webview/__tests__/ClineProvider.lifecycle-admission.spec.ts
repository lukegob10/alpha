import * as os from "os"

import {
	AgentControlStore,
	InMemoryAgentControlPersistence,
	type AgentControlTransactionDiagnostic,
} from "../../agent/AgentControlStore"
import { AgentControlTransactionError, createTransactionDiagnostic } from "../../agent/AgentControlTransaction"
import type { Task } from "../../task/Task"
import { ClineProvider } from "../ClineProvider"

const barrier = () => {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((complete, fail) => {
		resolve = complete
		reject = fail
	})
	return { promise, resolve, reject }
}

describe("ClineProvider lifecycle admission", () => {
	let store: AgentControlStore
	let persistence: InMemoryAgentControlPersistence
	let provider: ClineProvider
	let task: Task
	let cancellation: AbortController
	let previous: ReturnType<typeof barrier>
	let blockedWrite: ReturnType<typeof barrier> | undefined
	let writerSettled: boolean
	let diagnostics: AgentControlTransactionDiagnostic[]
	let owned: Promise<unknown>[]

	beforeEach(async () => {
		diagnostics = []
		persistence = Object.assign(new InMemoryAgentControlPersistence(), {
			transactionWaitTimeoutMs: 50,
			reportTransactionDiagnostic: (diagnostic: AgentControlTransactionDiagnostic) =>
				diagnostics.push(diagnostic),
		})
		store = new AgentControlStore(persistence)
		await store.initialize()
		await store.ensureRoot({ taskId: "root", status: "running" })
		cancellation = new AbortController()
		previous = barrier()
		blockedWrite = undefined
		writerSettled = false
		const sharedWrite = previous.promise.then(() => {
			writerSettled = true
		})
		owned = [sharedWrite]
		provider = Object.assign(Object.create(ClineProvider.prototype), {
			agentControlStore: store,
			agentControlStoreReady: Promise.resolve(),
			agentControlRootStatusWrites: new Map([["root", sharedWrite]]),
		}) as ClineProvider
		task = {
			taskId: "root",
			taskKind: "primary",
			cwd: os.tmpdir(),
			getTaskLifetimeCancellationSignal: () => cancellation.signal,
		} as unknown as Task
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
	})

	afterEach(async () => {
		cancellation.abort()
		previous.resolve()
		blockedWrite?.resolve()
		await Promise.allSettled(owned)
		vi.useRealTimers()
		await store.shutdown()
		vi.restoreAllMocks()
	})

	const reserve = () => {
		const result: { error?: unknown } = {}
		const waiting = provider.reservePrimaryMutation(task, "reservation").catch((error: unknown) => {
			result.error = error
		})
		owned.push(waiting)
		return { result, waiting }
	}

	const expectFailure = (error: unknown, code: string, queueWaitMs: number) => {
		expect(error).toMatchObject({
			code,
			diagnostic: {
				operation: "reserve-primary-mutation",
				outcome: code === "ABORT_ERR" ? "cancelled" : "error",
				queueWaitMs,
				attempts: 0,
				committed: false,
				acquisitionWaitMs: 0,
				holdMs: 0,
				releaseMs: 0,
			},
		})
		expect(diagnostics).toHaveLength(1)
		expect(error).toMatchObject({ diagnostic: diagnostics[0] })
		expect(store.getVerificationObligations()).toEqual([])
	}

	it("cancels a reservation before the shared lifecycle writer settles", async () => {
		const ensureRoot = vi.spyOn(store, "ensureRoot")
		const { result, waiting } = reserve()
		await vi.advanceTimersByTimeAsync(20)
		cancellation.abort("private caller reason")
		await vi.advanceTimersByTimeAsync(0)
		expectFailure(result.error, "ABORT_ERR", 20)
		expect(ensureRoot).not.toHaveBeenCalled()
		expect(writerSettled).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
		expect(JSON.stringify(diagnostics)).not.toContain("private caller reason")
		previous.resolve()
		await waiting
		await owned[0]
		expect(writerSettled).toBe(true)
	})

	it("expires the configured admission budget without cancelling the shared writer", async () => {
		const { result } = reserve()
		await vi.advanceTimersByTimeAsync(50)
		expectFailure(result.error, "ELOCKED", 50)
		expect(writerSettled).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects an already-aborted reservation without joining the shared writer", async () => {
		const ensureRoot = vi.spyOn(store, "ensureRoot")
		cancellation.abort()
		const { result, waiting } = reserve()
		await waiting
		expectFailure(result.error, "ABORT_ERR", 0)
		expect(ensureRoot).not.toHaveBeenCalled()
		expect(writerSettled).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects an exhausted incoming budget without joining the shared writer", async () => {
		const error = await store
			.waitForTransactionPrerequisite(owned[0], {
				operation: "reserve-primary-mutation",
				queueWaitMs: 50,
				signal: cancellation.signal,
			})
			.catch((failure: unknown) => failure)
		expectFailure(error, "ELOCKED", 50)
		expect(writerSettled).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("passes prerequisite elapsed time once into the next store acquisition", async () => {
		const ensureRoot = vi.spyOn(store, "ensureRoot")
		const { result, waiting } = reserve()
		await vi.advanceTimersByTimeAsync(20)
		previous.resolve()
		await waiting
		expect(result.error).toBeUndefined()
		expect(ensureRoot).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				operation: "reserve-primary-mutation",
				queueWaitMs: 20,
				signal: cancellation.signal,
			}),
		)
		expect(store.getVerificationObligations()[0].mutationReservations).toEqual(["reservation"])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("shares one budget between the lifecycle join and a subsequent blocked store queue", async () => {
		const entered = barrier()
		blockedWrite = barrier()
		const write = persistence.write.bind(persistence)
		// In-memory transactions use the local snapshot and only touch persistence on write.
		vi.spyOn(persistence, "write").mockImplementationOnce(async (state) => {
			entered.resolve()
			await blockedWrite!.promise
			return write(state)
		})
		owned.push(store.updateAgentSnapshot("root", { phase: "hold store queue" }))
		await entered.promise
		const { result } = reserve()
		await vi.advanceTimersByTimeAsync(20)
		previous.resolve()
		await vi.advanceTimersByTimeAsync(0)
		expect(writerSettled).toBe(true)
		await vi.advanceTimersByTimeAsync(29)
		expect(result.error).toBeUndefined()
		await vi.advanceTimersByTimeAsync(1)
		expectFailure(result.error, "ELOCKED", 50)
	})

	it("preserves a shared writer failure without replacing or duplicating its diagnostic", async () => {
		const failure = new AgentControlTransactionError("Original writer failed", "ELOCKED")
		const originalDiagnostic = createTransactionDiagnostic({ operation: "mutation", queueWaitMs: 10 })
		failure.diagnostic = originalDiagnostic
		const { result, waiting } = reserve()
		await vi.advanceTimersByTimeAsync(0)
		previous.reject(failure)
		await waiting
		expect(result.error).toBe(failure)
		expect(failure.diagnostic).toBe(originalDiagnostic)
		expect(diagnostics).toEqual([])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("observes a late shared rejection after caller cancellation", async () => {
		const { result, waiting } = reserve()
		await vi.advanceTimersByTimeAsync(0)
		cancellation.abort()
		await waiting
		expectFailure(result.error, "ABORT_ERR", 0)
		previous.reject(new Error("Late writer failure"))
		await Promise.allSettled(owned)
		expect(diagnostics).toHaveLength(1)
	})
})
