import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"
import { setImmediate } from "timers/promises"

import type { AgentControlState } from "@alpha-code/types"

import { FileAgentControlPersistence } from "../AgentControlStore"

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const state = (updatedAt: number): AgentControlState => ({
	version: 2,
	updatedAt,
	nextSequence: 1,
	agents: [],
	tombstones: [],
	mailbox: [],
	mailboxCursors: {},
	verificationObligations: [],
})

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("FileAgentControlPersistence fenced replacement", () => {
	let directory: string
	let persistence: FileAgentControlPersistence
	let actualFs: typeof import("fs")
	let platform: PropertyDescriptor

	beforeEach(async () => {
		actualFs = await vi.importActual<typeof import("fs")>("fs")
		vi.mocked(fsSync.renameSync).mockImplementation(actualFs.renameSync)
		platform = Object.getOwnPropertyDescriptor(process, "platform")!
		Object.defineProperty(process, "platform", { ...platform, value: "win32" })
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-replacement-"))
		persistence = new FileAgentControlPersistence(directory)
		await persistence.write(state(1))
		vi.spyOn(console, "error").mockImplementation(() => undefined)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		vi.useRealTimers()
		Object.defineProperty(process, "platform", platform)
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("retries a transient Windows replacement using the same temp file and a fresh synchronous fence", async () => {
		const internals = persistence as unknown as { assertTransactionOwnerSync(): void }
		const originalFence = internals.assertTransactionOwnerSync.bind(persistence)
		let fenceCount = 0
		vi.spyOn(internals, "assertTransactionOwnerSync").mockImplementation(() => {
			originalFence()
			fenceCount++
		})
		const attempts: { source: fsSync.PathLike; fence: number }[] = []
		const failure = Object.assign(new Error("Destination temporarily denies delete sharing"), { code: "EPERM" })
		vi.mocked(fsSync.renameSync).mockImplementation((source, destination) => {
			if (destination === persistence.filePath) {
				attempts.push({ source, fence: fenceCount })
				if (attempts.length === 1) throw failure
			}
			actualFs.renameSync(source, destination)
		})
		const body = vi.fn(() => persistence.write(state(2)))

		await expect(persistence.withTransaction(body)).resolves.toBeUndefined()
		expect(body).toHaveBeenCalledTimes(1)
		expect(attempts).toHaveLength(2)
		expect(attempts.map(({ fence }) => fence)).toEqual([1, 2])
		expect(attempts[0].source).toBe(attempts[1].source)
		expect(await persistence.read()).toEqual(state(2))
		expect(await fs.readdir(directory)).toEqual([path.basename(persistence.filePath)])
	})

	it("bounds persistent sharing failures without replaying the body or replacing the prior state", async () => {
		const failure = Object.assign(new Error("Destination remains open without delete sharing"), { code: "EPERM" })
		const attempts: fsSync.PathLike[] = []
		vi.mocked(fsSync.renameSync).mockImplementation((source, destination) => {
			if (destination === persistence.filePath) {
				attempts.push(source)
				throw failure
			}
			actualFs.renameSync(source, destination)
		})
		const retries = vi.spyOn(globalThis, "setTimeout")
		const body = vi.fn(() => persistence.write(state(2)))

		await expect(persistence.withTransaction(body)).rejects.toBe(failure)
		expect(body).toHaveBeenCalledTimes(1)
		expect(attempts).toHaveLength(6)
		expect(new Set(attempts).size).toBe(1)
		expect(retries.mock.calls.map(([, delay]) => delay)).toEqual([10, 25, 50, 100, 200])
		expect(await persistence.read()).toEqual(state(1))
		expect(await fs.readdir(directory)).toEqual([path.basename(persistence.filePath)])
	})

	it("does not retry a permanent replacement error", async () => {
		const failure = Object.assign(new Error("Permanent device failure"), { code: "EIO" })
		let attempts = 0
		vi.mocked(fsSync.renameSync).mockImplementation((source, destination) => {
			if (destination === persistence.filePath) {
				attempts++
				throw failure
			}
			actualFs.renameSync(source, destination)
		})
		const retries = vi.spyOn(globalThis, "setTimeout")
		const body = vi.fn(() => persistence.write(state(2)))

		await expect(persistence.withTransaction(body)).rejects.toBe(failure)
		expect(attempts).toBe(1)
		expect(body).toHaveBeenCalledTimes(1)
		expect(retries).not.toHaveBeenCalled()
		expect(await persistence.read()).toEqual(state(1))
		expect(await fs.readdir(directory)).toEqual([path.basename(persistence.filePath)])
	})

	it("rejects ownership loss during backoff before attempting another replacement", async () => {
		const failure = Object.assign(new Error("Transient sharing failure"), { code: "EPERM" })
		const lockPath = `${persistence.filePath}.transaction.lock`
		const internals = persistence as unknown as { assertTransactionOwnerSync(): void }
		const fence = vi.spyOn(internals, "assertTransactionOwnerSync")
		let attempts = 0
		vi.mocked(fsSync.renameSync).mockImplementation((source, destination) => {
			if (destination === persistence.filePath) {
				attempts++
				actualFs.renameSync(lockPath, `${lockPath}.displaced`)
				throw failure
			}
			actualFs.renameSync(source, destination)
		})
		const body = vi.fn(() => persistence.write(state(2)))

		await expect(persistence.withTransaction(body)).rejects.toThrow("transaction ownership was lost")
		expect(body).toHaveBeenCalledTimes(1)
		expect(attempts).toBe(1)
		expect(fence).toHaveBeenCalledTimes(2)
		expect(await persistence.read()).toEqual(state(1))
		expect((await fs.readdir(directory)).some((filename) => filename.endsWith(".tmp"))).toBe(false)
	})

	it("keeps unrelated writes queued while the original transaction retries its fenced replacement", async () => {
		const failedFirstAttempt = barrier()
		const failure = Object.assign(new Error("Transient sharing failure"), { code: "EPERM" })
		const attemptedVersions: number[] = []
		vi.mocked(fsSync.renameSync).mockImplementation((source, destination) => {
			if (destination === persistence.filePath) {
				attemptedVersions.push(JSON.parse(actualFs.readFileSync(source, "utf8")).updatedAt)
				if (attemptedVersions.length === 1) {
					failedFirstAttempt.resolve()
					throw failure
				}
			}
			actualFs.renameSync(source, destination)
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const body = vi.fn(() => persistence.write(state(2)))
		const original = persistence.withTransaction(body).catch((error: unknown) => error)
		await failedFirstAttempt.promise
		const unrelated = persistence.write(state(3)).catch((error: unknown) => error)

		try {
			await setImmediate()
			expect(attemptedVersions).toEqual([2])
			expect(await persistence.read()).toEqual(state(1))
			await vi.advanceTimersByTimeAsync(10)
			await expect(original).resolves.toBeUndefined()
			await expect(unrelated).resolves.toBeUndefined()
			expect(body).toHaveBeenCalledTimes(1)
			expect(attemptedVersions).toEqual([2, 2, 3])
			expect(await persistence.read()).toEqual(state(3))
			expect(await fs.readdir(directory)).toEqual([path.basename(persistence.filePath)])
		} finally {
			await vi.runAllTimersAsync()
			await Promise.all([original, unrelated])
		}
	})

	it("cancels a pending replacement retry without committing or attempting another rename", async () => {
		const failedFirstAttempt = barrier()
		const failure = Object.assign(new Error("Transient sharing failure"), { code: "EPERM" })
		let attempts = 0
		vi.mocked(fsSync.renameSync).mockImplementation((source, destination) => {
			if (destination === persistence.filePath) {
				attempts++
				failedFirstAttempt.resolve()
				throw failure
			}
			actualFs.renameSync(source, destination)
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const cancellation = new AbortController()
		const body = vi.fn(() => persistence.write(state(2)))
		const writing = persistence.withTransaction(body, { signal: cancellation.signal })
		const rejected = expect(writing).rejects.toMatchObject({
			code: "ABORT_ERR",
			diagnostic: { outcome: "cancelled", committed: false },
		})

		try {
			await failedFirstAttempt.promise
			cancellation.abort()
			await rejected
			expect(body).toHaveBeenCalledTimes(1)
			expect(attempts).toBe(1)
			expect(await persistence.read()).toEqual(state(1))
			expect(await fs.readdir(directory)).toEqual([path.basename(persistence.filePath)])
		} finally {
			cancellation.abort()
			await Promise.allSettled([writing])
		}
	})

	it("rejects an escaped retry after its original transaction finishes without affecting a successor", async () => {
		const failedFirstAttempt = barrier()
		const failure = Object.assign(new Error("Transient sharing failure"), { code: "EPERM" })
		const attemptedVersions: number[] = []
		vi.mocked(fsSync.renameSync).mockImplementation((source, destination) => {
			if (destination === persistence.filePath) {
				attemptedVersions.push(JSON.parse(actualFs.readFileSync(source, "utf8")).updatedAt)
				if (attemptedVersions.length === 1) {
					failedFirstAttempt.resolve()
					throw failure
				}
			}
			actualFs.renameSync(source, destination)
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let escaped: Promise<unknown> | undefined

		try {
			await persistence.withTransaction(async () => {
				escaped = persistence.write(state(2)).catch((error: unknown) => error)
				await failedFirstAttempt.promise
			})
			await persistence.write(state(3))
			await vi.advanceTimersByTimeAsync(10)
			await expect(escaped).resolves.toMatchObject({ message: "Agent control transaction ownership was lost" })
			expect(attemptedVersions).toEqual([2, 3])
			expect(await persistence.read()).toEqual(state(3))
			expect(await fs.readdir(directory)).toEqual([path.basename(persistence.filePath)])
		} finally {
			await vi.runAllTimersAsync()
			await escaped
		}
	})
})
