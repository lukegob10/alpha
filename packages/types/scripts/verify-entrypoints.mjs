import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const commonJs = require("../dist/index.cjs")
const esModule = await import("../dist/index.js")

for (const [format, entrypoint] of [
	["CommonJS", commonJs],
	["ES module", esModule],
]) {
	for (const exportName of ["AlphaCodeEventName", "RooCodeEventName", "providerNames", "vertexDefaultModelId"]) {
		if (!(exportName in entrypoint)) {
			throw new Error(`${format} @alpha-code/types entrypoint is missing ${exportName}`)
		}
	}
	if (entrypoint.AlphaCodeEventName !== entrypoint.RooCodeEventName) {
		throw new Error(`${format} @alpha-code/types legacy event export must alias the canonical enum`)
	}
}
