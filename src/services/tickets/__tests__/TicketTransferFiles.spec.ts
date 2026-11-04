import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { readTicketTransferFile, writeTicketExport } from "../TicketTransferFiles"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})

let directory: string
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-transfer-"))
})
afterEach(async () => {
	vi.restoreAllMocks()
	expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true)
	await fs.rm(directory, { recursive: true, force: true })
})

describe("ticket transfer files", () => {
	it("reads complete binary input within its limit", async () => {
		const file = path.join(directory, "tickets.zip")
		const bytes = Buffer.from([80, 75, 0, 255, 128])
		await fs.writeFile(file, bytes)
		expect(await readTicketTransferFile(file, bytes.length)).toEqual(bytes)
	})

	it("rejects oversized files and closes the handle", async () => {
		const file = path.join(directory, "large.md")
		await fs.writeFile(file, "too large")
		const handle = await fs.open(file, "r")
		const close = vi.spyOn(handle, "close")
		vi.mocked(fs.open).mockResolvedValueOnce(handle)
		await expect(readTicketTransferFile(file, 2)).rejects.toThrow("size limit")
		expect(close).toHaveBeenCalledOnce()
	})

	it("rejects directories as import files", async () => {
		await expect(readTicketTransferFile(directory, 100)).rejects.toThrow()
	})

	it("rejects a file that grows after its initial size was captured", async () => {
		const file = path.join(directory, "changing.md")
		await fs.writeFile(file, "original")
		const handle = await fs.open(file, "r")
		const stat = handle.stat.bind(handle)
		vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
			const before = await stat()
			await fs.appendFile(file, " changed")
			return before
		})
		vi.mocked(fs.open).mockResolvedValueOnce(handle)
		await expect(readTicketTransferFile(file, 100)).rejects.toThrow("changed while reading")
	})

	it("does not open a canceled import", async () => {
		const controller = new AbortController()
		controller.abort(new Error("Canceled import"))
		vi.mocked(fs.open).mockClear()
		await expect(
			readTicketTransferFile(path.join(directory, "missing.md"), 100, controller.signal),
		).rejects.toThrow("Canceled import")
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("atomically replaces an existing export with complete binary bytes", async () => {
		const file = path.join(directory, "tickets.zip")
		await fs.writeFile(file, "previous export")
		const bytes = new Uint8Array([80, 75, 0, 255, 128])
		await writeTicketExport(file, bytes)
		expect(await fs.readFile(file)).toEqual(Buffer.from(bytes))
		expect(await fs.readdir(directory)).toEqual(["tickets.zip"])
	})

	it("preserves the previous export and removes temporary files when rename fails", async () => {
		const file = path.join(directory, "tickets.zip")
		await fs.writeFile(file, "previous export")
		vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("Sharing violation"), { code: "EPERM" }))
		await expect(writeTicketExport(file, new Uint8Array([1, 2, 3]))).rejects.toThrow("Sharing violation")
		expect(await fs.readFile(file, "utf8")).toBe("previous export")
		expect(await fs.readdir(directory)).toEqual(["tickets.zip"])
	})

	it("preserves the previous export when canceled after writing its temporary file", async () => {
		const file = path.join(directory, "tickets.zip")
		await fs.writeFile(file, "previous export")
		const controller = new AbortController()
		const open = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).open
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const handle = await open(...args)
			const sync = handle.sync.bind(handle)
			vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
				await sync()
				controller.abort(new Error("Canceled export"))
			})
			return handle
		})
		await expect(writeTicketExport(file, new Uint8Array([1, 2, 3]), controller.signal)).rejects.toThrow(
			"Canceled export",
		)
		expect(await fs.readFile(file, "utf8")).toBe("previous export")
		expect(await fs.readdir(directory)).toEqual(["tickets.zip"])
	})
})
