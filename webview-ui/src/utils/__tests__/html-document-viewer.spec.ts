import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

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
		const api = { getState: vi.fn(), setState: vi.fn(), postMessage: vi.fn() }
		const dispose = vi.fn()
		Object.assign(window, {
			acquireVsCodeApi: () => api,
			AlphaDocumentKit: { mount: vi.fn(() => dispose) },
			requestAnimationFrame: (callback: () => void) => callback(),
			scrollTo: vi.fn(),
		})
		window.document.body.dataset.viewerConfig = JSON.stringify({ target, documentId: target.uri, token })
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
		const details = window.document.getElementById("evidence") as HTMLDetailsElement
		details.open = true
		;(window.document.getElementById("filter") as HTMLInputElement).value = "stable"
		send(2, html)
		expect((window.document.getElementById("evidence") as HTMLDetailsElement).open).toBe(true)
		expect((window.document.getElementById("filter") as HTMLInputElement).value).toBe("stable")
		expect(dispose).toHaveBeenCalledTimes(1)
		send(1, "old")
		send(3, "other", { documentId: "file:///other.html" })
		expect(window.document.getElementById("evidence")).not.toBeNull()
		;(window.document.querySelector("a") as HTMLAnchorElement).click()
		expect(api.postMessage).toHaveBeenLastCalledWith({
			action: "reference",
			documentId: target.uri,
			token,
			revision: 2,
			referenceId: "ref-0",
		})
		send(3, '<main class="alpha-doc"><details id="new"><summary>New</summary></details></main>')
		expect((window.document.getElementById("new") as HTMLDetailsElement).open).toBe(false)
		window.dispatchEvent(new window.Event("pagehide"))
		expect(dispose).toHaveBeenCalledTimes(3)
		expect(api.setState).toHaveBeenCalledWith(expect.objectContaining({ target }))
		window.close()
	})
})
