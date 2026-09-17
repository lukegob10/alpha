import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { atomicWriteText, withFileLock } from "../atomicWrite"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

let directory: string
let filePath: string

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-atomic-write-"))
	filePath = path.join(directory, "snapshot.json")
	await fs.writeFile(filePath, "previous snapshot")
	vi.mocked(fs.rename).mockClear()
	vi.mocked(fs.rm).mockClear()
})

afterEach(async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
	await actual.rm(directory, { recursive: true, force: true })
})

describe("atomic replacement under filesystem contention", () => {
	it.each(["EPERM", "EACCES", "EBUSY"])(
		"retries transient %s without deleting the previous snapshot",
		async (code) => {
			const failure = Object.assign(new Error("temporary replacement contention"), { code })
			const rename = vi.mocked(fs.rename)
			const rejectWhileLocked: typeof fs.rename = async (source, destination) => {
				expect(destination).toBe(filePath)
				expect(await fs.readFile(filePath, "utf8")).toBe("previous snapshot")
				expect(await fs.readFile(source, "utf8")).toBe("replacement snapshot")
				throw failure
			}
			rename.mockImplementationOnce(rejectWhileLocked).mockImplementationOnce(rejectWhileLocked)

			await expect(
				atomicWriteText(filePath, "replacement snapshot", { requireAtomicReplace: true }),
			).resolves.toBeUndefined()

			expect(rename).toHaveBeenCalledTimes(3)
			expect(new Set(rename.mock.calls.map(([source]) => source)).size).toBe(1)
			expect(await fs.readFile(filePath, "utf8")).toBe("replacement snapshot")
			expect(await fs.readdir(directory)).toEqual(["snapshot.json"])
			expect(fs.rm).not.toHaveBeenCalledWith(filePath, expect.anything())
		},
	)

	it("also retries a transient non-strict replacement before considering compatibility fallback", async () => {
		vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" }))

		await atomicWriteText(filePath, "replacement snapshot")

		expect(await fs.readFile(filePath, "utf8")).toBe("replacement snapshot")
		expect(fs.rm).not.toHaveBeenCalledWith(filePath, expect.anything())
	})

	it.each(["EPERM", "EACCES", "EBUSY"])(
		"bounds persistent %s retries and retains the prior snapshot",
		async (code) => {
			const failure = Object.assign(new Error("replacement remains unavailable"), { code })
			vi.mocked(fs.rename).mockRejectedValue(failure)

			await expect(
				atomicWriteText(filePath, "replacement snapshot", { requireAtomicReplace: true }),
			).rejects.toBe(failure)

			expect(vi.mocked(fs.rename).mock.calls.length).toBeGreaterThan(1)
			expect(vi.mocked(fs.rename).mock.calls.length).toBeLessThanOrEqual(6)
			expect(await fs.readFile(filePath, "utf8")).toBe("previous snapshot")
			expect(await fs.readdir(directory)).toEqual(["snapshot.json"])
			expect(fs.rm).not.toHaveBeenCalledWith(filePath, expect.anything())
		},
	)

	it.each(["EIO", "ENOSPC", "ENOENT", "EXDEV"])(
		"propagates %s immediately without retry or destination removal",
		async (code) => {
			const failure = Object.assign(new Error("non-contention failure"), { code })
			vi.mocked(fs.rename).mockRejectedValue(failure)

			await expect(
				atomicWriteText(filePath, "replacement snapshot", { requireAtomicReplace: true }),
			).rejects.toBe(failure)

			expect(fs.rename).toHaveBeenCalledOnce()
			expect(await fs.readFile(filePath, "utf8")).toBe("previous snapshot")
			expect(await fs.readdir(directory)).toEqual(["snapshot.json"])
			expect(fs.rm).not.toHaveBeenCalledWith(filePath, expect.anything())
		},
	)

	it("holds the transaction lock through retry and releases it after the replacement settles", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.rename)
			.mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" }))
			.mockImplementationOnce(async (source, destination) => {
				expect((await fs.stat(`${filePath}.lock`)).isDirectory()).toBe(true)
				await actual.rename(source, destination)
			})

		await withFileLock(filePath, () =>
			atomicWriteText(filePath, "replacement snapshot", { requireAtomicReplace: true }),
		)

		expect(fs.rename).toHaveBeenCalledTimes(2)
		await expect(fs.access(`${filePath}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await fs.readFile(filePath, "utf8")).toBe("replacement snapshot")
	})
})
