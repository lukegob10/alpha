import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import createDOMPurify from "dompurify"
import { HTML_DOCUMENT_TAGS, HTML_DOCUMENT_RENDER_ATTRIBUTES, HTML_DOCUMENT_LIMITS } from "@alpha-code/types"

const script = readFileSync(path.resolve("public/html-document/viewer.js"), "utf8")
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
	JSDOM: new (html: string, options: { runScripts: string }) => { window: Window & typeof globalThis }
}

describe("packaged HTML viewer runtime", () => {
	it("preserves matching disclosures/filter state and scroll, rejects stale messages and disposes widgets", () => {
		const dom = new JSDOM(
			'<body><header><span id="viewer-title"></span><button id="viewer-source">Source</button></header><p id="viewer-status"></p><div id="viewer-content"></div></body>',
			{ runScripts: "outside-only" },
		)
		const { window } = dom
		const target = { uri: "file:///work/review.html", taskId: "task-1" }
		const token = "a".repeat(48)
		const api = {
			getState: vi.fn(() => ({ target, view: { scroll: 240 } })),
			setState: vi.fn(),
			postMessage: vi.fn(),
		}
		const dispose = vi.fn()
		const frames = new Map<number, FrameRequestCallback>()
		let nextFrameId = 0
		const scrollTo = vi.fn((_x: number, y: number) => Object.assign(window, { scrollY: y }))
		Object.assign(window, {
			DOMPurify: createDOMPurify(window),
			acquireVsCodeApi: () => api,
			AlphaDocumentKit: { mount: vi.fn(() => dispose) },
			requestAnimationFrame: (callback: FrameRequestCallback) => {
				const id = ++nextFrameId
				frames.set(id, callback)
				return id
			},
			cancelAnimationFrame: (id: number) => frames.delete(id),
			scrollTo,
		})
		window.document.body.dataset.viewerConfig = JSON.stringify({
			target,
			documentId: target.uri,
			token,
			sanitizer: {
				tags: HTML_DOCUMENT_TAGS,
				attributes: HTML_DOCUMENT_RENDER_ATTRIBUTES,
				maxHtmlLength: HTML_DOCUMENT_LIMITS.renderBytes,
			},
		})
		window.eval(script)
		const send = (revision: number, html: string, overrides = {}) =>
			window.dispatchEvent(
				new window.MessageEvent("message", {
					data: {
						type: "document",
						documentId: target.uri,
						token,
						revision,
						html,
						title: "Review",
						...overrides,
					},
				}),
			)
		const html =
			'<main class="alpha-doc"><details id="evidence"><summary>Evidence</summary>Text</details><input data-alpha-filter id="filter"><a href="#" data-alpha-reference="ref-0">Source</a></main>'
		send(1, html)
		send(1, html) // The ready handshake can replay an already delivered snapshot.
		const details = window.document.getElementById("evidence") as HTMLDetailsElement
		const filter = window.document.getElementById("filter") as HTMLInputElement
		details.open = true
		filter.value = "stable"
		vi.spyOn(window.document, "hasFocus").mockReturnValue(true)
		filter.focus()
		filter.setSelectionRange(1, 4)
		send(2, html, { title: "Updated title", stale: true, staleLabel: "Stale.", error: "Source unavailable." })
		expect(window.document.getElementById("filter") === filter).toBe(true)
		expect(window.document.activeElement === filter).toBe(true)
		expect([filter.selectionStart, filter.selectionEnd]).toEqual([1, 4])
		expect(window.document.getElementById("viewer-title")?.textContent).toBe("Updated title")
		expect(window.document.title).toBe("Updated title")
		expect(window.document.getElementById("viewer-status")?.textContent).toBe("Stale. Source unavailable.")
		expect(window.document.getElementById("viewer-content")?.dataset.stale).toBe("true")
		expect(dispose).not.toHaveBeenCalled()
		;(window.document.querySelector("a") as HTMLAnchorElement).click()
		expect(api.postMessage).toHaveBeenLastCalledWith({
			action: "reference",
			documentId: target.uri,
			token,
			revision: 2,
			referenceId: "ref-0",
		})
		send(3, html.replace("</summary>Text", "</summary>Changed text"))
		for (const [id, callback] of frames) {
			frames.delete(id)
			callback(0)
		}
		expect(scrollTo.mock.calls).toEqual([[0, 240]])
		expect(api.setState).toHaveBeenLastCalledWith({ target, view: expect.objectContaining({ scroll: 240 }) })
		expect((window.document.getElementById("evidence") as HTMLDetailsElement).open).toBe(true)
		expect((window.document.getElementById("filter") as HTMLInputElement).value).toBe("stable")
		expect(window.document.activeElement?.id).toBe("filter")
		expect(window.document.getElementById("evidence")?.textContent).toContain("Changed text")
		expect(window.document.getElementById("viewer-status")?.hidden).toBe(true)
		expect(dispose).toHaveBeenCalledTimes(1)
		send(1, "old")
		send(4, "other", { documentId: "file:///other.html" })
		expect(window.document.getElementById("evidence")).not.toBeNull()
		;(window.document.querySelector("a") as HTMLAnchorElement).click()
		expect(api.postMessage).toHaveBeenLastCalledWith({
			action: "reference",
			documentId: target.uri,
			token,
			revision: 3,
			referenceId: "ref-0",
		})
		window.document.getElementById("viewer-source")!.focus()
		send(4, html)
		expect(window.document.activeElement?.id).toBe("viewer-source")
		send(5, '<main class="alpha-doc"><a href="#section">Jump</a><h2 id="section">Evidence</h2></main>')
		const section = window.document.getElementById("section")!
		section.scrollIntoView = vi.fn()
		window.document.querySelector<HTMLAnchorElement>("a")!.click()
		expect(section.scrollIntoView).toHaveBeenCalledTimes(1)
		expect(window.document.activeElement).toBe(section)
		window.document.querySelector<HTMLAnchorElement>("a")!.click()
		window.document.getElementById("viewer-source")!.focus()
		expect(section.hasAttribute("tabindex")).toBe(false)
		send(6, '<main class="alpha-doc"><details id="new"><summary>New</summary></details></main>')
		expect((window.document.getElementById("new") as HTMLDetailsElement).open).toBe(false)
		send(
			7,
			'<main class="alpha-doc"><a id="unsafe" onclick="throw 1" href="javascript:throw 1">safe text</a><img src="https://evil.test"><img src="data:image/svg+xml;base64,PHN2Zz4="><script>throw 1</script></main>',
		)
		expect(window.document.querySelector("#unsafe")?.getAttribute("onclick")).toBeNull()
		expect(window.document.querySelector("#unsafe")?.getAttribute("href")).toBeNull()
		expect(window.document.querySelector("script, [src]")).toBeNull()
		send(8, "x".repeat(HTML_DOCUMENT_LIMITS.renderBytes + 1))
		expect(window.document.querySelector("#unsafe")?.textContent).toBe("safe text")
		expect(frames.size).toBe(1)
		window.dispatchEvent(new window.Event("pagehide"))
		expect(frames.size).toBe(0)
		expect(dispose).toHaveBeenCalledTimes(6)
		expect(api.setState).toHaveBeenCalledWith(expect.objectContaining({ target }))
		window.close()
	})
})
