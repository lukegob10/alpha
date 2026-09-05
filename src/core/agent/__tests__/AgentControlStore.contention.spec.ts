import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { fork } from "child_process"
import { build } from "esbuild"

import { agentControlStateSchema, type AgentControlState } from "@alpha-code/types"

import { AgentControlStore, FileAgentControlPersistence } from "../AgentControlStore"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const emptyState = (): AgentControlState => ({
	version: 2,
	updatedAt: 1,
	nextSequence: 1,
	agents: [],
	tombstones: [],
	mailbox: [],
	mailboxCursors: {},
	verificationObligations: [],
})

describe("Agent control transaction contention", () => {
	let directory: string

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-contention-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("waits beyond the former 2550ms retry budget for a healthy holder", async () => {
		const holder = new FileAgentControlPersistence(directory)
		const contender = new FileAgentControlPersistence(directory)
		const entered = barrier()
		const release = barrier()
		const holding = holder.withTransaction(async () => {
			entered.resolve()
			await release.promise
			return "holder completed"
		})
		await entered.promise

		// Advance the contention workload independently of real filesystem latency.
		// Long admission-deadline timers remain pending while each short retry runs.
		const schedule = globalThis.setTimeout
		let elapsedMs = 0
		vi.spyOn(performance, "now").mockImplementation(() => elapsedMs)
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
			if (typeof delay !== "number" || delay > 1_000) return schedule(callback, delay, ...args)
			return schedule(() => {
				elapsedMs += delay
				if (elapsedMs >= 3_000) release.resolve()
				callback(...args)
			}, 0)
		})

		try {
			await expect(contender.withTransaction(async () => "contender completed")).resolves.toBe(
				"contender completed",
			)
			expect(elapsedMs).toBeGreaterThanOrEqual(3_000)
			await expect(holding).resolves.toBe("holder completed")
			await expect(fs.stat(`${holder.filePath}.transaction.lock`)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			release.resolve()
			await holding
		}
	})

	it("serializes independent instances and preserves every read-modify-write update", async () => {
		const instances = Array.from({ length: 4 }, () => new FileAgentControlPersistence(directory))
		await instances[0].withTransaction(() => instances[0].write(emptyState()))
		const entered = barrier()
		const release = barrier()
		let active = 0
		let maximumActive = 0
		const run = (persistence: FileAgentControlPersistence, first = false) =>
			persistence.withTransaction(async () => {
				active++
				maximumActive = Math.max(maximumActive, active)
				try {
					const state = agentControlStateSchema.parse(await persistence.read())
					if (first) {
						entered.resolve()
						await release.promise
					}
					state.nextSequence++
					await persistence.write(state)
					return state.nextSequence
				} finally {
					active--
				}
			})
		const first = run(instances[0], true)
		await entered.promise
		const remaining = instances.slice(1).map((instance) => run(instance))
		release.resolve()

		const results = await Promise.all([first, ...remaining])
		expect(results.sort((left, right) => left - right)).toEqual([2, 3, 4, 5])
		expect(maximumActive).toBe(1)
		expect(agentControlStateSchema.parse(await instances[0].read()).nextSequence).toBe(5)
		await expect(fs.stat(`${instances[0].filePath}.transaction.lock`)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("cancels acquisition without running the callback or removing the live holder", async () => {
		const holder = new FileAgentControlPersistence(directory)
		const contender = new FileAgentControlPersistence(directory)
		const entered = barrier()
		const release = barrier()
		const holding = holder.withTransaction(async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		const ownerPath = path.join(`${holder.filePath}.transaction.lock`, "owner.json")
		const ownerBefore = await fs.readFile(ownerPath, "utf8")
		const cancellation = new AbortController()
		const operation = vi.fn(async () => "must not run")
		const acquisitionStarted = barrier()
		const internals = contender as unknown as { observeTransactionLockForAcquisition(): Promise<unknown> }
		const observe = internals.observeTransactionLockForAcquisition.bind(contender)
		vi.spyOn(internals, "observeTransactionLockForAcquisition").mockImplementation(async () => {
			const owner = await observe()
			acquisitionStarted.resolve()
			return owner
		})
		const waiting = contender.withTransaction(operation, { signal: cancellation.signal, operation: "mutation" })
		const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" })

		try {
			await acquisitionStarted.promise
			cancellation.abort()
			await rejected
			expect(operation).not.toHaveBeenCalled()
			expect(await fs.readFile(ownerPath, "utf8")).toBe(ownerBefore)
		} finally {
			cancellation.abort()
			release.resolve()
			await Promise.allSettled([holding, waiting])
		}
		await expect(contender.withTransaction(async () => "recovered")).resolves.toBe("recovered")
	})

	it("removes a cancelled queued operation and admits its successor on the same instance", async () => {
		const persistence = new FileAgentControlPersistence(directory, { maxPendingTransactions: 1 })
		const entered = barrier()
		const release = barrier()
		const holding = persistence.withTransaction(async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		const cancellation = new AbortController()
		const cancelledOperation = vi.fn(async () => "must not run")
		const waiting = persistence.withTransaction(cancelledOperation, { signal: cancellation.signal })
		const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" })

		try {
			const overflow = vi.fn(async () => "must not run")
			await expect(persistence.withTransaction(overflow)).rejects.toMatchObject({ code: "EQUEUEFULL" })
			expect(overflow).not.toHaveBeenCalled()
			cancellation.abort()
			await rejected
			expect(cancelledOperation).not.toHaveBeenCalled()
			const successor = persistence.withTransaction(async () => "successor")
			release.resolve()
			await holding
			await expect(successor).resolves.toBe("successor")
		} finally {
			cancellation.abort()
			release.resolve()
			await Promise.allSettled([holding, waiting])
		}
	})

	it("cancels a primary mutation reservation queued above persistence without committing it later", async () => {
		const persistence = new FileAgentControlPersistence(directory)
		const store = new AgentControlStore(persistence)
		const entered = barrier()
		const release = barrier()
		const cancellation = new AbortController()
		let holding: Promise<unknown> | undefined
		let reservation: Promise<void> | undefined

		try {
			await store.initialize()
			await store.ensureRoot({ taskId: "root", status: "running" })
			const read = persistence.read.bind(persistence)
			vi.spyOn(persistence, "read").mockImplementationOnce(async () => {
				entered.resolve()
				await release.promise
				return read()
			})
			holding = store.updateAgentSnapshot("root", { phase: "holding transaction" })
			await entered.promise
			reservation = store.reservePrimaryMutation("root", "root", directory, "cancelled-reservation", {
				signal: cancellation.signal,
			})
			const rejected = expect(reservation).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" })
			cancellation.abort()
			// Cancellation must settle while the preceding store transaction is still blocked.
			await rejected
			expect(store.getVerificationObligations()).toEqual([])
			release.resolve()
			await holding
			expect(agentControlStateSchema.parse(await persistence.read()).verificationObligations).toEqual([])

			await store.reservePrimaryMutation("root", "root", directory, "successor-reservation")
			const persisted = agentControlStateSchema.parse(await persistence.read())
			expect(persisted.verificationObligations).toHaveLength(1)
			expect(persisted.verificationObligations[0].mutationReservations).toEqual(["successor-reservation"])
			await store.releasePrimaryMutation("root", "root", "successor-reservation")
		} finally {
			cancellation.abort()
			release.resolve()
			await Promise.allSettled([holding, reservation])
			await store.shutdown()
		}
	})

	it("reports an acquisition deadline and admits a later retry without stealing ownership", async () => {
		const holder = new FileAgentControlPersistence(directory)
		const diagnostic = vi.fn()
		const contender = new FileAgentControlPersistence(directory, {
			transactionWaitTimeoutMs: 75,
			onTransactionDiagnostic: diagnostic,
		})
		const entered = barrier()
		const release = barrier()
		const holding = holder.withTransaction(async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		const ownerPath = path.join(`${holder.filePath}.transaction.lock`, "owner.json")
		const ownerBefore = await fs.readFile(ownerPath, "utf8")
		const operation = vi.fn(async () => "must not run")

		try {
			await expect(contender.withTransaction(operation, { operation: "mutation" })).rejects.toMatchObject({
				code: "ELOCKED",
			})
			expect(operation).not.toHaveBeenCalled()
			expect(await fs.readFile(ownerPath, "utf8")).toBe(ownerBefore)
			expect(diagnostic).toHaveBeenCalledWith(
				expect.objectContaining({
					operation: "mutation",
					outcome: "error",
					ownerState: "live",
					committed: false,
				}),
			)
		} finally {
			release.resolve()
			await holding
		}
		await expect(contender.withTransaction(async () => "retry succeeded")).resolves.toBe("retry succeeded")
	})

	it.each([
		["traversal token", JSON.stringify({ token: "../escape", pid: 2_147_483_647 })],
		["Windows traversal token", JSON.stringify({ token: "..\\escape", pid: 2_147_483_647 })],
		["oversized token", JSON.stringify({ token: "x".repeat(129), pid: 2_147_483_647 })],
		["out-of-range PID", JSON.stringify({ token: "owner", pid: 2_147_483_648 })],
		["malformed JSON", "{secret-invalid-metadata"],
		["oversized JSON", JSON.stringify({ token: "owner", pid: process.pid, padding: "x".repeat(1_024) })],
	])("rejects %s metadata without moving the lock or exposing its content", async (_label, serialized) => {
		const diagnostic = vi.fn()
		const persistence = new FileAgentControlPersistence(directory, {
			transactionWaitTimeoutMs: 30,
			onTransactionDiagnostic: diagnostic,
		})
		const lockPath = `${persistence.filePath}.transaction.lock`
		await fs.mkdir(lockPath)
		await fs.writeFile(path.join(lockPath, "owner.json"), serialized, "utf8")
		await fs.writeFile(path.join(directory, "sentinel"), "preserve external content", "utf8")
		const contentsBefore = await fs.readdir(directory)
		const operation = vi.fn(async () => "must not run")

		await expect(persistence.withTransaction(operation)).rejects.toMatchObject({
			code: "ELOCKOWNER",
			message: expect.stringContaining("Close all Alpha extension hosts"),
		})
		expect(operation).not.toHaveBeenCalled()
		expect(await fs.readdir(directory)).toEqual(contentsBefore)
		expect(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(serialized)
		expect(await fs.readFile(path.join(directory, "sentinel"), "utf8")).toBe("preserve external content")
		expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ ownerState: "unreadable", outcome: "error" }))
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(serialized)
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(directory)
	})

	it("gives actionable offline repair instructions for an unchanged legacy ownerless lock", async () => {
		const persistence = new FileAgentControlPersistence(directory, { transactionWaitTimeoutMs: 30 })
		const lockPath = `${persistence.filePath}.transaction.lock`
		await fs.mkdir(lockPath)

		await expect(persistence.withTransaction(async () => "must not run")).rejects.toMatchObject({
			code: "ELOCKLEGACY",
			message: expect.stringContaining("Do not remove it while any host is running"),
		})
		expect(await fs.readdir(lockPath)).toEqual([])
	})

	it("excludes unrecognized owner operation text from diagnostics", async () => {
		const diagnostic = vi.fn()
		const persistence = new FileAgentControlPersistence(directory, {
			transactionWaitTimeoutMs: 30,
			onTransactionDiagnostic: diagnostic,
		})
		const lockPath = `${persistence.filePath}.transaction.lock`
		await fs.mkdir(lockPath)
		const owner = { token: "external-owner", pid: process.pid, operation: "secret command text" }
		await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf8")

		await expect(persistence.withTransaction(async () => "must not run")).rejects.toMatchObject({ code: "ELOCKED" })
		expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ ownerState: "live", ownerPid: process.pid }))
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(owner.operation)
	})

	it("reports hold time separately from release time", async () => {
		let elapsedMs = 0
		vi.spyOn(performance, "now").mockImplementation(() => elapsedMs)
		const diagnostic = vi.fn()
		const persistence = new FileAgentControlPersistence(directory, { onTransactionDiagnostic: diagnostic })
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
		}
		const rename = internals.renameTransactionLock.bind(persistence)
		vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
			elapsedMs += 23
			await rename(source, destination)
		})

		await expect(
			persistence.withTransaction(async () => {
				elapsedMs += 17
				return "completed"
			}),
		).resolves.toBe("completed")
		expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				outcome: "success",
				queueWaitMs: 0,
				acquisitionWaitMs: 0,
				holdMs: 17,
				releaseMs: 23,
				releaseFailed: false,
			}),
		)
	})

	it("preserves concurrent read-modify-write updates from actual persistence in separate processes", async () => {
		const persistence = new FileAgentControlPersistence(directory)
		await persistence.withTransaction(() => persistence.write(emptyState()))
		const bundledWriter = path.join(directory, "contention-writer.cjs")
		await build({
			entryPoints: [path.join(__dirname, "fixtures", "agent-control-contention-writer.ts")],
			outfile: bundledWriter,
			bundle: true,
			platform: "node",
			format: "cjs",
			logLevel: "silent",
		})
		const child = fork(bundledWriter, [directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
		const exited = new Promise<number | null>((resolve) => {
			child.once("exit", (code) => resolve(code))
			child.once("error", () => resolve(null))
		})
		const holding = new Promise<void>((resolve, reject) => {
			child.once("message", (message) =>
				message === "holding" ? resolve() : reject(new Error("Unexpected message")),
			)
			child.once("error", reject)
			child.once("exit", () => reject(new Error("Writer exited before taking its transaction lock")))
		})
		const observedContention = barrier()
		const internals = persistence as unknown as { observeTransactionLockForAcquisition(): Promise<unknown> }
		const observe = internals.observeTransactionLockForAcquisition.bind(persistence)
		vi.spyOn(internals, "observeTransactionLockForAcquisition").mockImplementation(async () => {
			const owner = await observe()
			observedContention.resolve()
			return owner
		})
		const cancellation = new AbortController()
		let updates: Promise<void> | undefined

		try {
			await holding
			updates = (async () => {
				for (let update = 0; update < 3; update++) {
					await persistence.withTransaction(
						async () => {
							const state = agentControlStateSchema.parse(await persistence.read())
							state.nextSequence++
							await persistence.write(state)
						},
						{ signal: cancellation.signal },
					)
				}
			})()
			await observedContention.promise
			child.send("release")
			await updates
			expect(await exited).toBe(0)
			expect(agentControlStateSchema.parse(await persistence.read()).nextSequence).toBe(7)
			await expect(fs.stat(`${persistence.filePath}.transaction.lock`)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			cancellation.abort()
			if (child.exitCode === null && child.signalCode === null) child.kill()
			await exited
			if (updates) await Promise.allSettled([updates])
		}
	})

	it("waits for a real foreign process and recovers only after that process exits", async () => {
		const persistence = new FileAgentControlPersistence(directory)
		const lockPath = `${persistence.filePath}.transaction.lock`
		const child = fork(path.join(__dirname, "fixtures", "agent-control-contention-holder.cjs"), [lockPath], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		})
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve())
			child.once("error", () => resolve())
		})
		const ready = new Promise<void>((resolve, reject) => {
			child.once("message", (message) =>
				message === "ready" ? resolve() : reject(new Error("Unexpected message")),
			)
			child.once("error", reject)
			child.once("exit", () => reject(new Error("Lock holder exited before becoming ready")))
		})
		const observedLiveOwner = barrier()
		const internals = persistence as unknown as { observeTransactionLockForAcquisition(): Promise<unknown> }
		const observe = internals.observeTransactionLockForAcquisition.bind(persistence)
		vi.spyOn(internals, "observeTransactionLockForAcquisition").mockImplementation(async () => {
			const owner = await observe()
			observedLiveOwner.resolve()
			return owner
		})
		const operation = vi.fn(async () => "recovered after process exit")
		const cancellation = new AbortController()
		let waiting: Promise<string> | undefined

		try {
			await ready
			waiting = persistence.withTransaction(operation, { signal: cancellation.signal })
			await observedLiveOwner.promise
			expect(operation).not.toHaveBeenCalled()
			expect(JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"))).toMatchObject({
				token: "cross-process-holder",
				pid: child.pid,
			})
			child.kill()
			await exited
			await expect(waiting).resolves.toBe("recovered after process exit")
			expect(operation).toHaveBeenCalledTimes(1)
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			cancellation.abort()
			if (child.exitCode === null && child.signalCode === null) child.kill()
			await exited
			if (waiting) await Promise.allSettled([waiting])
		}
	})
})
