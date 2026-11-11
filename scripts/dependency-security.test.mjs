import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const lintRequire = createRequire(require.resolve("lint-staged"))
const picomatch = lintRequire("picomatch")
const extensionRequire = createRequire(new URL("../src/package.json", import.meta.url))
const { parse } = extensionRequire("yaml")
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

test("the frozen dependency graph cannot restore the retired vulnerable libraries or local patches", () => {
	const workspace = parse(readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"))
	const lockfile = parse(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"))
	assert.equal(workspace.patchedDependencies, undefined)
	assert.equal(lockfile.patchedDependencies, undefined)
	assert.deepEqual(
		Object.keys(lockfile.packages).filter((name) =>
			/^(?:(?:braces|micromatch|sprintf-js|roarr)@|zod@3\.)/.test(name),
		),
		[],
	)
})

test("the installed glob matcher handles hostile nesting within a bounded process", () => {
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			`
const assert = require("node:assert/strict")
const picomatch = require(process.argv[1])
for (const [open, close] of [["{", "}"], ["(", ")"]]) {
	const pattern = open.repeat(4000) + "a,b" + close.repeat(4000)
	assert.equal(typeof picomatch.parse(pattern).output, "string")
	assert.ok(picomatch.makeRe(pattern) instanceof RegExp)
	assert.equal(typeof picomatch(pattern)("a,b"), "boolean")
}
`,
			lintRequire.resolve("picomatch"),
		],
		{ encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 },
	)
	assert.ifError(result.error)
	assert.equal(result.status, 0, result.stderr)
})

test("the installed glob matcher bounds input length and retains workspace glob behavior", () => {
	const oversized = "a".repeat(65_537)
	for (const method of [picomatch.parse, picomatch.makeRe, picomatch]) {
		assert.throws(() => method(oversized), { name: "SyntaxError", message: /maximum allowed length/ })
	}
	const matches = picomatch("src/{core,{api,utils}}/*.ts")
	for (const file of ["src/core/a.ts", "src/api/b.ts", "src/utils/c.ts"]) assert.equal(matches(file), true)
	for (const file of ["src/core/.hidden.ts", "src/other/a.ts", "src/api/b.js"]) assert.equal(matches(file), false)
	assert.equal(picomatch("!*.js")("file.ts"), true)
	assert.equal(picomatch("!*.js")("file.js"), false)
	const repeated = picomatch("+(*(a)|*(b))")
	for (const value of ["aaaa", "bbbb", "aabb"]) assert.equal(repeated(value), true)
	assert.equal(repeated("aabb!"), false)
})

test("legacy document parser CLIs retain their argument API without sprintf-js", () => {
	for (const dependency of ["gray-matter", "mammoth"]) {
		let parent = createRequire(extensionRequire.resolve(dependency))
		if (dependency === "gray-matter") parent = createRequire(parent.resolve("js-yaml"))
		const { ArgumentParser } = parent("argparse")
		const parser = new ArgumentParser({ addHelp: false, version: "1" })
		parser.addArgument(["file"], { type: "string", defaultValue: "default.docx", nargs: "?" })
		parser.addArgument(["--compact"], { action: "storeTrue" })
		assert.equal(parser.parseArgs([]).file, "default.docx")
		const args = parser.parseArgs(["sample.docx", "--compact"])
		assert.equal(args.file, "sample.docx")
		assert.equal(args.compact, true)
	}
})
