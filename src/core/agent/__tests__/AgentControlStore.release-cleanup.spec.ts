import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { AgentControlState } from "@alpha-code/types"

import { FileAgentControlPersistence, type AgentControlTransactionDiagnostic } from "../AgentControlStore"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, rmdir: vi.fn(actual.rmdir), unlink: vi.fn(actual.unlink) }
})

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

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

const timerDescriptors = {
	setTimeout: Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!,
	clearTimeout: Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!,
}

describe("FileAgentControlPersistence released-directory cleanup", () => {
	let directory: string
	let persistence: FileAgentControlPersistence
	let actualFs: typeof import("fs/promises")
	let platform: PropertyDescriptor
	let nativeWindows: boolean
	let heldOwner: fs.FileHandle | undefined
	let diagnostics: AgentControlTransactionDiagnostic[]

	beforeEach(async () => {
		actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.rmdir).mockImplementation(actualFs.rmdir)
		vi.mocked(fs.unlink).mockImplementation(actualFs.unlink)
		vi.mocked(fs.unlink).mockClear()
		platform = Object.getOwnPropertyDescriptor(process, "platform")!
		nativeWindows = process.platform === "win32"
		Object.defineProperty(process, "platform", { ...platform, value: "win32" })
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-release-cleanup-"))
		diagnostics = []
		persistence = new FileAgentControlPersistence(directory, {
			onTransactionDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		})
		heldOwner = undefined
	})

	afterEach(async () => {
		await heldOwner?.close()
		vi.restoreAllMocks()
		vi.useRealTimers()
		// Timer spies and fake clocks both replace these globals; restore their
		// original descriptors after both teardown paths have finished.
		Object.defineProperties(globalThis, timerDescriptors)
		Object.defineProperty(process, "platform", platform)
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("retries cleanup after a reader closes the already-unlinked released owner file", async () => {
		const lockPath = `${persistence.filePath}.transaction.lock`
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
		}
		const rename = internals.renameTransactionLock.bind(persistence)
		let releasePath: string | undefined
		vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
			await rename(source, destination)
			if (source === lockPath) {
				releasePath = destination
				heldOwner = await fs.open(path.join(destination, "owner.json"), "r")
			}
		})
		const firstCleanup = barrier()
		let cleanupError: unknown
		let attempts = 0
		vi.mocked(fs.rmdir).mockImplementation(async (filename, options) => {
			if (filename === releasePath) {
				attempts++
				if (attempts === 1) {
					try {
						if (nativeWindows) return await actualFs.rmdir(filename, options)
						throw Object.assign(new Error("Released owner deletion remains pending"), { code: "ENOTEMPTY" })
					} catch (error) {
						cleanupError = error
						throw error
					} finally {
						firstCleanup.resolve()
					}
				}
			}
			return actualFs.rmdir(filename, options)
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const cancellation = new AbortController()
		const transaction = persistence
			.withTransaction(async () => "released", { signal: cancellation.signal })
			.catch((error: unknown) => error)

		try {
			await firstCleanup.promise
			expect(cleanupError).toMatchObject({ code: "ENOTEMPTY" })
			cancellation.abort()
			await heldOwner?.close()
			heldOwner = undefined
			await vi.advanceTimersByTimeAsync(10)
			await expect(transaction).resolves.toBe("released")
			expect(attempts).toBe(2)
			expect(
				vi
					.mocked(fs.unlink)
					.mock.calls.filter(([filename]) => filename === path.join(releasePath!, "owner.json")),
			).toHaveLength(1)
			expect(diagnostics).toEqual([expect.objectContaining({ outcome: "success", releaseFailed: false })])
			expect(diagnostics[0]).not.toHaveProperty("releaseFailurePhase")
			expect(diagnostics[0]).not.toHaveProperty("releaseFailureCode")
			expect(await fs.readdir(directory)).toEqual([])
		} finally {
			cancellation.abort()
			await heldOwner?.close()
			heldOwner = undefined
			await vi.runAllTimersAsync()
			await transaction
		}
	})

	it.each(["ENOTEMPTY", "EIO"] as const)(
		"retains unknown released-directory content and committed success after %s",
		async (code) => {
			await persistence.write(state(1))
			diagnostics.length = 0
			vi.mocked(fs.unlink).mockClear()
			const lockPath = `${persistence.filePath}.transaction.lock`
			const internals = persistence as unknown as {
				renameTransactionLock(source: string, destination: string): Promise<void>
			}
			const rename = internals.renameTransactionLock.bind(persistence)
			let releasePath = ""
			vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
				await rename(source, destination)
				if (source === lockPath) {
					releasePath = destination
					await fs.writeFile(path.join(destination, "unknown-child"), "preserve unknown content", "utf8")
				}
			})
			let attempts = 0
			vi.mocked(fs.rmdir).mockImplementation(async (filename, options) => {
				if (filename === releasePath) {
					attempts++
					if (code === "EIO") throw Object.assign(new Error("Permanent cleanup failure"), { code })
				}
				return actualFs.rmdir(filename, options)
			})
			const retries = vi.spyOn(globalThis, "setTimeout")
			const body = vi.fn(() => persistence.write(state(2)))

			await expect(persistence.withTransaction(body)).resolves.toBeUndefined()
			expect(body).toHaveBeenCalledTimes(1)
			expect(attempts).toBe(code === "ENOTEMPTY" ? 6 : 1)
			expect(retries.mock.calls.map(([, delay]) => delay)).toEqual(
				code === "ENOTEMPTY" ? [10, 25, 50, 100, 200] : [],
			)
			expect(await persistence.read()).toEqual(state(2))
			expect(await fs.readdir(releasePath)).toEqual(["unknown-child"])
			expect(await fs.readFile(path.join(releasePath, "unknown-child"), "utf8")).toBe("preserve unknown content")
			expect(
				vi
					.mocked(fs.unlink)
					.mock.calls.filter(([filename]) => filename === path.join(releasePath, "owner.json")),
			).toHaveLength(1)
			expect(diagnostics).toEqual([
				expect.objectContaining({
					outcome: "success",
					committed: true,
					releaseFailed: true,
					releaseFailurePhase: "cleanup-directory",
					releaseFailureCode: code,
				}),
			])
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
		},
	)

	it("cleans only its released token directory while a successor owns the canonical lock", async () => {
		const lockPath = `${persistence.filePath}.transaction.lock`
		const successor = new FileAgentControlPersistence(directory)
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
		}
		const rename = internals.renameTransactionLock.bind(persistence)
		let releasePath = ""
		vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
			await rename(source, destination)
			if (source === lockPath) {
				releasePath = destination
				heldOwner = await fs.open(path.join(destination, "owner.json"), "r")
			}
		})
		const firstCleanup = barrier()
		let attempts = 0
		vi.mocked(fs.rmdir).mockImplementation(async (filename, options) => {
			if (filename === releasePath && ++attempts === 1) {
				firstCleanup.resolve()
				throw Object.assign(new Error("Released owner deletion remains pending"), { code: "ENOTEMPTY" })
			}
			return actualFs.rmdir(filename, options)
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const released = persistence.withTransaction(async () => "old owner released").catch((error: unknown) => error)
		const successorEntered = barrier()
		const finishSuccessor = barrier()
		let succeeding: Promise<void> | undefined

		try {
			await firstCleanup.promise
			succeeding = successor.withTransaction(async () => {
				successorEntered.resolve()
				await finishSuccessor.promise
			})
			await successorEntered.promise
			const successorOwner = await fs.readFile(path.join(lockPath, "owner.json"), "utf8")
			await heldOwner?.close()
			heldOwner = undefined
			await vi.advanceTimersByTimeAsync(10)
			await expect(released).resolves.toBe("old owner released")
			expect(attempts).toBe(2)
			await expect(fs.stat(releasePath)).rejects.toMatchObject({ code: "ENOENT" })
			expect(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(successorOwner)
			await expect(successor.assertTransactionOwner()).resolves.toBeUndefined()
			finishSuccessor.resolve()
			await succeeding
			expect(await fs.readdir(directory)).toEqual([])
		} finally {
			await heldOwner?.close()
			heldOwner = undefined
			finishSuccessor.resolve()
			await vi.runAllTimersAsync()
			await Promise.allSettled([released, succeeding])
		}
	})

	it("reports exhausted owner-file cleanup without attempting directory removal", async () => {
		await persistence.write(state(1))
		diagnostics.length = 0
		vi.mocked(fs.rmdir).mockClear()
		const lockPath = `${persistence.filePath}.transaction.lock`
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
		}
		const rename = internals.renameTransactionLock.bind(persistence)
		let releasePath = ""
		vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
			await rename(source, destination)
			if (source === lockPath) releasePath = destination
		})
		let attempts = 0
		vi.mocked(fs.unlink).mockImplementation(async (filename) => {
			if (filename === path.join(releasePath, "owner.json")) {
				attempts++
				throw Object.assign(new Error("Owner file remains open without delete sharing"), { code: "EPERM" })
			}
			await actualFs.unlink(filename)
		})

		await expect(persistence.write(state(2))).resolves.toBeUndefined()
		expect(attempts).toBe(6)
		expect(vi.mocked(fs.rmdir).mock.calls.some(([filename]) => filename === releasePath)).toBe(false)
		expect(await persistence.read()).toEqual(state(2))
		expect(await fs.readdir(releasePath)).toEqual(["owner.json"])
		expect(diagnostics).toEqual([
			expect.objectContaining({
				outcome: "success",
				committed: true,
				releaseFailed: true,
				releaseFailurePhase: "cleanup-owner",
				releaseFailureCode: "EPERM",
			}),
		])
	})
})
