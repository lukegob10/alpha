import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const lintRequire = createRequire(require.resolve("lint-staged"))
const braces = createRequire(lintRequire.resolve("micromatch"))("braces")
const extensionRequire = createRequire(new URL("../src/package.json", import.meta.url))
const loggerRequire = createRequire(extensionRequire.resolve("global-agent"))
const sprintf = createRequire(loggerRequire.resolve("roarr"))("sprintf-js").sprintf
const sdkRequire = createRequire(extensionRequire.resolve("@modelcontextprotocol/sdk/server/index.js"))
const qs = createRequire(sdkRequire.resolve("express"))("qs")

// GHSA-6pq8-jhm2-2vcw: exercise the dependency used by the installed MCP transport.
test("query serialization handles hostile comma-array elements without throwing", () => {
	for (const input of [{ a: [{ toString: "x" }] }, qs.parse("a[0][toString]=x", { allowPrototypes: true })]) {
		for (const encodeValuesOnly of [false, true]) {
			assert.doesNotThrow(() => qs.stringify(input, { arrayFormat: "comma", encodeValuesOnly }))
		}
	}
	assert.equal(qs.stringify({ a: ["one", "two"] }, { arrayFormat: "comma" }), "a=one%2Ctwo")
})

test("patched braces rejects deeply nested patterns before recursive processing", () => {
	for (const [open, close] of [
		["{", "}"],
		["(", ")"],
	]) {
		const pattern = open.repeat(4_000) + "a,b" + close.repeat(4_000)
		for (const method of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
			assert.throws(() => method(pattern), { name: "SyntaxError", message: /maximum depth/ })
		}
	}
})

test("patched braces also bounds directly supplied ASTs", () => {
	for (const method of [braces.compile, braces.expand, braces.stringify]) {
		const ast = { type: "root", nodes: [] }
		let parent = ast
		for (let depth = 0; depth < 200; depth++) {
			const child = { type: "paren", nodes: [], parent }
			parent.nodes.push(child)
			parent = child
		}
		assert.throws(() => method(ast), { name: "SyntaxError", message: /maximum depth/ })
	}
})

test("patched braces retains ordinary workspace glob behavior", () => {
	assert.equal(braces.compile("src/{core,{api,utils}}/*.ts"), "src/(core|(api|utils))/*.ts")
	assert.deepEqual(braces.expand("src/{core,{api,utils}}/*.ts"), ["src/core/*.ts", "src/api/*.ts", "src/utils/*.ts"])
	assert.equal(braces.stringify("a/{b,c}/d"), "a/{b,c}/d")
})

test("patched sprintf bounds numeric precision and preserves normal formats", () => {
	for (const digits of ["1000000", "9".repeat(400)]) {
		assert.equal(sprintf(`%.${digits}f`, 1.25), (1.25).toFixed(100))
		assert.equal(sprintf(`%.${digits}e`, 1.25), (1.25).toExponential(100))
		assert.equal(sprintf(`%.${digits}g`, 1.25), "1.25")
	}
	assert.equal(sprintf("%.0g", 1.25), "1")
	assert.equal(sprintf("%.0f", 1.25), "1")
	assert.equal(sprintf("%.2f %s", 1.25, "ticket"), "1.25 ticket")
	assert.equal(sprintf("%.2e", 1.25), "1.25e+0")
})

test("production document parsers resolve the same patched formatter", () => {
	for (const dependency of ["gray-matter", "mammoth"]) {
		let parent = createRequire(extensionRequire.resolve(dependency))
		if (dependency === "gray-matter") parent = createRequire(parent.resolve("js-yaml"))
		const argparseRequire = createRequire(parent.resolve("argparse"))
		assert.equal(argparseRequire("sprintf-js").sprintf("%.1000000f", 1.25), (1.25).toFixed(100))
	}
})
