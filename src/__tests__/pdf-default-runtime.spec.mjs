import { afterEach, describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import * as esbuild from "esbuild"

import { defaultPdfRuntimePlugin } from "../pdf-default-runtime.mjs"

const require = createRequire(import.meta.url)
const roots = []

async function temporaryRoot() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-pdf-runtime-")))
	roots.push(root)
	return root
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		expect(path.dirname(root)).toBe(await fs.realpath(os.tmpdir()))
		expect(path.basename(root)).toMatch(/^alpha-pdf-runtime-/u)
		await fs.rm(root, { recursive: true, force: true })
	}
})

function pdfFixture() {
	const stream = "BT /F1 12 Tf 50 750 Td (Alpha bundled PDF extraction) Tj 0 -20 Td (Second content line) Tj ET"
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
	]
	let document = "%PDF-1.4\n"
	const offsets = []
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(document))
		document += `${index + 1} 0 obj\n${object}\nendobj\n`
	}
	const xref = Buffer.byteLength(document)
	document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
	for (const offset of offsets) document += `${String(offset).padStart(10, "0")} 00000 n \n`
	document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return Uint8Array.from(Buffer.from(document))
}

describe("default PDF runtime bundling", () => {
	it("preserves real extraction and malformed-input errors while excluding unused parser versions", async () => {
		const root = await temporaryRoot()
		const build = async (directory, plugins) => {
			const outfile = path.join(root, directory, "pdf.cjs")
			const result = await esbuild.build({
				entryPoints: [require.resolve("pdf-parse/lib/pdf-parse")],
				outfile,
				bundle: true,
				minify: true,
				sourcemap: true,
				sourcesContent: false,
				platform: "node",
				format: "cjs",
				metafile: true,
				logLevel: "silent",
				plugins,
			})
			const versions = [
				...new Set(
					Object.keys(result.metafile.inputs)
						.map((file) => file.replaceAll("\\", "/").match(/\/pdf\.js\/(v[^/]+)\/build\//u)?.[1])
						.filter(Boolean),
				),
			].sort()
			return { parse: require(outfile), bytes: (await fs.stat(outfile)).size, versions }
		}
		const before = await build("before", [])
		const capturedInputs = new Map()
		const after = await build("after", [
			defaultPdfRuntimePlugin(undefined, (file, bytes) => {
				capturedInputs.set(file, Buffer.from(bytes))
			}),
		])
		const parserPath = require.resolve("pdf-parse/lib/pdf-parse")
		const parserManifest = path.resolve(path.dirname(parserPath), "../package.json")
		expect(capturedInputs.get(parserPath)).toEqual(await fs.readFile(parserPath))
		expect(capturedInputs.get(parserManifest)).toEqual(await fs.readFile(parserManifest))
		expect(before.versions).toEqual(["v1.10.100", "v1.10.88", "v1.9.426", "v2.0.550"])
		expect(after.versions).toEqual(["v1.10.100"])
		expect(after.bytes).toBeLessThan(before.bytes / 2)

		const expected = await before.parse(pdfFixture())
		expect(expected).toMatchObject({
			numpages: 1,
			numrender: 1,
			version: "1.10.100",
			text: "\n\nAlpha bundled PDF extraction\nSecond content line",
		})
		await expect(after.parse(pdfFixture())).resolves.toEqual(expected)
		for (const parser of [before.parse, after.parse]) {
			await expect(parser(Uint8Array.from(Buffer.from("not a PDF")))).rejects.toMatchObject({
				name: "InvalidPDFException",
				message: "Invalid PDF structure",
			})
		}
	}, 60_000)

	it.each([
		["version drift", "1.1.2", "v1.10.100", "require(`./pdf.js/${options.version}/build/pdf.js`)"],
		["default drift", "1.1.1", "v2.0.550", "require(`./pdf.js/${options.version}/build/pdf.js`)"],
		["require drift", "1.1.1", "v1.10.100", "require(options.version)"],
	])("fails packaging on unreviewed %s", async (_label, version, runtime, expression) => {
		const root = await temporaryRoot()
		const directory = path.join(root, "node_modules", "pdf-parse")
		const parserPath = path.join(directory, "lib", "pdf-parse.js")
		await fs.mkdir(path.dirname(parserPath), { recursive: true })
		await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "pdf-parse", version }))
		await fs.writeFile(
			parserPath,
			`const DEFAULT_OPTIONS = { version: '${runtime}' }; module.exports = ${expression}`,
		)
		await expect(
			esbuild.build({
				entryPoints: [parserPath],
				bundle: true,
				write: false,
				logLevel: "silent",
				plugins: [defaultPdfRuntimePlugin(parserPath)],
			}),
		).rejects.toThrow("Unexpected pdf-parse default-runtime contract")
	})
})
