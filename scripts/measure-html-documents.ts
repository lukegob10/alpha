import { performance } from "node:perf_hooks"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DocumentParser } from "../src/core/webview/html-document/parser"

const wrap = (body: string) =>
	`<!doctype html><html><head><meta name="alpha-document" content="1"><title>Measured fixture</title></head><body><main class="alpha-doc" data-alpha-kit="1">${body}</main></body></html>`
const fixtures = {
	small: readFileSync("webview-ui/public/artifact-kit/v1/examples/review.html", "utf8"),
	large: wrap(
		`<table><tbody>${Array.from({ length: 1000 }, (_, row) => `<tr>${Array.from({ length: 5 }, (_, col) => `<td>Row ${row} column ${col}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
	),
	deep: wrap("<div>".repeat(10000) + "x" + "</div>".repeat(10000)),
	malformed: wrap("<table><b><i>".repeat(3000) + "x"),
}
async function main() {
	for (const [name, source] of Object.entries(fixtures)) {
		const parser = new DocumentParser(path.resolve("src/dist/workers/sanitizeDocument.js"))
		const times: number[] = []
		let outcome = "accepted"
		for (let index = 0; index < 12; index++) {
			const start = performance.now()
			try {
				await parser.parse(source)
			} catch (error) {
				outcome = error instanceof Error ? error.message : "error"
			}
			times.push(performance.now() - start)
		}
		const sorted = [...times.slice(1)].sort((a, b) => a - b)
		console.log(
			JSON.stringify({
				name,
				bytes: Buffer.byteLength(source),
				outcome,
				coldMs: times[0],
				warmP50Ms: sorted[Math.floor(sorted.length / 2)],
				warmP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
			}),
		)
		parser.dispose()
	}
}
void main()
