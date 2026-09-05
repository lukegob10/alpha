import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"
import { setImmediate } from "timers/promises"

import { safeWriteJson } from "../safeWriteJson"

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) }
})

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("safeWriteJson stream close boundary", () => {
	let directory: string
	let target: string
	let actualFs: typeof import("fs")
	let output: fsSync.WriteStream | undefined

	beforeEach(async () => {
		actualFs = await vi.importActual<typeof import("fs")>("fs")
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-safe-json-close-"))
		target = path.join(directory, "state.json")
		await fs.writeFile(target, JSON.stringify({ original: true }), "utf8")
		output = undefined
		vi.spyOn(console, "error").mockImplementation(() => undefined)
	})

	afterEach(async () => {
		if (output && !output.closed) {
			const closed = new Promise<void>((resolve) => output!.once("close", resolve))
			output.destroy()
			await closed
		}
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("keeps the prior target until the temporary file descriptor has actually closed", async () => {
		const closeStarted = barrier()
		const finishClose = barrier()
		const closeCompleted = barrier()
		let descriptorClosed = false
		vi.mocked(fsSync.createWriteStream).mockImplementation((filename, options) => {
			output = actualFs.createWriteStream(filename, {
				...(typeof options === "string" ? { encoding: options } : options),
				fs: {
					open: actualFs.open,
					write: actualFs.write,
					writev: actualFs.writev,
					close: (fd, callback) => {
						closeStarted.resolve()
						void finishClose.promise.then(() =>
							actualFs.close(fd, (error) => {
								descriptorClosed = !error
								callback(error)
								closeCompleted.resolve()
							}),
						)
					},
				},
			})
			return output
		})
		const commit = vi.fn((source: string, destination: string) => {
			if (!descriptorClosed) throw new Error("Commit ran before file descriptor close")
			actualFs.renameSync(source, destination)
		})
		const next = { next: [1, 2, 3], message: "complete JSON" }
		const writing = safeWriteJson(target, next, {
			externalTransaction: true,
			atomicReplace: true,
			commitTempFile: commit,
		}).catch((error: unknown) => error)

		try {
			await closeStarted.promise
			await setImmediate()
			expect(output?.writableFinished).toBe(true)
			expect(descriptorClosed).toBe(false)
			expect(commit).not.toHaveBeenCalled()
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ original: true })
			finishClose.resolve()
			await expect(writing).resolves.toBeUndefined()
			expect(commit).toHaveBeenCalledTimes(1)
			expect(descriptorClosed).toBe(true)
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(next)
			expect(await fs.readdir(directory)).toEqual(["state.json"])
		} finally {
			finishClose.resolve()
			await Promise.all([writing, closeCompleted.promise])
		}
	})

	it("closes the destination and removes the temporary file after a source serialization error", async () => {
		vi.mocked(fsSync.createWriteStream).mockImplementation((filename, options) => {
			output = actualFs.createWriteStream(filename, options)
			return output
		})
		const circular: { self?: unknown } = {}
		circular.self = circular
		const commit = vi.fn((source: string, destination: string) => actualFs.renameSync(source, destination))

		await expect(
			safeWriteJson(target, circular, {
				externalTransaction: true,
				atomicReplace: true,
				commitTempFile: commit,
			}),
		).rejects.toThrow("Converting circular structure to JSON")
		expect(commit).not.toHaveBeenCalled()
		expect(output?.closed).toBe(true)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ original: true })
		expect(await fs.readdir(directory)).toEqual(["state.json"])
	})

	it("does not open a destination stream when root serialization throws synchronously", async () => {
		const failure = new Error("Root toJSON failed")
		const data = {
			toJSON() {
				throw failure
			},
		}
		vi.mocked(fsSync.createWriteStream).mockClear()
		const commit = vi.fn((source: string, destination: string) => actualFs.renameSync(source, destination))

		await expect(
			safeWriteJson(target, data, {
				externalTransaction: true,
				atomicReplace: true,
				commitTempFile: commit,
			}),
		).rejects.toBe(failure)
		expect(fsSync.createWriteStream).not.toHaveBeenCalled()
		expect(commit).not.toHaveBeenCalled()
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ original: true })
		expect(await fs.readdir(directory)).toEqual(["state.json"])
	})

	it.each(["write", "close"] as const)("does not commit after a filesystem %s error", async (failureKind) => {
		const failure = Object.assign(new Error(`Injected ${failureKind} failure`), { code: "EIO" })
		vi.mocked(fsSync.createWriteStream).mockImplementation((filename, options) => {
			output = actualFs.createWriteStream(filename, {
				...(typeof options === "string" ? { encoding: options } : options),
				fs: {
					open: actualFs.open,
					write: (fd, buffer, offset, length, position, callback) => {
						if (failureKind === "write") callback(failure, 0, buffer)
						else actualFs.write(fd, buffer, offset, length, position, callback)
					},
					close: (fd, callback) => {
						actualFs.close(fd, (error) => callback(error ?? (failureKind === "close" ? failure : null)))
					},
				},
			})
			return output
		})
		const commit = vi.fn((source: string, destination: string) => actualFs.renameSync(source, destination))

		await expect(
			safeWriteJson(
				target,
				{ mustNotCommit: true },
				{
					externalTransaction: true,
					atomicReplace: true,
					commitTempFile: commit,
				},
			),
		).rejects.toBe(failure)
		expect(commit).not.toHaveBeenCalled()
		expect(output?.closed).toBe(true)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ original: true })
		expect(await fs.readdir(directory)).toEqual(["state.json"])
	})
})
