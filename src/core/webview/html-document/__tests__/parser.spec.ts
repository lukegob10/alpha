import * as path from "node:path"
import { MessageChannel, Worker } from "node:worker_threads"
import { HTML_DOCUMENT_LIMITS } from "@alpha-code/types"
import { DocumentParser } from "../parser"
import type { DocumentParseRequest } from "../sanitize"

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
		vi.restoreAllMocks()
		vi.useRealTimers()
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

	it("carries the document directory across the worker boundary for local PNG charts", async () => {
		const result = await parser.parse(html('<img src="plots/fit%20chart.png" alt="Fit">'), "reports")
		expect(result.images.get("image-0")).toEqual({ path: "reports/plots/fit chart.png", alt: "Fit" })
		expect(result.html).not.toContain("src=")
	})

	it("reuses a warm worker for consecutive successful parses and preserves its message listeners", async () => {
		for (const content of ["First", "Second", "Third"]) {
			const result = await parser.parse(html(`<p>${content}</p><a data-source="src/${content}.ts">Source</a>`))
			expect(result.html).toContain(content)
			expect(result.references.get("ref-0")).toMatchObject({ kind: "source", path: `src/${content}.ts` })
		}
	})

	it("rejects adversarial depth through the actual built sanitizer worker", async () => {
		const source = html("<div>".repeat(10000) + "nested" + "</div>".repeat(10000))
		expect(Buffer.byteLength(source)).toBeLessThan(HTML_DOCUMENT_LIMITS.bytes)
		await expect(parser.parse(source)).rejects.toThrow("size")
	})

	it("keeps the host responsive and enforces its deadline while an actual worker is blocked", async () => {
		parser = new DocumentParser(path.join(__dirname, "fixtures", "blockedParser.mjs"))
		const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
		const channel = new MessageChannel()
		const ready = new Promise<void>((resolve) => channel.port1.once("message", () => resolve()))
		const postMessage = Worker.prototype.postMessage
		vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			request: DocumentParseRequest,
		) {
			postMessage.call(this, { ...request, gate, ready: channel.port2 }, [channel.port2])
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let settled = false
		try {
			const result = parser.parse(html("<p>Blocked worker</p>")).catch((error: Error) => {
				settled = true
				return error
			})
			await ready
			// The worker is physically waiting on Atomics. An event-loop checkpoint
			// and the host deadline must progress independently of that worker.
			await new Promise<void>((resolve) => setImmediate(resolve))
			await vi.advanceTimersByTimeAsync(1499)
			expect(settled).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			expect(await result).toMatchObject({ message: "size" })
		} finally {
			Atomics.store(new Int32Array(gate), 0, 1)
			Atomics.notify(new Int32Array(gate), 0)
			channel.port1.close()
			channel.port2.close()
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
