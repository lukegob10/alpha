import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import ExcelJS from "exceljs"
import mammoth from "mammoth"
// @ts-ignore-next-line
import pdf from "pdf-parse/lib/pdf-parse"
import { isBinaryFile } from "isbinaryfile"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { extractTextFromFileRaw, extractTextFromFileWithMetadata } from "../extract-text"
import { readWithSlice } from "../indentation-reader"
import { MAX_LINE_LENGTH } from "../../../core/prompts/tools/native-tools/read_file"

// Canonical unit runs own temporary fixtures; explicit WS04 leases retain their evidence.
// Real parsers and canonical Alpha imports are deliberate: no mocked parser or source loader belongs here.
const extensions = ["pdf", "docx", "xlsx", "ipynb"] as const
type Extension = (typeof extensions)[number]
type FixtureIdentity = { filename: string; bytes: number; sha256: string }
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const within = (root: string, candidate: string) => {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const canonical = (value: string) =>
	process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)

function storedZip(files: Readonly<Record<string, string>>): Buffer {
	const crc32 = (bytes: Buffer) => {
		let crc = 0xffffffff
		for (const byte of bytes) {
			crc ^= byte
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
		}
		return (crc ^ 0xffffffff) >>> 0
	}
	let offset = 0
	const local: Buffer[] = []
	const central: Buffer[] = []
	for (const [name, content] of Object.entries(files)) {
		const filename = Buffer.from(name)
		const bytes = Buffer.from(content)
		const header = Buffer.alloc(30)
		header.writeUInt32LE(0x04034b50, 0)
		header.writeUInt16LE(20, 4)
		header.writeUInt16LE(0x5c21, 12)
		header.writeUInt32LE(crc32(bytes), 14)
		header.writeUInt32LE(bytes.length, 18)
		header.writeUInt32LE(bytes.length, 22)
		header.writeUInt16LE(filename.length, 26)
		local.push(header, filename, bytes)
		const entry = Buffer.alloc(46)
		entry.writeUInt32LE(0x02014b50, 0)
		entry.writeUInt16LE(20, 4)
		entry.writeUInt16LE(20, 6)
		entry.writeUInt16LE(0x5c21, 14)
		entry.writeUInt32LE(crc32(bytes), 16)
		entry.writeUInt32LE(bytes.length, 20)
		entry.writeUInt32LE(bytes.length, 24)
		entry.writeUInt16LE(filename.length, 28)
		entry.writeUInt32LE(offset, 42)
		central.push(entry, filename)
		offset += header.length + filename.length + bytes.length
	}
	const directory = Buffer.concat(central)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(Object.keys(files).length, 8)
	end.writeUInt16LE(Object.keys(files).length, 10)
	end.writeUInt32LE(directory.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...local, directory, end])
}

function pdfFixture(lines: readonly string[]): Buffer {
	const literal = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
	// The small font keeps the complete long line on the page; its decoded tail must still pass the oracle.
	const stream =
		"BT /F1 10 Tf 50 750 Td " +
		lines
			.map(
				(line, index) =>
					`${index ? "0 -20 Td " : ""}${index === lines.length - 1 ? "/F1 0.1 Tf " : ""}(${literal(line)}) Tj`,
			)
			.join(" ") +
		" ET"
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
	]
	let output = "%PDF-1.4\n"
	const offsets: number[] = []
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(output))
		output += `${index + 1} 0 obj\n${object}\nendobj\n`
	}
	const xref = Buffer.byteLength(output)
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
	for (const offset of offsets) output += `${String(offset).padStart(10, "0")} 00000 n \n`
	output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return Buffer.from(output)
}

function docxFixture(lines: readonly string[]): Buffer {
	const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
	return storedZip({
		"[Content_Types].xml":
			'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		"_rels/.rels":
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		"word/document.xml":
			'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
			lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join("") +
			"<w:sectPr/></w:body></w:document>",
	})
}

describe("real document parsers through canonical extraction imports", () => {
	let fixtureRoot: string | undefined
	let ownedRunRoot: string | undefined
	let fixtureIdentities: FixtureIdentity[] = []
	let lines: string[] = []
	let markers: string[] = []
	let longLine = ""

	beforeAll(async () => {
		let runRoot = process.env.WS04_RUN_ROOT
		let runId = process.env.WS04_RUN_ID
		let caseId = process.env.WS04_CASE_ID
		const repoRoot = await fs.realpath(path.resolve(__dirname, "../../../.."))
		if (runRoot === undefined && runId === undefined && caseId === undefined) {
			const temporaryParent = await fs.realpath(os.tmpdir())
			expect(within(repoRoot, temporaryParent), "Temporary fixtures must be outside the checkout").toBe(false)
			ownedRunRoot = await fs.mkdtemp(path.join(temporaryParent, "alpha-real-documents-"))
			runRoot = ownedRunRoot
			runId = path.basename(ownedRunRoot)
			caseId = "canonical-unit"
			await fs.mkdir(path.join(runRoot, caseId))
		}
		expect(runRoot && path.isAbsolute(runRoot), "Document fixtures require an absolute run root").toBe(true)
		expect(runId, "Document fixtures require a valid run ID").toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
		expect(caseId, "Document fixtures require a valid case ID").toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
		if (!runRoot || !runId || !caseId) throw new Error("Missing document fixture run inputs")
		const realRunRoot = await fs.realpath(runRoot)
		expect(canonical(realRunRoot), "Run root must not be a junction/symlink alias").toBe(canonical(runRoot))
		expect(within(repoRoot, realRunRoot) || within(realRunRoot, repoRoot), "Use an external run root").toBe(false)
		const caseRoot = path.join(runRoot, caseId)
		const realCaseRoot = await fs.realpath(caseRoot)
		expect(canonical(realCaseRoot), "Root must precreate the case directory without aliases").toBe(
			canonical(caseRoot),
		)
		expect(within(realRunRoot, realCaseRoot)).toBe(true)
		fixtureRoot = await fs.mkdtemp(path.join(realCaseRoot, "actual-documents-"))
		expect(within(realCaseRoot, await fs.realpath(fixtureRoot))).toBe(true)

		const prefix = `WS04_${sha256(`${runId}:${caseId}`).slice(0, 12)}`
		markers = ["START", "MIDDLE", "END", "AUTHORED_PIPE", "TAIL"].map((name) => `${prefix}_${name}`)
		longLine = "x".repeat(MAX_LINE_LENGTH + 500) + markers[4]!
		lines = [markers[0]!, markers[1]!, markers[2]!, `1 | ${markers[3]!}`, longLine]
		await fs.writeFile(path.join(fixtureRoot, "requirements.pdf"), pdfFixture(lines), { flag: "wx" })
		await fs.writeFile(path.join(fixtureRoot, "requirements.docx"), docxFixture(lines), { flag: "wx" })
		await fs.writeFile(
			path.join(fixtureRoot, "requirements.ipynb"),
			JSON.stringify({
				nbformat: 4,
				nbformat_minor: 5,
				metadata: {},
				cells: [
					{
						cell_type: "markdown",
						id: "requirements",
						metadata: {},
						source: lines.map((line) => line + "\n"),
					},
				],
			}),
			{ flag: "wx" },
		)
		const workbook = new ExcelJS.Workbook()
		workbook.created = new Date("2026-10-14T00:00:00.000Z")
		workbook.modified = new Date("2026-10-14T00:00:00.000Z")
		workbook.addWorksheet("Requirements").addRows(lines.map((line) => [line]))
		await fs.writeFile(
			path.join(fixtureRoot, "requirements.xlsx"),
			Buffer.from(await workbook.xlsx.writeBuffer()),
			{
				flag: "wx",
			},
		)
		fixtureIdentities = await Promise.all(
			extensions.map(async (extension) => {
				const filename = `requirements.${extension}`
				const bytes = await fs.readFile(path.join(fixtureRoot!, filename))
				return { filename, bytes: bytes.length, sha256: sha256(bytes) }
			}),
		)
		await fs.writeFile(
			path.join(fixtureRoot, "fixture-manifest.json"),
			JSON.stringify(
				{ recipe: "ws04-canonical-real-documents-v1", runId, caseId, files: fixtureIdentities },
				null,
				2,
			) + "\n",
			{ flag: "wx" },
		)
	})

	const requireMarkers = (text: string, label: string) => {
		for (const marker of markers) {
			expect(text.split(marker).length - 1, `${label}: each source marker must decode exactly once`).toBe(1)
		}
		expect(text, `${label}: the complete long line and tail must decode before projection`).toContain(longLine)
		const positions = markers.map((marker) => text.indexOf(marker))
		expect(positions, `${label}: source marker order`).toEqual([...positions].sort((a, b) => a - b))
	}

	async function nativeText(extension: Extension, filename: string, bytes: Buffer): Promise<string> {
		if (extension === "pdf") return (await pdf(Uint8Array.from(bytes))).text
		if (extension === "docx") return (await mammoth.extractRawText({ path: filename })).value
		if (extension === "xlsx") {
			const workbook = new ExcelJS.Workbook()
			await workbook.xlsx.readFile(filename)
			const worksheet = workbook.getWorksheet("Requirements")
			expect(worksheet, "Native XLSX fixture worksheet").toBeDefined()
			const values = lines.map((_, index) => worksheet!.getCell(index + 1, 1).value)
			expect(values, "Native XLSX fixture cell values").toEqual(lines)
			return values.join("\n")
		}
		const notebook = JSON.parse(bytes.toString("utf8")) as { cells: Array<{ source: string[] }> }
		expect(notebook.cells, "Native notebook fixture cells").toHaveLength(1)
		return notebook.cells[0]!.source.join("")
	}

	it.each(extensions)("decodes all %s source markers before applying document excerpt bounds", async (extension) => {
		expect(fixtureRoot, "Fixture setup must finish before parser evidence is accepted").toBeDefined()
		const filename = path.join(fixtureRoot!, `requirements.${extension}`)
		const bytes = await fs.readFile(filename)
		const atPhase = async <T>(phase: string, pending: Promise<T>): Promise<T> => {
			try {
				return await pending
			} catch (cause) {
				throw new Error(`${extension}: ${phase} rejected`, { cause })
			}
		}
		// pdf-parse may swallow page-render errors and return blank prefix lines. This oracle must fail first.
		requireMarkers(
			await atPhase("native fixture/parser decode", nativeText(extension, filename, bytes)),
			`${extension} native fixture/parser oracle`,
		)
		expect(await isBinaryFile(filename), `${extension} real binary sniffer`).toBe(extension !== "ipynb")
		const raw = await atPhase("canonical Alpha raw extraction", extractTextFromFileRaw(filename))
		requireMarkers(raw, `${extension} canonical Alpha raw extraction`)
		for (const line of lines.slice(0, -1)) expect(raw.split("\n")).toContain(line)

		const result = await atPhase("canonical Alpha metadata limit2", extractTextFromFileWithMetadata(filename, 2))
		const expected = readWithSlice(raw, 0, 2)
		expect(result).toMatchObject({
			content: expected.content,
			totalLines: expected.totalLines,
			returnedLines: 2,
			wasTruncated: true,
			linesShown: [1, 2],
			isExtractedDocument: true,
		})
		expect(result.content).not.toContain(markers[4]!)
		const clippedLine = raw.split("\n").findIndex((line) => line.length > MAX_LINE_LENGTH) + 1
		expect(clippedLine, "A real decoded line must exceed the existing character bound").toBeGreaterThan(2)
		const clipped = await atPhase("canonical Alpha metadata default", extractTextFromFileWithMetadata(filename))
		expect(clipped.firstClippedLine).toBe(clippedLine)
		expect(clipped.wasTruncated).toBe(true)
		expect(clipped.content).not.toContain(markers[4]!)
	})

	afterAll(async () => {
		try {
			if (!fixtureRoot) return
			for (const identity of fixtureIdentities) {
				const bytes = await fs.readFile(path.join(fixtureRoot, identity.filename))
				expect(bytes.length, "Fixture size must remain stable during the gate").toBe(identity.bytes)
				expect(sha256(bytes), "Fixture bytes must remain stable during the gate").toBe(identity.sha256)
			}
		} finally {
			// A supplied WS04 lease retains its directory and manifest for root-owned receipt review.
			if (ownedRunRoot) {
				const realOwnedRunRoot = await fs.realpath(ownedRunRoot)
				const repoRoot = await fs.realpath(path.resolve(__dirname, "../../../.."))
				expect(path.isAbsolute(ownedRunRoot), "Cleanup requires an absolute owned temporary root").toBe(true)
				expect(canonical(realOwnedRunRoot), "Cleanup must not follow a replacement directory alias").toBe(
					canonical(ownedRunRoot),
				)
				expect(
					within(repoRoot, realOwnedRunRoot) || within(realOwnedRunRoot, repoRoot),
					"Cleanup must stay outside the checkout",
				).toBe(false)
				await fs.rm(realOwnedRunRoot, { recursive: true, force: true })
			}
		}
	})
})
