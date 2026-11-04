import { setImmediate as yieldToHost } from "node:timers/promises"
import { createInflateRaw } from "node:zlib"
import { Zip, ZipPassThrough } from "fflate"
import { parseDocument } from "yaml"
import { z } from "zod"
import { ticketIdSchema, ticketStatusSchema, type TicketTransferEntry } from "@alpha-code/types"

export const maxTicketArchiveBytes = 20 * 1024 * 1024
export const maxTicketTransferBytes = 16 * 1024 * 1024
export const maxTicketTransferCount = 1000
const maxMarkdownBytes = 100000
const maxManifestBytes = 256 * 1024
const manifestName = "manifest.json"
const utf8 = new TextDecoder("utf-8", { fatal: true })
const manifestSchema = z
	.object({
		format: z.literal("alpha-tickets"),
		version: z.literal(1),
		tickets: z
			.array(z.object({ path: z.string().max(100), status: ticketStatusSchema }).strict())
			.min(1)
			.max(maxTicketTransferCount),
	})
	.strict()

function validateTicketPath(file: string): void {
	const parts = file.split("/")
	if (
		parts.length !== 2 ||
		!ticketStatusSchema.safeParse(parts[0]).success ||
		!parts[1].endsWith(".md") ||
		!ticketIdSchema.safeParse(parts[1].slice(0, -3)).success
	)
		throw new Error("Invalid ticket path in archive")
}

function checkedEntries(entries: TicketTransferEntry[]): void {
	if (!entries.length || entries.length > maxTicketTransferCount)
		throw new Error("Ticket bundles must contain between 1 and 1000 tickets")
	const ids = new Set<string>()
	let bytes = 0
	for (const entry of entries) {
		validateTicketPath(entry.path)
		if (entry.status !== entry.path.split("/")[0]) throw new Error("Ticket status does not match archive path")
		const id = entry.path.split("/")[1].toLowerCase()
		if (ids.has(id)) throw new Error("Duplicate ticket ID in archive")
		ids.add(id)
		const size = Buffer.byteLength(entry.markdown, "utf8")
		if (size > maxMarkdownBytes) throw new Error("Ticket exceeds 100 KB")
		bytes += size
	}
	if (bytes > maxTicketTransferBytes) throw new Error("Ticket bundle exceeds 16 MiB")
}

/** Stored ZIP entries keep encoding bounded without spawning a worker for every ticket. */
export async function encodeTicketArchive(entries: TicketTransferEntry[], signal?: AbortSignal): Promise<Uint8Array> {
	signal?.throwIfAborted()
	checkedEntries(entries)
	const manifest = Buffer.from(
		JSON.stringify({
			format: "alpha-tickets",
			version: 1,
			tickets: entries.map(({ path, status }) => ({ path, status })),
		}),
	)
	if (manifest.length > maxManifestBytes) throw new Error("Ticket manifest exceeds limit")
	const chunks: Uint8Array[] = []
	let failure: Error | undefined
	const archive = new Zip((error, chunk) => {
		if (error) failure = error
		else chunks.push(chunk)
	})
	try {
		const add = (name: string, bytes: Uint8Array) => {
			const file = new ZipPassThrough(name)
			archive.add(file)
			file.push(bytes, true)
			if (failure) throw failure
		}
		add(manifestName, manifest)
		for (const entry of entries) {
			signal?.throwIfAborted()
			add(entry.path, Buffer.from(entry.markdown, "utf8"))
			await yieldToHost(undefined, { signal })
		}
		archive.end()
		if (failure) throw failure
		signal?.throwIfAborted()
		return Buffer.concat(chunks)
	} finally {
		archive.terminate()
	}
}

type ArchiveEntry = {
	name: string
	method: number
	crc: number
	size: number
	compressedSize: number
	start: number
	end: number
	offset: number
}

/**
 * Validate the complete ZIP index before any decompression. PKWARE APPNOTE 6.3.10
 * (retrieved 2026-10-31); ZIP64, split, encrypted and non-file entries are outside this format.
 */
function archiveEntries(data: Buffer): ArchiveEntry[] {
	if (data.length < 22 || data.length > maxTicketArchiveBytes) throw new Error("Invalid or oversized ticket archive")
	let end = data.length - 22
	for (; end >= Math.max(0, data.length - 65557); end--) {
		if (data.readUInt32LE(end) === 0x06054b50 && end + 22 + data.readUInt16LE(end + 20) === data.length) break
	}
	if (end < Math.max(0, data.length - 65557) || data.readUInt32LE(end) !== 0x06054b50)
		throw new Error("Invalid ticket archive index")
	const count = data.readUInt16LE(end + 10)
	const directorySize = data.readUInt32LE(end + 12)
	const directoryStart = data.readUInt32LE(end + 16)
	if (
		data.readUInt16LE(end + 4) !== 0 ||
		data.readUInt16LE(end + 6) !== 0 ||
		data.readUInt16LE(end + 8) !== count ||
		count < 2 ||
		count > maxTicketTransferCount + 1 ||
		directoryStart + directorySize !== end
	)
		throw new Error("Unsupported ticket archive index")
	const entries: ArchiveEntry[] = []
	const names = new Set<string>()
	let cursor = directoryStart
	let totalSize = 0
	for (let index = 0; index < count; index++) {
		if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50)
			throw new Error("Invalid ticket archive entry")
		const flags = data.readUInt16LE(cursor + 8)
		const method = data.readUInt16LE(cursor + 10)
		const crc = data.readUInt32LE(cursor + 16)
		const compressedSize = data.readUInt32LE(cursor + 20)
		const size = data.readUInt32LE(cursor + 24)
		const nameLength = data.readUInt16LE(cursor + 28)
		const extraLength = data.readUInt16LE(cursor + 30)
		const commentLength = data.readUInt16LE(cursor + 32)
		const attributes = data.readUInt32LE(cursor + 38)
		const offset = data.readUInt32LE(cursor + 42)
		const next = cursor + 46 + nameLength + extraLength + commentLength
		if (
			next > end ||
			nameLength > 100 ||
			data.readUInt16LE(cursor + 6) >= 45 ||
			data.readUInt16LE(cursor + 34) !== 0 ||
			(flags & ~0x080e) !== 0 ||
			(method !== 0 && method !== 8) ||
			(attributes & 0x10) !== 0 ||
			!([0, 0x8000] as number[]).includes((attributes >>> 16) & 0xf000)
		)
			throw new Error("Unsupported ticket archive entry")
		const name = utf8.decode(data.subarray(cursor + 46, cursor + 46 + nameLength))
		if (name !== manifestName) validateTicketPath(name)
		if (names.has(name.toLowerCase())) throw new Error("Duplicate file in ticket archive")
		names.add(name.toLowerCase())
		if (size > (name === manifestName ? maxManifestBytes : maxMarkdownBytes))
			throw new Error("Ticket archive entry exceeds size limit")
		if (name !== manifestName) totalSize += size
		if (totalSize > maxTicketTransferBytes) throw new Error("Ticket bundle exceeds 16 MiB")
		if (offset + 30 > directoryStart || data.readUInt32LE(offset) !== 0x04034b50)
			throw new Error("Invalid ticket archive local header")
		const localNameLength = data.readUInt16LE(offset + 26)
		const start = offset + 30 + localNameLength + data.readUInt16LE(offset + 28)
		const payloadEnd = start + compressedSize
		if (
			payloadEnd > directoryStart ||
			data.readUInt16LE(offset + 6) !== flags ||
			data.readUInt16LE(offset + 8) !== method ||
			utf8.decode(data.subarray(offset + 30, offset + 30 + localNameLength)) !== name
		)
			throw new Error("Ticket archive headers disagree")
		let entryEnd = payloadEnd
		if (flags & 8) {
			if (entryEnd + 12 > directoryStart) throw new Error("Invalid ticket archive data descriptor")
			if (data.readUInt32LE(entryEnd) === 0x08074b50) entryEnd += 4
			if (
				entryEnd + 12 > directoryStart ||
				data.readUInt32LE(entryEnd) !== crc ||
				data.readUInt32LE(entryEnd + 4) !== compressedSize ||
				data.readUInt32LE(entryEnd + 8) !== size
			)
				throw new Error("Ticket archive data descriptor disagrees")
			entryEnd += 12
		} else if (
			data.readUInt32LE(offset + 14) !== crc ||
			data.readUInt32LE(offset + 18) !== compressedSize ||
			data.readUInt32LE(offset + 22) !== size
		)
			throw new Error("Ticket archive sizes disagree")
		entries.push({ name, method, crc, size, compressedSize, start, end: entryEnd, offset })
		cursor = next
	}
	if (cursor !== end || !names.has(manifestName)) throw new Error("Ticket archive manifest is missing")
	let nextOffset = 0
	for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
		if (entry.offset !== nextOffset) throw new Error("Ticket archive has overlapping or undeclared data")
		nextOffset = entry.end
	}
	if (nextOffset !== directoryStart) throw new Error("Ticket archive has undeclared data")
	return entries
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
	return value >>> 0
})
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

function decompress(data: Buffer, maximum: number, signal?: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted()
		const stream = createInflateRaw({ chunkSize: 16 * 1024 })
		const chunks: Buffer[] = []
		let length = 0
		stream.on("data", (chunk: Buffer) => {
			length += chunk.length
			if (length > maximum) stream.destroy(new Error("Compressed ticket exceeds its size limit"))
			else chunks.push(chunk)
		})
		stream.once("error", (error) => {
			signal?.removeEventListener("abort", cancel)
			if (signal?.aborted) reject(signal.reason)
			else reject(new Error("Invalid or oversized compressed ticket", { cause: error }))
		})
		stream.once("end", () => {
			signal?.removeEventListener("abort", cancel)
			if (signal?.aborted) reject(signal.reason)
			else resolve(Buffer.concat(chunks, length))
		})
		const cancel = () =>
			stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Import cancelled"))
		signal?.addEventListener("abort", cancel, { once: true })
		stream.end(data)
	})
}

export async function decodeTicketArchive(bytes: Uint8Array, signal?: AbortSignal): Promise<TicketTransferEntry[]> {
	signal?.throwIfAborted()
	const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const index = archiveEntries(data)
	const files = new Map<string, string>()
	for (const entry of index) {
		signal?.throwIfAborted()
		const compressed = data.subarray(entry.start, entry.start + entry.compressedSize)
		const payload = entry.method === 0 ? compressed : await decompress(compressed, entry.size, signal)
		if (payload.length !== entry.size || crc32(payload) !== entry.crc)
			throw new Error("Ticket archive entry failed its integrity check")
		files.set(entry.name, utf8.decode(payload))
		await yieldToHost(undefined, { signal })
	}
	const manifest = manifestSchema.parse(JSON.parse(files.get(manifestName)!))
	if (files.size !== manifest.tickets.length + 1) throw new Error("Ticket archive contains undeclared files")
	const entries = manifest.tickets.map(({ path, status }) => {
		const markdown = files.get(path)
		if (markdown === undefined) throw new Error("Ticket archive is missing a declared file")
		return { path, status, markdown }
	})
	checkedEntries(entries)
	return entries
}

/** Native Markdown files predate portable bundles; absent status resumes safely in backlog. */
export function decodeTicketMarkdown(name: string, markdown: string): TicketTransferEntry {
	if (!name.toLowerCase().endsWith(".md") || /[/\\\0]/.test(name)) throw new Error("Choose a ticket Markdown file")
	if (Buffer.byteLength(markdown, "utf8") > maxMarkdownBytes) throw new Error("Ticket exceeds 100 KB")
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
	if (!match) throw new Error("Ticket requires YAML frontmatter")
	const document = parseDocument(match[1], { uniqueKeys: true })
	if (document.errors.length) throw new Error("Invalid ticket metadata")
	const metadata: unknown = document.toJS({ maxAliasCount: 0 })
	const fields = z.object({ id: ticketIdSchema, status: ticketStatusSchema.optional() }).parse(metadata)
	const status = fields.status ?? "backlog"
	return { path: `${status}/${fields.id}.md`, status, markdown }
}
