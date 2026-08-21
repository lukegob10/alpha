import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const commonJs = require("../dist/index.cjs")
const esModule = await import("../dist/index.js")

for (const [format, entrypoint] of [
	["CommonJS", commonJs],
	["ES module", esModule],
]) {
	for (const exportName of ["RooCodeEventName", "poeDefaultModelId", "getPoeDefaultModelInfo"]) {
		if (!(exportName in entrypoint)) {
			throw new Error(`${format} @alpha-code/types entrypoint is missing ${exportName}`)
		}
	}
}
