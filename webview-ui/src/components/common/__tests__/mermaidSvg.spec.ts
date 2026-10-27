import { mermaidSvgDataUri, prepareMermaidSvg } from "../mermaidSvg"

describe("Mermaid SVG preparation", () => {
	it("preserves a comma-separated viewBox, HTML labels, and background at the original origin", () => {
		const diagram = prepareMermaidSvg(
			'<svg width="100%" viewBox="-10,-20,1200,600"><foreignObject><div>Revenue £</div></foreignObject></svg>',
			"#ffffff",
		)
		expect(diagram).toMatchObject({ width: 1200, height: 600 })
		const document = new DOMParser().parseFromString(diagram.svg, "image/svg+xml")
		expect(document.querySelector("parsererror")).toBeNull()
		expect(document.querySelector("rect")?.getAttribute("x")).toBe("-10")
		expect(document.querySelector("rect")?.getAttribute("y")).toBe("-20")
		expect(document.querySelector("rect")?.getAttribute("fill")).toBe("#ffffff")
		expect(document.querySelector("div")?.namespaceURI).toBe("http://www.w3.org/1999/xhtml")
	})

	it("encodes a large Unicode diagram without a spread-argument overflow", () => {
		const markup = `<svg><text>${"Revenue £ → résumé 📊".repeat(10_000)}</text></svg>`
		const uri = mermaidSvgDataUri(markup)
		const bytes = Uint8Array.from(atob(uri.split(",")[1]!), (character) => character.charCodeAt(0))
		expect(new TextDecoder().decode(bytes)).toBe(markup)
	})
})
