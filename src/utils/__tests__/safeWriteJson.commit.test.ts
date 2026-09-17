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

describe("safeWriteJson asynchronous commit boundary", () => {
	let directory: string
	let target: string
	let output: fsSync.WriteStream | undefined

	beforeEach(async () => {
		const actualFs = await vi.importActual<typeof import("fs")>("fs")
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-safe-json-commit-"))
		target = path.join(directory, "state.json")
		await fs.writeFile(target, JSON.stringify({ original: true }), "utf8")
		output = undefined
		vi.mocked(fsSync.createWriteStream).mockImplementation((filename, options) => {
			output = actualFs.createWriteStream(filename, options)
			return output
		})
		vi.spyOn(console, "error").mockImplementation(() => undefined)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("retains the closed temporary file and prior target until its single commit callback completes", async () => {
		const entered = barrier()
		const proceed = barrier()
		const next = { next: [1, 2, 3] }
		let temporaryPath = ""
		const commit = vi.fn(async (source: string, destination: string) => {
			temporaryPath = source
			entered.resolve()
			await proceed.promise
			fsSync.renameSync(source, destination)
		})
		let settled = false
		const writing = safeWriteJson(target, next, {
			externalTransaction: true,
			atomicReplace: true,
			commitTempFile: commit,
		}).then(
			() => {
				settled = true
			},
			(error: unknown) => {
				settled = true
				return error
			},
		)

		try {
			await entered.promise
			await setImmediate()
			expect(settled).toBe(false)
			expect(commit).toHaveBeenCalledTimes(1)
			expect(output?.closed).toBe(true)
			expect(JSON.parse(await fs.readFile(temporaryPath, "utf8"))).toEqual(next)
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ original: true })
			proceed.resolve()
			await expect(writing).resolves.toBeUndefined()
			expect(commit).toHaveBeenCalledTimes(1)
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(next)
			expect(await fs.readdir(directory)).toEqual(["state.json"])
		} finally {
			proceed.resolve()
			await writing
			await Promise.allSettled(commit.mock.results.map((result) => result.value))
		}
	})

	it.each(["EIO", "EPERM"])("preserves an asynchronous %s rejection without retrying the callback", async (code) => {
		const entered = barrier()
		const proceed = barrier()
		const failure = Object.assign(new Error("Commit callback failed"), { code })
		// Observe the callback promise even against a regressed helper that ignores it.
		const committing = proceed.promise.then(() => {
			throw failure
		})
		void committing.catch(() => undefined)
		const commit = vi.fn((_source: string, _destination: string) => {
			entered.resolve()
			return committing
		})
		const writing = safeWriteJson(
			target,
			{ next: true },
			{
				externalTransaction: true,
				atomicReplace: true,
				commitTempFile: commit,
			},
		).catch((error: unknown) => error)

		try {
			await entered.promise
			expect(output?.closed).toBe(true)
			proceed.resolve()
			await expect(writing).resolves.toBe(failure)
			expect(commit).toHaveBeenCalledTimes(1)
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ original: true })
			expect(await fs.readdir(directory)).toEqual(["state.json"])
		} finally {
			proceed.resolve()
			await writing
		}
	})
})
