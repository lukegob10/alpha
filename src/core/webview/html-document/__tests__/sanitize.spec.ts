import { sanitizeDocument } from "../sanitize"
import { htmlDocumentMessageSchema, parseHtmlDocumentLink } from "@alpha-code/types"

const fixture = (body: string) =>
	`<!doctype html><html><head><meta name="alpha-document" content="1"><title>Review &amp; evidence</title></head><body><main class="alpha-doc" data-alpha-kit="1">${body}</main></body></html>`

describe("HTML document validation boundary", () => {
	it("keeps ordinary content, encoded snippets and opaque source references", () => {
		const result = sanitizeDocument(
			fixture(
				'<h1>Review</h1><pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre><a data-source="src/a.ts" data-line="12">Evidence</a>',
			),
		)
		expect(result.title).toBe("Review & evidence")
		expect(result.html).toContain("&lt;script&gt;")
		expect(result.html).not.toContain("data-source")
		expect(result.references.get("ref-0")).toEqual({ kind: "source", path: "src/a.ts", line: 12 })
	})
	it.each([
		"<script>alert(1)</script>",
		'<script type="application/json">{}</script>',
		'<svg onload="alert(1)"><a href="javascript:alert(1)">x</a></svg>',
		'<iframe src="https://evil.test"></iframe>',
		"<style>body{display:none}</style>",
		'<form action="https://evil.test"><input name="data"></form>',
		'<img src="https://evil.test/track">',
		'<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
	])("removes active document content %s", (payload) => {
		const result = sanitizeDocument(fixture(payload))
		expect(result.html).not.toMatch(/<(?:script|style|svg|iframe|form|img|math)\b|onerror=|onload=|https:\/\/evil/)
	})
	it("removes event handlers, navigation, style and unauthorized data attributes", () => {
		const result = sanitizeDocument(
			fixture(
				'<a id="ok" onclick="alert(1)" href="command:workbench.action.closeWindow" style="color:red" data-message="{}">x</a><a href="https://example.com">y</a><a href="#ok">section</a>',
			),
		)
		expect(result.html).not.toMatch(/onclick|command:|style=|data-message|https:/)
		expect(result.html).toContain('href="#ok"')
	})
	it.each(["../secret", "a/../secret", "a\\secret", "/secret", "C:/secret", "https://evil", "a//b"])(
		"rejects source reference %s",
		(reference) => {
			expect(() => sanitizeDocument(fixture(`<a data-source="${reference}">x</a>`))).toThrow("reference")
		},
	)
	it("bounds versions, structure, data and size", () => {
		expect(() => sanitizeDocument(fixture("").replace('content="1"', 'content="2"'))).toThrow("version")
		expect(() => sanitizeDocument(fixture("").replace("<title>Review &amp; evidence</title>", ""))).toThrow(
			"format",
		)
		expect(() => sanitizeDocument(fixture('<td data-value="Infinity">x</td>'))).not.toThrow() // HTML parsing drops cells outside tables.
		expect(() => sanitizeDocument(fixture('<table><tr><td data-value="1e999">x</td></tr></table>'))).toThrow("data")
		expect(() => sanitizeDocument(fixture("a".repeat(512 * 1024)))).toThrow("size")
		expect(() => sanitizeDocument(fixture("<div>".repeat(65) + "x" + "</div>".repeat(65)))).toThrow("size")
		expect(() => sanitizeDocument(fixture("<div data-alpha-table></div>".repeat(33)))).toThrow("size")
	})
	it("retains declarative kit table controls only", () => {
		const result = sanitizeDocument(
			fixture(
				'<div data-alpha-table><input id="filter" data-alpha-filter type="image" src="https://evil" oninput="alert(1)"><table><tr><th data-sort="number">Score</th></tr><tr><td data-sort-value="2">2</td></tr></table></div><input type="password">',
			),
		)
		expect(result.html).toContain('type="search"')
		expect(result.html).toContain('disabled="disabled"')
		expect(result.html).not.toMatch(/type="password"|oninput|src=/)
	})
	it("validates explicit links without command or duplicate parameter confusion", () => {
		const link = "alpha-document://open?uri=file%3A%2F%2F%2FC%3A%2Fwork%2Fa.html&task=task-1"
		expect(parseHtmlDocumentLink(link)).toEqual({ uri: "file:///C:/work/a.html", taskId: "task-1" })
		for (const value of [
			"file:///a.html",
			"command:alpha.previewHtmlDocument",
			link + "&uri=bad",
			link + "&extra=1",
			link + "#bad",
			"alpha-document://other?uri=x",
		])
			expect(parseHtmlDocumentLink(value)).toBeUndefined()
	})
	it("accepts only strict known actions and bounded identity/revision messages", () => {
		const base = { documentId: "file:///a.html", token: "a".repeat(48), revision: 1 }
		expect(
			htmlDocumentMessageSchema.safeParse({ ...base, action: "reference", referenceId: "ref-0" }).success,
		).toBe(true)
		for (const payload of [
			{ action: "executeCommand", command: "evil" },
			{ action: "source", uri: "file:///secret" },
			{ action: "source", revision: -1 },
			{ action: "reference", referenceId: "../x" },
		])
			expect(htmlDocumentMessageSchema.safeParse({ ...base, ...payload }).success).toBe(false)
	})
})
