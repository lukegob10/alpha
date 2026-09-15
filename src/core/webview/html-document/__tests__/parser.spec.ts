import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { HTML_DOCUMENT_LIMITS } from "@alpha-code/types"
import { DocumentParser } from "../parser"

// The normal extension bundle produces this actual worker. Do not mock its
// sanitizer: these tests exercise isolation, structured cloning and cancellation.
const workerPath = path.resolve(__dirname, "../../../../dist/workers/sanitizeDocument.js")
const html = (body: string) =>
	`<!doctype html><html><head><meta name="alpha-document" content="1"><title>Worker document</title></head><body><main class="alpha-doc" data-alpha-kit="1">${body}</main></body></html>`

describe("DocumentParser built worker", () => {
	let parser: DocumentParser
	beforeEach(() => {
		parser = new DocumentParser(workerPath)
	})
	afterEach(() => {
		parser.dispose()
	})

	it("sanitizes valid HTML and returns usable structured-cloned reference maps", async () => {
		const result = await parser.parse(
			html(
				'<p onclick="evil()">Evidence</p><script>evil()</script><a data-source="src/file.ts" data-line="7">Source</a>',
			),
		)
		expect(result.title).toBe("Worker document")
		expect(result.html).not.toContain("evil")
		expect(result.references).toBeInstanceOf(Map)
		expect(result.images).toBeInstanceOf(Map)
		expect(result.references.get("ref-0")).toMatchObject({ kind: "source", path: "src/file.ts", line: 7 })
	})

	it("rejects oversized source before starting parsing", async () => {
		await expect(parser.parse("x".repeat(HTML_DOCUMENT_LIMITS.bytes + 1))).rejects.toThrow("size")
	})

	it("reuses a warm worker for consecutive successful parses and preserves its message listeners", async () => {
		for (const content of ["First", "Second", "Third"]) {
			const result = await parser.parse(html(`<p>${content}</p><a data-source="src/${content}.ts">Source</a>`))
			expect(result.html).toContain(content)
			expect(result.references.get("ref-0")).toMatchObject({ kind: "source", path: `src/${content}.ts` })
		}
	})

	it("rejects adversarial depth within the deadline while the calling event loop remains responsive", async () => {
		const source = html("<div>".repeat(10000) + "nested" + "</div>".repeat(10000))
		expect(Buffer.byteLength(source)).toBeLessThan(HTML_DOCUMENT_LIMITS.bytes)
		const started = performance.now()
		let heartbeatCount = 0
		const interval = setInterval(() => heartbeatCount++, 10)
		try {
			const result = parser.parse(source).catch((error: Error) => error)
			await delay(50)
			expect(heartbeatCount).toBeGreaterThanOrEqual(2)
			expect(await result).toMatchObject({ message: "size" })
			expect(performance.now() - started).toBeLessThan(3500)
		} finally {
			clearInterval(interval)
		}
	})

	it("cancels active work on dispose and permits a subsequent explicit parse", async () => {
		const pending = parser.parse(html("<div>".repeat(10000))).catch((error: Error) => error)
		parser.dispose()
		expect(await pending).toMatchObject({ message: "cancelled" })
		parser.dispose()
		expect((await parser.parse(html("<p>Recovered</p>"))).title).toBe("Worker document")
	})

	it("supersedes an older parse and resolves only the newest job", async () => {
		const older = parser.parse(html("<div>".repeat(10000))).catch((error: Error) => error)
		const newer = parser.parse(html("<p>Newest</p>"))
		expect(await older).toMatchObject({ message: "cancelled" })
		expect((await newer).html).toContain("Newest")
	})

	it("reports format/version failures without poisoning the next job", async () => {
		await expect(parser.parse("<html><title>Missing marker</title></html>")).rejects.toThrow("version")
		expect((await parser.parse(html("<p>Valid</p>"))).html).toContain("Valid")
	})
})
