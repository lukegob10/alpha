import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"

const workspace = path.resolve(process.argv[2])
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-registry-native-probe-"))
try {
	const bundle = path.join(temporary, "registry.mjs")
	await promisify(execFile)(process.execPath, [
		path.join(workspace, "src/node_modules/esbuild-wasm/bin/esbuild"),
		path.join(workspace, "packages/core/src/custom-tools/custom-tool-registry.ts"),
		`--outfile=${bundle}`,
		"--bundle",
		"--format=esm",
		"--platform=node",
		"--target=node18",
		"--banner:js=import { createRequire as __alpha_createRequire } from 'module'; var require = __alpha_createRequire(import.meta.url);",
	])
	const { CustomToolRegistry } = createRequire(import.meta.url)(bundle)
	const fixtures = path.join(workspace, "packages/core/src/custom-tools/__tests__/fixtures")
	const overrides = path.join(workspace, "packages/core/src/custom-tools/__tests__/fixtures-override")
	const cacheDir = path.join(temporary, "cache")
	const owner = new CustomToolRegistry({ cacheDir })
	for (let round = 0; round < 4; round++) {
		const registry = round === 3 ? new CustomToolRegistry({ cacheDir }) : owner
		const result = await registry.loadFromDirectory(fixtures)
		assert.equal(result.failed.length, 1)
		assert.equal(result.failed[0].file, "invalid.ts")
		assert.match(result.failed[0].error, /Invalid tool definition/)
		assert.deepEqual([...registry.list()].sort(), [
			"cached",
			"legacy",
			"mixed_validTool",
			"multi_toolA",
			"multi_toolB",
			"simple",
		])
		assert.equal(await registry.get("legacy").execute({ input: "legacy" }, {}), "legacy")
		assert.equal(await registry.get("mixed_validTool").execute({}, {}), "valid")
		assert.equal(await registry.get("multi_toolA").execute({}, {}), "A")
		assert.equal(await registry.get("multi_toolB").execute({}, {}), "B")
		assert.equal(await registry.get("simple").execute({ value: "native" }, {}), "Result: native")
		assert.deepEqual(registry.get("simple").parameters.parse({ value: "schema" }), { value: "schema" })
		console.log(`Native Linux load ${round + 1}: six tools and one expected invalid definition`)
	}
	const result = await owner.loadFromDirectories([fixtures, overrides])
	assert.equal(result.failed.length, 1)
	assert.equal(result.loaded.filter((name) => name === "simple").length, 2)
	assert.equal(owner.get("simple").description, "Simple tool - OVERRIDDEN")
	console.log(`Native Linux override load passed on ${process.version} (${process.platform})`)
} finally {
	await fs.rm(temporary, { recursive: true, force: true })
}
