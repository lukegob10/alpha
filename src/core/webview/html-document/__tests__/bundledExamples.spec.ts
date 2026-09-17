import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { load } from "cheerio"

import { sanitizeDocument } from "../sanitize"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
const kitDirectory = path.join(repository, "webview-ui/public/artifact-kit/v1")
// Reuse the webview's existing DOM test dependency; do not introduce a runtime dependency in the extension.
const { JSDOM } = createRequire(path.join(repository, "webview-ui/package.json"))("jsdom") as {
	JSDOM: new (
		html: string,
		options: { runScripts: string },
	) => {
		window: Window & typeof globalThis & { AlphaDocumentKit: { mount: (root: Element) => () => void } }
	}
}
const kitScript = readFileSync(path.join(kitDirectory, "kit.js"), "utf8")
const viewerScript = readFileSync(path.join(repository, "webview-ui/public/html-document/viewer.js"), "utf8")
const examples = ["review", "spec", "report"] as const
const sourceFor = (name: string) => readFileSync(path.join(kitDirectory, "examples", `${name}.html`), "utf8")

describe("bundled Rich documents authoring and viewer contract", () => {
	it("renders charts through sanitization and the actual viewer message adapter on initial delivery and refresh", () => {
		const dom = new JSDOM(
			'<body><span id="viewer-title"></span><button id="viewer-source">Source</button><p id="viewer-status"></p><div id="viewer-content"></div></body>',
			{ runScripts: "outside-only" },
		)
		try {
			const { window } = dom
			const target = { uri: "file:///workspace/report.html" }
			const identity = { documentId: target.uri, token: "a".repeat(48) }
			const api = { getState: vi.fn(), setState: vi.fn(), postMessage: vi.fn() }
			Object.assign(window, {
				acquireVsCodeApi: () => api,
				requestAnimationFrame: (callback: () => void) => callback(),
				scrollTo: vi.fn(),
			})
			window.document.body.dataset.viewerConfig = JSON.stringify({ target, ...identity })
			window.eval(kitScript)
			window.eval(viewerScript)
			expect(api.postMessage).toHaveBeenCalledWith({ ...identity, action: "ready", revision: 0 })
			const sanitized = sanitizeDocument(sourceFor("report"))
			expect(sanitized.html).not.toMatch(/<script|<svg|<canvas/)
			for (const revision of [1, 2]) {
				const previous = window.document.querySelector("svg")
				window.dispatchEvent(
					new window.MessageEvent("message", {
						data: { ...identity, type: "document", revision, html: sanitized.html, title: sanitized.title },
					}),
				)
				expect(window.document.querySelectorAll("figure[data-alpha-chart] svg")).toHaveLength(2)
				expect(window.document.querySelectorAll("table[data-alpha-chart-data] tbody tr")).toHaveLength(16)
				expect(window.document.querySelectorAll("svg [tabindex]").length).toBeGreaterThan(0)
				if (previous) expect(previous.isConnected).toBe(false)
			}
			window.dispatchEvent(new window.Event("pagehide"))
			expect(window.document.querySelector("svg")).toBeNull()
		} finally {
			dom.window.close()
		}
	})

	it("requires native HTML preview delivery and source validation without browser fallbacks", () => {
		const skill = readFileSync(path.join(repository, "src/assets/skills/rich-documents/SKILL.md"), "utf8")
		expect(skill).toContain("Always use Alpha's built-in HTML previewer")
		expect(skill).toContain("Never use browser tools")
		for (const tool of ["open_browser_page", "navigate_page", "run_playwright_code"]) expect(skill).toContain(tool)
		expect(skill).toContain("localhost server")
		expect(skill).toContain("[Open document](alpha-document://open?uri=")
		expect(skill).toContain("validate the source and deliver the document link")
		expect(skill).not.toContain("Use available preview validation")
	})

	it("retains labeled status components and table controls from the component gallery", () => {
		const result = load(sanitizeDocument(sourceFor("index")).html)
		for (const status of ["good", "warning", "danger", "info"])
			expect(result(`.badge.status-${status}`).text().trim()).not.toBe("")
		expect(result(".card .key-values dt")).toHaveLength(3)
		expect(result(".table-toolbar label").attr("for")).toBe(result("input[data-alpha-filter]").attr("id"))
		expect(result(".table-scroll tbody tr")).toHaveLength(4)
	})

	it.each(examples)("preserves %s semantics and widget inputs while removing author execution", (name) => {
		const source = sourceFor(name)
		const original = load(source)
		const result = sanitizeDocument(
			source
				.replace('<main class="alpha-doc"', '<main onclick="globalThis.authorRan=true" class="alpha-doc"')
				.replace(
					"</main>",
					"<script>globalThis.authorRan=true</script><style>main{display:none}</style></main>",
				),
		)
		const sanitized = load(result.html)
		expect(result.title).toBe(original("title").text())
		expect(sanitized('main.alpha-doc[data-alpha-kit="1"]')).toHaveLength(1)
		expect(sanitized("h1")).toHaveLength(1)
		for (const selector of ["h1,h2,h3", "table caption", "thead th", "tbody tr", "details summary"]) {
			const text = (document: ReturnType<typeof load>) =>
				document(selector)
					.toArray()
					.map((node) => document(node).text().replace(/\s+/g, " ").trim())
			expect(text(sanitized)).toEqual(text(original))
		}
		for (const attribute of [
			"data-severity",
			"data-sort",
			"data-sort-value",
			"data-chart-type",
			"data-unit",
			"data-value",
		]) {
			const values = (document: ReturnType<typeof load>) =>
				document(`[${attribute}]`)
					.toArray()
					.map((node) => document(node).attr(attribute))
			expect(values(sanitized)).toEqual(values(original))
		}
		for (const selector of [
			"[data-alpha-table]",
			"[data-alpha-filter]",
			"[data-alpha-chart]",
			"[data-alpha-chart-data]",
		]) {
			expect(sanitized(selector).length).toBe(original(selector).length)
		}
		expect(sanitized("script,style,link,[onclick],[src],[data-source],[data-line]")).toHaveLength(0)
		for (const input of sanitized("input[data-alpha-filter]").toArray()) {
			expect(sanitized(input).attr("type")).toBe("search")
			expect(sanitized(input).attr("disabled")).toBeDefined()
		}
		for (const anchor of original("a[data-source]").toArray()) {
			expect([...result.references.values()]).toContainEqual({
				kind: "source",
				path: original(anchor).attr("data-source"),
				line: Number(original(anchor).attr("data-line") ?? 1),
			})
		}
	})

	it.each(examples)(
		"enhances sanitized %s with the actual packaged kit and restores readable fallback on dispose",
		(name) => {
			const { html } = sanitizeDocument(sourceFor(name))
			const dom = new JSDOM(html, { runScripts: "outside-only" })
			try {
				const { window } = dom
				window.eval(kitScript)
				const root = window.document.querySelector("main")!
				const tableRows = () => Array.from(root.querySelectorAll("tbody tr")).map((row) => row.textContent)
				const originalTableText = tableRows()
				const dispose = window.AlphaDocumentKit.mount(root)
				expect(root.textContent).not.toContain("enhancement is unavailable")
				for (const input of Array.from(root.querySelectorAll<HTMLInputElement>("input[data-alpha-filter]"))) {
					expect(input.disabled).toBe(false)
					const rows = Array.from(
						input.closest("[data-alpha-table]")!.querySelectorAll<HTMLTableRowElement>("tbody tr"),
					)
					expect(rows.length).toBeGreaterThan(0)
					input.value = "no-row-matches-this-fixture"
					input.dispatchEvent(new window.Event("input", { bubbles: true }))
					expect(rows.every((row) => row.hidden)).toBe(true)
					input.value = ""
					input.dispatchEvent(new window.Event("input", { bubbles: true }))
					expect(rows.every((row) => !row.hidden)).toBe(true)
					const sort = input
						.closest("[data-alpha-table]")!
						.querySelector<HTMLButtonElement>("th[data-sort] button")!
					expect(sort).not.toBeNull()
					sort.click()
					expect(sort.closest("th")!.getAttribute("aria-sort")).toBe("ascending")
				}
				if (name === "report") {
					expect(root.querySelectorAll(".metric-card")).toHaveLength(2)
					expect(root.querySelector('a[href="#source-1"]')).not.toBeNull()
					expect(root.querySelectorAll("figure[data-alpha-chart] svg")).toHaveLength(2)
					expect(root.querySelectorAll("table[data-alpha-chart-data] tbody tr")).toHaveLength(16)
					expect(root.querySelectorAll("svg [tabindex]").length).toBeGreaterThan(0)
				}
				if (name === "spec") {
					expect(root.querySelectorAll("[data-alpha-diagram] svg rect")).toHaveLength(6)
					expect(root.querySelectorAll(".timeline > li")).toHaveLength(3)
					expect(sanitizeDocument(sourceFor(name)).images.get("image-0")?.path).toBe(
						"images/layout-sample.png",
					)
				}
				expect(root.querySelector("nav[data-alpha-toc] a")).not.toBeNull()
				dispose()
				expect(root.querySelectorAll("svg, th button")).toHaveLength(0)
				expect(tableRows()).toEqual(originalTableText)
				for (const input of Array.from(root.querySelectorAll<HTMLInputElement>("input[data-alpha-filter]")))
					expect(input.disabled).toBe(true)
			} finally {
				dom.window.close()
			}
		},
	)

	it("resolves every on-demand skill reference to a source resource copied to its installed location", () => {
		const skillDirectory = path.join(repository, "src/assets/skills/rich-documents")
		const skill = readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8")
		const links = [...skill.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((match) => match[1])
		expect(links).toHaveLength(4)
		const installedRoot = path.join(repository, "src/webview-ui/build/artifact-kit/v1")
		const resolved = links.map((link) => {
			const relative = path.relative(installedRoot, path.resolve(skillDirectory, link))
			expect(relative.startsWith("..")).toBe(false)
			expect(path.isAbsolute(relative)).toBe(false)
			expect(existsSync(path.join(kitDirectory, relative))).toBe(true)
			return relative.split(path.sep).join("/")
		})
		expect(resolved.sort()).toEqual([
			"examples/report.html",
			"examples/review.html",
			"examples/spec.html",
			"reference.md",
		])
		expect(readFileSync(path.join(repository, "src/.vscodeignore"), "utf8")).toContain(
			"!webview-ui/build/artifact-kit/**",
		)
	})
})
