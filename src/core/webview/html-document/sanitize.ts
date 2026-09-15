import { load } from "cheerio"
import { HTML_DOCUMENT_LIMITS, HTML_DOCUMENT_VERSION, type HtmlDocumentReference } from "@alpha-code/types"

const tags = new Set(
	"main article section header footer nav aside h1 h2 h3 h4 h5 h6 p div span strong em b i u s small mark sub sup abbr time blockquote pre code kbd samp ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td details summary a hr br label input figure figcaption img".split(
		" ",
	),
)
const attributes = new Set(
	"id class title role aria-label aria-labelledby aria-describedby aria-hidden for scope colspan rowspan datetime open data-alpha-kit data-severity data-alpha-table data-alpha-filter data-sort data-sort-value data-alpha-chart data-chart-type data-alpha-chart-data data-unit data-value data-alpha-tabs data-tab-label data-alpha-toc data-alpha-diagram".split(
		" ",
	),
)
const forbidden =
	"script,style,iframe,frame,frameset,object,embed,svg,math,template,form,link,meta,base,audio,video,canvas,source,textarea,select,button"
export type DocumentImage = { path: string; alt: string }
export interface SanitizedDocument {
	title: string
	html: string
	references: Map<string, HtmlDocumentReference>
	images: Map<string, DocumentImage>
}

/** Parse and reconstruct an allowlist. CSP is defense in depth, not the sanitizer. */
export function sanitizeDocument(source: string): SanitizedDocument {
	if (Buffer.byteLength(source, "utf8") > HTML_DOCUMENT_LIMITS.bytes) throw new Error("size")
	const $ = load(source)
	const markers = $('meta[name="alpha-document"]')
	if (markers.length !== 1 || markers.attr("content") !== HTML_DOCUMENT_VERSION) throw new Error("version")
	const title = $("head > title").text().trim()
	if (!title || title.length > 200) throw new Error("format")
	const root = $('body > main.alpha-doc[data-alpha-kit="1"]')
	if (root.length !== 1) throw new Error("format")
	const elements = root.find("*").addBack()
	if (elements.length > HTML_DOCUMENT_LIMITS.nodes) throw new Error("size")
	// Iterative parent walks are bounded independently of parser/browser recursion.
	for (const element of elements.toArray()) {
		let depth = 0
		let parent = element.parent
		while (parent) {
			if (++depth > HTML_DOCUMENT_LIMITS.depth) throw new Error("size")
			parent = parent.parent
		}
	}
	root.find(forbidden).remove()
	const references = new Map<string, HtmlDocumentReference>()
	const images = new Map<string, DocumentImage>()
	const ids = new Set<string>()
	for (const element of root.find("*").addBack().toArray()) {
		if (element.type !== "tag") continue
		const node = $(element)
		if (!tags.has(element.name)) {
			node.replaceWith(node.contents())
			continue
		}
		const sourcePath = node.attr("data-source")
		const line = node.attr("data-line") ?? "1"
		const href = node.attr("href")
		const imagePath = node.attr("data-image")
		const alt = node.attr("alt")?.trim()
		for (const [name, value] of Object.entries(element.attribs)) {
			if (!attributes.has(name) || value.length > 2048) node.removeAttr(name)
		}
		const id = node.attr("id")
		if (id) {
			if (!/^[A-Za-z][\w-]{0,127}$/.test(id) || ids.has(id)) node.removeAttr("id")
			else ids.add(id)
		}
		if (element.name === "img") {
			// Authored src/srcset/data URLs never reach the renderer. Only the host
			// may hydrate these opaque slots with scoped, bounded raster bytes.
			if (!imagePath || !alt) {
				node.remove()
				continue
			}
			if (
				imagePath.length > 2048 ||
				/[\\:]/.test(imagePath) ||
				[...imagePath].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
				imagePath.startsWith("/") ||
				imagePath.split("/").some((part) => !part || part === "." || part === "..") ||
				!/\.(png|jpe?g)$/i.test(imagePath)
			)
				throw new Error("reference")
			if (images.size >= HTML_DOCUMENT_LIMITS.images || alt.length > 2048) throw new Error("size")
			const imageId = `image-${images.size}`
			images.set(imageId, { path: imagePath, alt })
			node.replaceWith(`<span data-alpha-image="${imageId}"></span>`)
		}
		if (element.name === "input") {
			if (!node.is("[data-alpha-filter]") || !node.closest("[data-alpha-table]").length) {
				node.remove()
				continue
			}
			node.attr("type", "search").attr("disabled", "disabled")
		}
		if (element.name === "a") {
			if (sourcePath !== undefined) {
				if (
					!sourcePath ||
					sourcePath.length > 2048 ||
					/[\\:]/.test(sourcePath) ||
					[...sourcePath].some(
						(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
					) ||
					sourcePath.startsWith("/") ||
					sourcePath.split("/").some((part) => part === ".." || part === "." || !part) ||
					!/^[1-9]\d{0,6}$/.test(line)
				)
					throw new Error("reference")
				if (references.size >= HTML_DOCUMENT_LIMITS.references) throw new Error("size")
				const referenceId = `ref-${references.size}`
				references.set(referenceId, { kind: "source", path: sourcePath, line: Number(line) })
				node.attr("data-alpha-reference", referenceId).attr("href", "#")
			} else if (href && /^#[A-Za-z][\w-]{0,127}$/.test(href)) node.attr("href", href)
			else if (href?.startsWith("https://") && href.length <= 2048) {
				try {
					const url = new URL(href)
					if (url.protocol === "https:" && !url.username && !url.password) {
						if (references.size >= HTML_DOCUMENT_LIMITS.references) throw new Error("size")
						const referenceId = `ref-${references.size}`
						references.set(referenceId, { kind: "external", url: url.href })
						node.attr("data-alpha-reference", referenceId).attr("href", "#")
					}
				} catch (error) {
					if (error instanceof Error && error.message === "size") throw error
				}
			}
		}
	}
	if (
		root.find("[data-alpha-chart],[data-alpha-table],[data-alpha-tabs],[data-alpha-toc],[data-alpha-diagram]")
			.length > HTML_DOCUMENT_LIMITS.widgets
	)
		throw new Error("size")
	for (const cell of root.find("[data-value]").toArray()) {
		const value = $(cell).attr("data-value")!
		if (value !== "" && (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))))
			throw new Error("data")
	}
	return { title, html: $.html(root), references, images }
}

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
	)
}
