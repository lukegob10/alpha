import { describe, expect, it, vi } from "vitest"
import * as zlib from "node:zlib"
import { Zip, ZipPassThrough, zipSync, strToU8 } from "fflate"
import type { TicketStatus, TicketTransferEntry } from "@alpha-code/types"
import { decodeTicketArchive, decodeTicketMarkdown, encodeTicketArchive, maxTicketArchiveBytes } from "../TicketArchive"

vi.mock("node:zlib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:zlib")>()
	return { ...actual, createInflateRaw: vi.fn(actual.createInflateRaw) }
})

const first = "33002d7c-b953-4d94-86c7-5a644a4b4856"
const second = "97f596bf-54db-408b-a231-68f4532e8d54"
const markdown = (id = first, status?: TicketStatus) =>
	`---\nid: ${id}\n${status ? `status: ${status}\n` : ""}schemaVersion: 1\nname: Ticket\n---\n## Description\nUnicode: café 🎟️\n`
const entry = (id = first, status: TicketStatus = "backlog"): TicketTransferEntry => ({
	path: `${status}/${id}.md`,
	status,
	markdown: markdown(id, status),
})
const fixture = (files: Record<string, Uint8Array>, listed = [entry()], version = 1) =>
	zipSync({
		"manifest.json": strToU8(
			JSON.stringify({
				format: "alpha-tickets",
				version,
				tickets: listed.map(({ path, status }) => ({ path, status })),
			}),
		),
		...files,
	})
const centralOffset = (bytes: Buffer, entryIndex: number) => {
	let cursor = bytes.readUInt32LE(bytes.length - 6)
	for (let index = 0; index < entryIndex; index++)
		cursor +=
			46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32)
	return cursor
}

describe("TicketArchive", () => {
	it("round-trips native Markdown, Unicode, status and archive manifest", async () => {
		const entries = [entry(), entry(second, "complete")]
		const encoded = await encodeTicketArchive(entries)
		expect(encoded.byteLength).toBeLessThan(maxTicketArchiveBytes)
		expect(await decodeTicketArchive(encoded)).toEqual(entries)
	})

	it("accepts standard compressed ZIP entries", async () => {
		const ticket = entry()
		expect(await decodeTicketArchive(fixture({ [ticket.path]: strToU8(ticket.markdown) }))).toEqual([ticket])
	})

	it("uses UUID metadata for renamed standalone Markdown and defaults old files to backlog", () => {
		expect(decodeTicketMarkdown("handoff.md", markdown())).toEqual({ ...entry(), markdown: markdown() })
		expect(decodeTicketMarkdown("done.md", markdown(first, "complete"))).toEqual(entry(first, "complete"))
		expect(decodeTicketMarkdown("HANDOFF.MD", markdown())).toEqual({ ...entry(), markdown: markdown() })
	})

	it.each(["../outside.md", "C:\\outside.md", "/outside.md", "backlog/../../outside.md", "backlog\\outside.md"])(
		"rejects an unsafe ZIP path %s before decoding",
		async (unsafe) => {
			await expect(decodeTicketArchive(fixture({ [unsafe]: strToU8(markdown()) }))).rejects.toThrow(
				"Invalid ticket path",
			)
		},
	)

	it("rejects duplicate physical archive names", async () => {
		const chunks: Uint8Array[] = []
		const archive = new Zip((error, chunk) => {
			if (error) throw error
			chunks.push(chunk)
		})
		for (const name of ["manifest.json", "manifest.json"]) {
			const file = new ZipPassThrough(name)
			archive.add(file)
			file.push(strToU8("{}"), true)
		}
		archive.end()
		await expect(decodeTicketArchive(Buffer.concat(chunks))).rejects.toThrow("Duplicate file")
	})

	it("rejects duplicate ticket identities even when in different status directories", async () => {
		const entries = [entry(), entry(first, "complete")]
		const files = Object.fromEntries(entries.map((ticket) => [ticket.path, strToU8(ticket.markdown)]))
		await expect(decodeTicketArchive(fixture(files, entries))).rejects.toThrow("Duplicate ticket ID")
		await expect(encodeTicketArchive(entries)).rejects.toThrow("Duplicate ticket ID")
	})

	it("rejects undeclared payload and unknown manifest versions", async () => {
		const files = { [entry().path]: strToU8(markdown()), [entry(second).path]: strToU8(markdown(second)) }
		await expect(decodeTicketArchive(fixture(files))).rejects.toThrow("undeclared files")
		await expect(
			decodeTicketArchive(fixture({ [entry().path]: strToU8(markdown()) }, [entry()], 2)),
		).rejects.toThrow()
	})

	it("rejects symbolic links and encrypted files before decompression", async () => {
		const bytes = Buffer.from(fixture({ [entry().path]: strToU8(markdown()) }))
		const offset = centralOffset(bytes, 1)
		bytes.writeUInt32LE(0xa0000000, offset + 38)
		await expect(decodeTicketArchive(bytes)).rejects.toThrow("Unsupported ticket archive entry")
		bytes.writeUInt32LE(0, offset + 38)
		bytes.writeUInt16LE(1, offset + 8)
		await expect(decodeTicketArchive(bytes)).rejects.toThrow("Unsupported ticket archive entry")
	})

	it("rejects declared oversized files and a deflate bomb with a dishonest original size", async () => {
		const bytes = Buffer.from(fixture({ [entry().path]: strToU8("x".repeat(500000)) }))
		await expect(decodeTicketArchive(bytes)).rejects.toThrow("exceeds size limit")
		const offset = centralOffset(bytes, 1)
		const local = bytes.readUInt32LE(offset + 42)
		bytes.writeUInt32LE(1000, offset + 24)
		bytes.writeUInt32LE(1000, local + 22)
		await expect(decodeTicketArchive(bytes)).rejects.toThrow("oversized compressed ticket")
	})

	it("rejects corruption and truncated archives", async () => {
		const encoded = Buffer.from(await encodeTicketArchive([entry()]))
		const offset = centralOffset(encoded, 1)
		const local = encoded.readUInt32LE(offset + 42)
		const start = local + 30 + encoded.readUInt16LE(local + 26) + encoded.readUInt16LE(local + 28)
		encoded[start] ^= 1
		await expect(decodeTicketArchive(encoded)).rejects.toThrow("integrity check")
		await expect(decodeTicketArchive(encoded.subarray(0, encoded.length - 8))).rejects.toThrow("archive index")
		await expect(decodeTicketArchive(new Uint8Array(3))).rejects.toThrow()
	})

	it("rejects invalid Markdown frontmatter, duplicate YAML fields and aliases", () => {
		for (const text of ["No frontmatter", "---\nid: nope\n---\n", `---\nid: ${first}\nid: ${second}\n---\n`])
			expect(() => decodeTicketMarkdown("ticket.md", text)).toThrow()
		expect(() => decodeTicketMarkdown("ticket.md", `---\nid: &id ${first}\nstatus: *id\n---\n`)).toThrow()
	})

	it("honors pre-cancellation and cancels between archive entries", async () => {
		const controller = new AbortController()
		controller.abort(new Error("Stopped"))
		await expect(encodeTicketArchive([entry()], controller.signal)).rejects.toThrow("Stopped")
		await expect(decodeTicketArchive(new Uint8Array(30), controller.signal)).rejects.toThrow("Stopped")
		const active = new AbortController()
		const encoding = encodeTicketArchive([entry(), entry(second)], active.signal)
		active.abort(new Error("Cancelled"))
		await expect(encoding).rejects.toThrow()
		const bytes = await encodeTicketArchive([entry(), entry(second)])
		const decoding = new AbortController()
		const pending = decodeTicketArchive(bytes, decoding.signal)
		decoding.abort(new Error("Cancelled"))
		await expect(pending).rejects.toThrow()
	})

	it("destroys an active asynchronous decompressor when cancellation arrives", async () => {
		const actual = await vi.importActual<typeof import("node:zlib")>("node:zlib")
		const controller = new AbortController()
		let active: ReturnType<typeof zlib.createInflateRaw> | undefined
		vi.mocked(zlib.createInflateRaw).mockImplementationOnce((options) => {
			active = actual.createInflateRaw(options)
			queueMicrotask(() => controller.abort(new Error("Stopped during decompression")))
			return active
		})
		await expect(
			decodeTicketArchive(fixture({ [entry().path]: strToU8(markdown()) }), controller.signal),
		).rejects.toThrow("Stopped during decompression")
		expect(active?.destroyed).toBe(true)
	})
})
