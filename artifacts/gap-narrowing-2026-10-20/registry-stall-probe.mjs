import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"

const workspace = path.resolve(process.argv[2])
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-registry-stall-probe-"))
const trace = process.argv.includes("--trace")
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
	if (trace) {
		let source = await fs.readFile(bundle, "utf8")
		const inject = (before, after) => {
			assert.ok(source.includes(before), `Trace target missing: ${before}`)
			source = source.replaceAll(before, after)
		}
		inject(
			"async importSource(absolutePath, sourceFingerprint, force) {",
			'async importSource(absolutePath, sourceFingerprint, force) { console.error("[trace] source", absolutePath, force);',
		)
		inject(
			"async function runEsbuild(options, extensionPath) {",
			'async function runEsbuild(options, extensionPath) { console.error("[trace] compile begin", options.entryPoint);',
		)
		inject(
			'await execa(process.execPath, args, { env, stdin: "ignore" });',
			'const child = execa(process.execPath, args, { env, stdin: "ignore" }); child.on("spawn", () => console.error("[trace] child spawn", child.pid, options.entryPoint)); child.on("exit", (code, signal) => console.error("[trace] child exit", child.pid, code, signal)); child.on("close", (code, signal) => console.error("[trace] child close", child.pid, code, signal)); await child; console.error("[trace] compile complete", options.entryPoint);',
		)
		const importExpression = /return import\((url\d*)\);/
		assert.ok(importExpression.test(source), "Trace native import target missing")
		source = source.replace(
			importExpression,
			'console.error("[trace] native import begin", $1); const mod = await import($1); console.error("[trace] native import complete", $1); return mod;',
		)
		inject(
			"await this.ensureCacheDirectory();",
			'console.error("[trace] ensure cache begin"); await this.ensureCacheDirectory(); console.error("[trace] ensure cache complete");',
		)
		inject(
			"await this.pruneDiskCache(stagingDirectory);",
			'console.error("[trace] prune begin", stagingDirectory); await this.pruneDiskCache(stagingDirectory); console.error("[trace] prune complete", stagingDirectory);',
		)
		const cleanupExpression = /await (fs\d*)\.promises\.rm\(stagingDirectory, \{ recursive: true, force: true \}\);/
		assert.ok(cleanupExpression.test(source), "Trace stage cleanup target missing")
		source = source.replace(
			cleanupExpression,
			'console.error("[trace] stage cleanup begin", stagingDirectory); await $1.promises.rm(stagingDirectory, { recursive: true, force: true }); console.error("[trace] stage cleanup complete", stagingDirectory);',
		)
		await fs.writeFile(bundle, source)
	}
	const { CustomToolRegistry } = createRequire(import.meta.url)(bundle)
	const fixtures = path.join(workspace, "packages/core/src/custom-tools/__tests__/fixtures")
	const overrides = path.join(workspace, "packages/core/src/custom-tools/__tests__/fixtures-override")
	const cacheDir = path.join(temporary, "cache")
	const load = async (registry, method, directories) => {
		console.log(`[probe] begin ${method} ${directories}`)
		const result = await registry[method](directories)
		assert.equal(result.failed.length, 1)
		assert.equal(result.failed[0].file, "invalid.ts")
		assert.ok(result.loaded.includes("simple"))
		assert.equal(registry.get("simple").parameters.parse({ value: "schema" }).value, "schema")
		console.log(`[probe] complete ${method} ${directories}`)
	}
	for (let round = 0; round < 5; round++) {
		await load(new CustomToolRegistry({ cacheDir }), "loadFromDirectory", fixtures)
	}
	const cleared = new CustomToolRegistry({ cacheDir })
	await load(cleared, "loadFromDirectory", fixtures)
	cleared.clearCache()
	cleared.clear()
	await load(cleared, "loadFromDirectory", fixtures)
	for (const directories of [
		[fixtures, overrides],
		[fixtures, overrides],
		[overrides, fixtures],
		[fixtures],
		[fixtures, overrides],
	]) {
		await load(new CustomToolRegistry({ cacheDir }), "loadFromDirectories", directories)
	}
	await load(new CustomToolRegistry({ cacheDir }), "loadFromDirectoriesIfStale", [fixtures, overrides])
	const restored = new CustomToolRegistry({ cacheDir })
	await load(restored, "loadFromDirectoriesIfStale", [fixtures])
	restored.clear()
	await load(restored, "loadFromDirectoriesIfStale", [fixtures])
	const mixed = new CustomToolRegistry({ cacheDir })
	await load(mixed, "loadFromDirectoriesIfStale", [fixtures])
	await load(mixed, "loadFromDirectoriesIfStale", [fixtures, overrides])
	console.log(`Native legacy workload passed on ${process.version} (${process.platform})`)
} finally {
	await fs.rm(temporary, { recursive: true, force: true })
}
