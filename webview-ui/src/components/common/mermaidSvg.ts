export interface MermaidDiagram {
	svg: string
	width: number
	height: number
}

/** Preserve Mermaid's coordinate system so 100% means readable SVG pixels in both viewers. */
export function prepareMermaidSvg(markup: string, background?: string): MermaidDiagram {
	const container = document.createElement("div")
	container.innerHTML = markup
	const svg = container.querySelector("svg")
	if (!svg) throw new Error("Mermaid did not produce an SVG diagram")

	const viewBox = svg
		.getAttribute("viewBox")
		?.trim()
		.split(/[\s,]+/)
		.map(Number)
	const hasViewBox = viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0
	const dimension = (name: "width" | "height", fallback: number) => {
		const attribute = svg.getAttribute(name) ?? ""
		const value = /^\d+(?:\.\d+)?(?:px)?$/.test(attribute) ? Number.parseFloat(attribute) : Number.NaN
		return Number.isFinite(value) && value > 0 ? value : fallback
	}
	const width = hasViewBox ? viewBox[2]! : dimension("width", 300)
	const height = hasViewBox ? viewBox[3]! : dimension("height", 150)
	svg.setAttribute("width", String(width))
	svg.setAttribute("height", String(height))
	svg.style.width = `${width}px`
	svg.style.height = `${height}px`
	svg.style.maxWidth = "none"
	if (background) {
		const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect")
		rect.setAttribute("x", String(hasViewBox ? viewBox[0]! : 0))
		rect.setAttribute("y", String(hasViewBox ? viewBox[1]! : 0))
		rect.setAttribute("width", String(width))
		rect.setAttribute("height", String(height))
		rect.setAttribute("fill", background)
		rect.setAttribute("aria-hidden", "true")
		svg.prepend(rect)
	}
	return { svg: new XMLSerializer().serializeToString(svg), width, height }
}

export function mermaidSvgDataUri(markup: string): string {
	const bytes = new TextEncoder().encode(markup)
	let binary = ""
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
	}
	return `data:image/svg+xml;base64,${btoa(binary)}`
}
