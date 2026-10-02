import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { TicketStore } from "../TicketStore"

vi.mock("fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("fs/promises")>()
	return { ...original, realpath: vi.fn(original.realpath) }
})

const deferred = () => {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}
const flushMicrotasks = async () => {
	for (let index = 0; index < 8; index++) await Promise.resolve()
}

describe("TicketStore preparation cancellation", () => {
	let home: string, workspace: string
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-tickets-cancellation-"))
		workspace = path.join(home, "project")
		await fs.mkdir(workspace)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(home, { recursive: true, force: true })
	})

	it("cancels only a reader waiting for editor-owned migration, then permits another reader", async () => {
		const canonicalWorkspace = await fs.realpath(workspace)
		const canonicalHome = await fs.realpath(home)
		const realpath = vi.mocked(fs.realpath)
		const originalRealpath = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).realpath
		realpath.mockImplementation(async (file) => (file === workspace ? canonicalWorkspace : canonicalHome))
		vi.spyOn(os, "homedir").mockReturnValue(home)
		const started = deferred()
		const release = deferred()
		vi.spyOn(TicketStore.prototype, "prepareReferences").mockImplementation(async () => {
			started.resolve()
			await release.promise
		})
		let migrationSettled = false
		const migration = TicketStore.initializeWorkspace(workspace).finally(() => {
			migrationSettled = true
		})
		await started.promise
		const cancellation = new AbortController()
		const reason = new Error("reader cancelled")
		const removeListener = vi.spyOn(cancellation.signal, "removeEventListener")
		let readerSettled = false
		let readerFailure: unknown
		const cancelledReader = TicketStore.forWorkspace(workspace, home, cancellation.signal).catch((error) => {
			readerSettled = true
			readerFailure = error
		})
		await flushMicrotasks()
		cancellation.abort(reason)
		await flushMicrotasks()
		let survivingReaderSettled = false
		const survivingReader = TicketStore.forWorkspace(workspace, home).then((store) => {
			survivingReaderSettled = true
			return store
		})
		try {
			expect(readerSettled).toBe(true)
			expect(readerFailure).toBe(reason)
			expect(removeListener).toHaveBeenCalledOnce()
			expect(migrationSettled).toBe(false)
			await flushMicrotasks()
			expect(survivingReaderSettled).toBe(false)
		} finally {
			release.resolve()
			await Promise.allSettled([migration, cancelledReader, survivingReader])
			realpath.mockImplementation(originalRealpath)
		}
		expect(await survivingReader).toMatchObject({ workspace: canonicalWorkspace })
		expect(migrationSettled).toBe(true)
	})

	it("rejects pre-aborted store opening before filesystem work", async () => {
		const cancellation = new AbortController()
		const reason = new Error("cancelled before opening")
		cancellation.abort(reason)
		const reads = vi.mocked(fs.realpath).mock.calls.length
		await expect(TicketStore.forWorkspace(workspace, home, cancellation.signal)).rejects.toBe(reason)
		expect(vi.mocked(fs.realpath).mock.calls).toHaveLength(reads)
	})

	it("propagates migration failure and removes an admitted reader's cancellation listener", async () => {
		const canonicalWorkspace = await fs.realpath(workspace)
		const canonicalHome = await fs.realpath(home)
		const originalRealpath = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).realpath
		const realpath = vi.mocked(fs.realpath)
		realpath.mockImplementation(async (file) => (file === workspace ? canonicalWorkspace : canonicalHome))
		vi.spyOn(os, "homedir").mockReturnValue(home)
		const started = deferred()
		const release = deferred()
		vi.spyOn(TicketStore.prototype, "prepareReferences").mockImplementation(async () => {
			started.resolve()
			await release.promise
		})
		const migration = TicketStore.initializeWorkspace(workspace).catch((error) => error)
		await started.promise
		const cancellation = new AbortController()
		const addListener = vi.spyOn(cancellation.signal, "addEventListener")
		const removeListener = vi.spyOn(cancellation.signal, "removeEventListener")
		const reader = TicketStore.forWorkspace(workspace, home, cancellation.signal)
		const failure = new Error("migration failed")
		const rejected = expect(reader).rejects.toBe(failure)
		try {
			await flushMicrotasks()
			expect(addListener).toHaveBeenCalledOnce()
			expect(removeListener).not.toHaveBeenCalled()
			release.reject(failure)
			await rejected
			expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0][1])
			expect(await migration).toBe(failure)
			await expect(TicketStore.forWorkspace(workspace, home)).resolves.toMatchObject({
				workspace: canonicalWorkspace,
			})
		} finally {
			release.resolve()
			await Promise.allSettled([migration, reader])
			realpath.mockImplementation(originalRealpath)
		}
	})
})
