import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { AgentControlState } from "@alpha-code/types"

import { FileAgentControlPersistence, type AgentControlTransactionDiagnostic } from "../AgentControlStore"

type TransactionOwner = { token: string; pid: number }
type Reaper = "tryReapTransactionLock" | "tryReapReleasedTransactionLock"
type TransactionReapers = Record<Reaper, (owner: TransactionOwner) => Promise<boolean>>

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

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("FileAgentControlPersistence recovery races", () => {
	it("recovers its released lock after both Windows release retries and marker publication fail", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-marker-failure-"))
		const persistence = new FileAgentControlPersistence(directory)
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
			markTransactionLockReleased(token: string): Promise<void>
		}
		const originalRename = internals.renameTransactionLock.bind(persistence)
		const rename = vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
			if (destination.includes(".release.")) {
				throw Object.assign(new Error("Windows sharing violation"), { code: "EPERM" })
			}
			return originalRename(source, destination)
		})
		const marker = vi
			.spyOn(internals, "markTransactionLockReleased")
			.mockRejectedValue(Object.assign(new Error("Release marker could not be written"), { code: "EACCES" }))

		try {
			await expect(persistence.write(state(1))).resolves.toBeUndefined()
			expect(marker).toHaveBeenCalledOnce()
			expect(await persistence.read()).toEqual(state(1))
			rename.mockRestore()
			marker.mockRestore()

			await expect(persistence.write(state(2))).resolves.toBeUndefined()
			expect(await persistence.read()).toEqual(state(2))
			await expect(fs.stat(`${persistence.filePath}.transaction.lock`)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			rename.mockRestore()
			marker.mockRestore()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("rejects an escaped callback after its body finished while release is still pending", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-release-phase-write-"))
		const persistence = new FileAgentControlPersistence(directory)
		const internals = persistence as unknown as {
			releaseTransactionLock(token: string, diagnostic: AgentControlTransactionDiagnostic): Promise<void>
		}
		const originalRelease = internals.releaseTransactionLock.bind(persistence)
		const releasing = deferred()
		const finishRelease = deferred()
		const resume = deferred()
		let escaped!: Promise<void>
		const release = vi.spyOn(internals, "releaseTransactionLock").mockImplementation(async (token, diagnostic) => {
			releasing.resolve()
			await finishRelease.promise
			return originalRelease(token, diagnostic)
		})
		const holder = persistence.withTransaction(async () => {
			await persistence.write(state(1))
			escaped = resume.promise.then(() => persistence.write(state(99)))
		})

		try {
			await releasing.promise
			resume.resolve()
			await expect(escaped).rejects.toThrow("transaction ownership was lost")
			finishRelease.resolve()
			await holder
			expect(await persistence.read()).toEqual(state(1))
		} finally {
			resume.resolve()
			finishRelease.resolve()
			await Promise.allSettled([holder, escaped])
			release.mockRestore()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("queues an unrelated standalone write behind the current transaction", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-standalone-write-"))
		const persistence = new FileAgentControlPersistence(directory)
		const entered = deferred()
		const finish = deferred()
		const holder = persistence.withTransaction(async () => {
			entered.resolve()
			await finish.promise
			await persistence.write(state(1))
		})
		let standalone: Promise<void> | undefined
		const transaction = vi.spyOn(persistence, "withTransaction")

		try {
			await entered.promise
			standalone = persistence.write(state(2))
			// Admission is synchronous even while the holder waits at the barrier.
			// The unrelated caller must establish its own transaction boundary.
			expect(transaction).toHaveBeenCalledOnce()
			finish.resolve()
			await Promise.all([holder, standalone])
			expect(await persistence.read()).toEqual(state(2))
		} finally {
			finish.resolve()
			await Promise.allSettled([holder, standalone])
			transaction.mockRestore()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("rejects a former transaction's escaped callback while a successor owns the lock", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-escaped-write-"))
		const persistence = new FileAgentControlPersistence(directory)
		const resume = deferred()
		let escaped!: Promise<void>

		try {
			await persistence.withTransaction(async () => {
				await persistence.write(state(1))
				escaped = resume.promise.then(() => persistence.write(state(99)))
			})
			await persistence.withTransaction(async () => {
				resume.resolve()
				await expect(escaped).rejects.toThrow("transaction ownership was lost")
				await persistence.write(state(2))
			})
			expect(await persistence.read()).toEqual(state(2))
		} finally {
			resume.resolve()
			await escaped?.catch(() => undefined)
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it.each<[Reaper, Reaper]>([
		["tryReapTransactionLock", "tryReapReleasedTransactionLock"],
		["tryReapReleasedTransactionLock", "tryReapTransactionLock"],
	])("preserves a successor when %s completes before a delayed %s", async (firstReaper, delayedReaper) => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-mixed-reapers-"))
		const first = new FileAgentControlPersistence(directory)
		const delayed = new FileAgentControlPersistence(directory)
		const successor = new FileAgentControlPersistence(directory)
		const lockPath = `${first.filePath}.transaction.lock`
		const owner = { token: "released-and-dead-owner", pid: 2_147_483_647 }
		const firstInternals = first as unknown as TransactionReapers
		const delayedInternals = delayed as unknown as TransactionReapers

		try {
			await fs.mkdir(lockPath)
			await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf8")
			await fs.writeFile(path.join(lockPath, "released"), owner.token, "utf8")
			// Both contenders already observed the same owner. A release marker can
			// survive its process exiting, making both recovery paths eligible.
			await expect(firstInternals[firstReaper](owner)).resolves.toBe(true)

			await successor.withTransaction(async () => {
				await expect(delayedInternals[delayedReaper](owner)).resolves.toBe(false)
				await expect(successor.assertTransactionOwner()).resolves.toBeUndefined()
			})
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("preserves a successor when an older released-owner tombstone already exists", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-legacy-reaped-owner-"))
		const persistence = new FileAgentControlPersistence(directory)
		const delayed = new FileAgentControlPersistence(directory)
		const internals = delayed as unknown as TransactionReapers
		const owner = { token: "previous-released-owner", pid: 2_147_483_647 }
		const tombstonePath = `${persistence.filePath}.transaction.lock.released.${owner.token}`

		try {
			await fs.mkdir(tombstonePath)
			await fs.writeFile(path.join(tombstonePath, "owner.json"), JSON.stringify(owner), "utf8")
			await fs.writeFile(path.join(tombstonePath, "released"), owner.token, "utf8")

			await persistence.withTransaction(async () => {
				await expect(internals.tryReapTransactionLock(owner)).resolves.toBe(false)
				await expect(persistence.assertTransactionOwner()).resolves.toBeUndefined()
			})
			await expect(fs.readFile(path.join(tombstonePath, "owner.json"), "utf8")).resolves.toBe(
				JSON.stringify(owner),
			)
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
})
