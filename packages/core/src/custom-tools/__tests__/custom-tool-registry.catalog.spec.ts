import path from "path"
import * as fs from "fs/promises"
import os from "os"
import { fileURLToPath, pathToFileURL } from "url"

import { execa } from "execa"

import { runEsbuild, NODE_BUILTIN_MODULES, COMMONJS_REQUIRE_BANNER } from "../esbuild-runner.js"

let fixtureRoot: string
let registryBundle: string

beforeAll(async () => {
	fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custom-tool-catalog-tests-"))
	registryBundle = path.join(fixtureRoot, "registry.mjs")
	await runEsbuild({
		entryPoint: fileURLToPath(new URL("../custom-tool-registry.ts", import.meta.url)),
		outfile: registryBundle,
		external: NODE_BUILTIN_MODULES,
		banner: COMMONJS_REQUIRE_BANNER,
	})
}, 60_000)

afterAll(async () => {
	if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true })
})

async function runScenario(body: string, timeout = 50_000) {
	// Vite's dynamic-import transform does not exercise Node's permanent ESM module cache.
	const script = `
		import assert from "node:assert/strict"
		import * as fs from "node:fs/promises"
		import path from "node:path"
		import { CustomToolRegistry } from ${JSON.stringify(pathToFileURL(registryBundle).href)}
		const root = await fs.mkdtemp(${JSON.stringify(path.join(os.tmpdir(), "custom-tool-catalog-"))})
		const registry = new CustomToolRegistry({ cacheDir: path.join(root, "cache") })
		async function writeTool(directory, name, value, file = name + ".js") {
			await fs.mkdir(directory, { recursive: true })
			await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }))
			await fs.writeFile(path.join(directory, file),
				'export default { name: ' + JSON.stringify(name) + ', description: ' + JSON.stringify(value) +
				', execute: async () => ' + JSON.stringify(value) + ' }')
		}
		const catalog = result => result.catalog ?? registry.getAll()
		const names = tools => tools.map(tool => tool.name).sort()
		const invoke = (tools, name) => tools.find(tool => tool.name === name).execute({}, {})
		try { ${body} } finally { await fs.rm(root, { recursive: true, force: true }) }
	`
	await execa(process.execPath, ["--input-type=module", "--eval", script], { timeout })
}

describe("owned custom tool catalogs", () => {
	it("isolates A -> B -> A catalogs and keeps previously captured executables", async () => {
		await runScenario(`
			const a = path.join(root, "a"), b = path.join(root, "b")
			await writeTool(a, "only_a", "workspace A")
			await writeTool(b, "only_b", "workspace B")
			const firstA = catalog(await registry.loadFromDirectoriesIfStale([a]))
			assert.ok(Object.isFrozen(firstA))
			assert.ok(Object.isFrozen(firstA[0]))
			const capturedB = catalog(await registry.loadFromDirectoriesIfStale([b]))
			assert.deepEqual(names(capturedB), ["only_b"], "B must not inherit A's executable")
			const secondA = catalog(await registry.loadFromDirectoriesIfStale([a]))
			assert.deepEqual(names(secondA), ["only_a"])
			assert.equal(await invoke(firstA, "only_a"), "workspace A")
			assert.equal(await invoke(capturedB, "only_b"), "workspace B")
		`)
	}, 60_000)

	it("returns independent snapshots to overlapping directory loads", async () => {
		await runScenario(`
			const a = path.join(root, "a"), b = path.join(root, "b")
			await writeTool(a, "only_a", "workspace A")
			await writeTool(b, "only_b", "workspace B")
			const [resultA, resultB] = await Promise.all([
				registry.loadFromDirectoriesIfStale([a]), registry.loadFromDirectoriesIfStale([b])
			])
			assert.deepEqual(names(catalog(resultA)), ["only_a"])
			assert.deepEqual(names(catalog(resultB)), ["only_b"])
		`)
	}, 60_000)

	it("preserves caller directory precedence across warm catalogs and removes missing overrides", async () => {
		await runScenario(`
			const a = path.join(root, "a"), b = path.join(root, "b")
			await writeTool(a, "shared", "base")
			await writeTool(b, "shared", "override")
			const first = catalog(await registry.loadFromDirectoriesIfStale([a, b]))
			assert.equal(await invoke(first, "shared"), "override")
			const reversed = catalog(await registry.loadFromDirectoriesIfStale([b, a]))
			assert.equal(await invoke(reversed, "shared"), "base", "warm caches must respect requested order")
			await fs.unlink(path.join(b, "shared.js"))
			const refreshed = catalog(await registry.loadFromDirectoriesIfStale([a, b]))
			assert.equal(await invoke(refreshed, "shared"), "base")
			assert.equal(await invoke(first, "shared"), "override")
		`)
	}, 60_000)

	it("detects in-place JavaScript edits with unchanged directory and file timestamps", async () => {
		await runScenario(`
			const directory = path.join(root, "tools")
			await writeTool(directory, "editable", "version one")
			const file = path.join(directory, "editable.js")
			const fileStat = await fs.stat(file), dirStat = await fs.stat(directory)
			const before = catalog(await registry.loadFromDirectoryIfStale(directory))
			await writeTool(directory, "editable", "version two")
			await fs.utimes(file, fileStat.atime, fileStat.mtime)
			await fs.utimes(directory, dirStat.atime, dirStat.mtime)
			const after = catalog(await registry.loadFromDirectoryIfStale(directory))
			assert.equal(await invoke(after, "editable"), "version two")
			assert.equal(await invoke(before, "editable"), "version one")
		`)
	}, 60_000)

	it("refreshes CommonJS JavaScript definitions without retaining the require cache entry", async () => {
		await runScenario(`
			const directory = path.join(root, "tools")
			await fs.mkdir(directory)
			await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "commonjs" }))
			const file = path.join(directory, "commonjs.js")
			await fs.writeFile(file, 'module.exports = { name: "commonjs", description: "first", execute: async () => "first" }')
			const before = catalog(await registry.loadFromDirectory(directory))
			await fs.writeFile(file, 'module.exports = { name: "commonjs", description: "second", execute: async () => "second" }')
			const after = catalog(await registry.loadFromDirectory(directory))
			assert.equal(await invoke(after, "commonjs"), "second")
			assert.equal(await invoke(before, "commonjs"), "first")
		`)
	}, 60_000)

	it("explicitly refreshes JavaScript exports and removes deleted files and directories", async () => {
		await runScenario(`
			const directory = path.join(root, "tools")
			await writeTool(directory, "before_rename", "first", "definition.js")
			await registry.loadFromDirectories([directory])
			await writeTool(directory, "after_rename", "second", "definition.js")
			const renamed = catalog(await registry.loadFromDirectories([directory]))
			assert.deepEqual(names(renamed), ["after_rename"])
			assert.equal(await invoke(renamed, "after_rename"), "second")
			await fs.unlink(path.join(directory, "definition.js"))
			assert.deepEqual(names(catalog(await registry.loadFromDirectories([directory]))), [])
			await writeTool(directory, "last", "last")
			await registry.loadFromDirectoriesIfStale([directory])
			await fs.rm(directory, { recursive: true })
			assert.deepEqual(names(catalog(await registry.loadFromDirectoriesIfStale([directory]))), [])
		`)
	}, 60_000)

	it("reports failed reloads without keeping a stale executable current and retries recovery", async () => {
		await runScenario(`
			const directory = path.join(root, "tools")
			await writeTool(directory, "broken", "last good")
			const before = catalog(await registry.loadFromDirectoryIfStale(directory))
			await fs.writeFile(path.join(directory, "broken.js"), 'throw new Error("reload failed"); export default {}')
			const failed = await registry.loadFromDirectory(directory)
			assert.equal(failed.failed.length, 1, "reload errors must be explicit")
			assert.match(failed.failed[0].error, /reload failed/)
			assert.deepEqual(names(catalog(failed)), [], "failed source must not advertise its last executable as current")
			const repeated = await registry.loadFromDirectoryIfStale(directory)
			assert.equal(repeated.failed.length, 1)
			await writeTool(directory, "broken", "recovered")
			const recovered = catalog(await registry.loadFromDirectoryIfStale(directory))
			assert.equal(await invoke(recovered, "broken"), "recovered")
			assert.equal(await invoke(before, "broken"), "last good")
		`)
	}, 60_000)

	it("preserves JavaScript relative imports and TypeScript top-level await with per-tool env files", async () => {
		await runScenario(`
			const directory = path.join(root, "tools")
			await fs.mkdir(directory)
			await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }))
			await fs.writeFile(path.join(directory, "helper.js"), 'export const value = "relative dependency"')
			await fs.writeFile(path.join(directory, "javascript.js"),
				'import { value } from "./helper.js"; await Promise.resolve(); export default { name: "javascript", description: "native ESM", execute: async () => value }')
			await fs.writeFile(path.join(directory, ".env"), "tool environment")
			await fs.writeFile(path.join(directory, "dependency.json"), JSON.stringify({ value: "first" }))
			await fs.writeFile(path.join(directory, "typescript.ts"),
				'import { readFile } from "node:fs/promises"; import data from "./dependency.json"; const value = await readFile(new URL(".env", import.meta.url), "utf8"); export default { name: "typescript", description: "bundled ESM", execute: async () => value + ":" + data.value }')
			const result = await registry.loadFromDirectory(directory)
			assert.deepEqual(result.failed, [])
			assert.equal(await invoke(catalog(result), "javascript"), "relative dependency")
			assert.equal(await invoke(catalog(result), "typescript"), "tool environment:first")
			await fs.writeFile(path.join(directory, "dependency.json"), JSON.stringify({ value: "second" }))
			const refreshed = await registry.loadFromDirectory(directory)
			assert.deepEqual(refreshed.failed, [])
			assert.equal(await invoke(catalog(refreshed), "typescript"), "tool environment:second")
			assert.equal(await invoke(catalog(result), "typescript"), "tool environment:first")
		`)
	}, 60_000)

	it("bounds native import generations across registry instances and fails explicitly at the ceiling", async () => {
		// Exercise all 256 permanent Node imports, including filesystem refreshes, under the full-suite load.
		// Keep the child deadline inside Vitest's deadline so execa terminates it before fixture cleanup.
		await runScenario(
			`
			const directory = path.join(root, "tools")
			let first
			for (let version = 0; version < 256; version++) {
				await writeTool(directory, "changing", "version " + version)
				const owner = version % 2 ? registry : new CustomToolRegistry()
				const result = await owner.loadFromDirectoryIfStale(directory)
				assert.deepEqual(result.failed, [])
				if (version === 0) first = catalog(result)
			}
			await writeTool(directory, "changing", "one too many")
			const exhausted = await registry.loadFromDirectoryIfStale(directory)
			assert.deepEqual(names(catalog(exhausted)), [])
			assert.match(exhausted.failed[0].error, /reload limit reached.*Reload the extension host/)
			assert.equal(await invoke(first, "changing"), "version 0")
			registry.clear()
			const stillExhausted = await new CustomToolRegistry().loadFromDirectory(directory)
			assert.match(stillExhausted.failed[0].error, /reload limit reached/)
			await writeTool(directory, "changing", "version 0")
			assert.equal(await invoke(catalog(await registry.loadFromDirectoryIfStale(directory)), "changing"), "version 0")
		`,
			110_000,
		)
	}, 120_000)

	it("bounds retained compiled generations and failed builds while retaining unrelated files", async () => {
		await runScenario(`
			const directory = path.join(root, "tools"), cacheRoot = path.join(root, "cache")
			await writeTool(directory, "compiled", "initial", "compiled.ts")
			const initial = await registry.loadFromDirectory(directory)
			assert.deepEqual(initial.failed, [])
			const [namespace] = await fs.readdir(cacheRoot)
			assert.match(namespace, /^host-/)
			const cache = path.join(cacheRoot, namespace)
			for (let index = 0; index < 131; index++) {
				await fs.mkdir(path.join(cache, "tool-" + index.toString(16).padStart(32, "0")))
			}
			await fs.mkdir(path.join(cache, "keep-this-directory"))
			await writeTool(directory, "compiled", "invalid", "compiled.ts")
			await fs.writeFile(path.join(directory, "compiled.ts"), "export default {{{ invalid syntax")
			const failed = await registry.loadFromDirectoryIfStale(directory)
			assert.equal(failed.failed.length, 1)
			assert.equal((await fs.readdir(cache)).filter(name => name.startsWith("tool-")).length, 128,
				"failed builds must also prune cache slots")
			for (let version = 0; version < 3; version++) {
				await writeTool(directory, "compiled", "version " + version, "compiled.ts")
				const result = await registry.loadFromDirectoryIfStale(directory)
				assert.deepEqual(result.failed, [])
				assert.equal(await invoke(catalog(result), "compiled"), "version " + version)
			}
			const entries = await fs.readdir(cache)
			assert.equal(entries.filter(name => name.startsWith("tool-")).length, 128)
			assert.ok(entries.includes("keep-this-directory"))
			const bundles = []
			for (const entry of entries) {
				if ((await fs.readdir(path.join(cache, entry))).includes("bundle.mjs")) bundles.push(entry)
			}
			assert.equal(bundles.length, 4, "live imported generations must retain their resources within the hard bound")
			assert.equal(await invoke(catalog(initial), "compiled"), "initial")
			assert.ok(!(await fs.readdir(cache)).some(name => name.startsWith("stage-")))
		`)
	}, 60_000)

	it.each([".env", ".env.local"])(
		"retains captured %s resources and excludes deleted env files from new generations",
		async (envFile) => {
			await runScenario(`
			const directory = path.join(root, "tools"), envFile = ${JSON.stringify(envFile)}
			await fs.mkdir(directory)
			const source = path.join(directory, "environment.ts")
			const contents = 'import { readFile } from "node:fs/promises"; export default { name: "environment", description: "env reader", execute: async () => readFile(new URL(' + JSON.stringify(envFile) + ', import.meta.url), "utf8") }'
			await fs.writeFile(source, contents)
			await fs.writeFile(path.join(directory, envFile), "first environment")
			const before = await registry.loadFromDirectory(directory)
			assert.deepEqual(before.failed, [])
				if (process.platform !== "win32") {
					const [namespace] = await fs.readdir(path.join(root, "cache"))
					const hostCache = path.join(root, "cache", namespace)
					const [generation] = await fs.readdir(hostCache)
					const generationPath = path.join(hostCache, generation)
					assert.equal((await fs.stat(hostCache)).mode & 0o777, 0o700)
					assert.equal((await fs.stat(generationPath)).mode & 0o777, 0o700)
					assert.equal((await fs.stat(path.join(generationPath, envFile))).mode & 0o777, 0o600)
					assert.equal((await fs.stat(path.join(generationPath, "bundle.mjs"))).mode & 0o777, 0o600)
				}
			await fs.writeFile(path.join(directory, envFile), "second environment")
			const after = await registry.loadFromDirectory(directory)
			assert.deepEqual(after.failed, [])
			assert.equal(await invoke(catalog(after), "environment"), "second environment")
			assert.equal(await invoke(catalog(before), "environment"), "first environment")
			await fs.unlink(path.join(directory, envFile))
			await fs.writeFile(source, contents.replace('export default', 'await readFile(new URL(' + JSON.stringify(envFile) + ', import.meta.url), "utf8"); export default'))
			const removed = await registry.loadFromDirectory(directory)
			assert.equal(removed.failed.length, 1)
			assert.match(removed.failed[0].error, /ENOENT/)
			assert.deepEqual(names(catalog(removed)), [])
			assert.equal(await invoke(catalog(before), "environment"), "first environment")
			assert.equal(await invoke(catalog(after), "environment"), "second environment")
			registry.clearCache()
			assert.equal(await invoke(catalog(before), "environment"), "first environment")
		`)
		},
		60_000,
	)

	it("preserves another live host's namespace while preparing its own cache", async () => {
		await runScenario(`
			const cacheRoot = path.join(root, "cache")
			const other = path.join(cacheRoot, "host-" + process.pid + "-00000000-0000-4000-8000-000000000001")
			const legacy = path.join(cacheRoot, "0000000000000000")
			await fs.mkdir(other, { recursive: true })
			await fs.mkdir(legacy)
			await fs.writeFile(path.join(other, "canary"), "other live host")
			await writeTool(path.join(root, "tools"), "compiled", "loaded", "compiled.ts")
			const result = await registry.loadFromDirectory(path.join(root, "tools"))
			assert.deepEqual(result.failed, [])
			assert.equal(await fs.readFile(path.join(other, "canary"), "utf8"), "other live host")
			await fs.access(legacy)
		`)
	}, 60_000)

	it("reconstructs an unpublished generation after a cache env write fails", async () => {
		await runScenario(`
			const directory = path.join(root, "tools")
			await fs.mkdir(directory)
			await fs.writeFile(path.join(directory, "environment.ts"),
				'import { readFile } from "node:fs/promises"; globalThis.__generationImportCount = (globalThis.__generationImportCount ?? 0) + 1; const config = await Promise.all([".env.first", ".env.second"].map(name => readFile(new URL(name, import.meta.url), "utf8"))); export default { name: "environment", description: "env reader", execute: async () => config.join("|") }')
			await fs.writeFile(path.join(directory, ".env.first"), "first")
			await fs.writeFile(path.join(directory, ".env.second"), "old second")
			const before = await registry.loadFromDirectory(directory)
			assert.deepEqual(before.failed, [])
			assert.equal(await invoke(catalog(before), "environment"), "first|old second")
			await fs.writeFile(path.join(directory, ".env.second"), "new second")
			const nativeFs = (await import("node:fs")).default
			const originalWrite = nativeFs.promises.writeFile
			let injected = false
			nativeFs.promises.writeFile = async (file, ...args) => {
				if (!injected && typeof file === "string" && path.basename(file) === ".env.second" && path.basename(path.dirname(file)).startsWith("tool-")) {
					injected = true
					throw Object.assign(new Error("injected cache env write failure"), { code: "EACCES" })
				}
				return originalWrite(file, ...args)
			}
			try {
				const failed = await registry.loadFromDirectory(directory)
				assert.ok(injected)
				assert.equal(failed.failed.length, 1)
				assert.match(failed.failed[0].error, /injected cache env write failure/)
				assert.deepEqual(names(catalog(failed)), [])
				assert.equal(globalThis.__generationImportCount, 1, "partial generations must not be imported")
			} finally {
				nativeFs.promises.writeFile = originalWrite
			}
			const recovered = await registry.loadFromDirectory(directory)
			assert.deepEqual(recovered.failed, [], "retry must reconstruct all env files before import")
			assert.equal(await invoke(catalog(recovered), "environment"), "first|new second")
			assert.equal(globalThis.__generationImportCount, 2)
			assert.equal(await invoke(catalog(before), "environment"), "first|old second")
		`)
	}, 60_000)

	it("retains generation resources once native module evaluation begins, including on failure", async () => {
		await runScenario(`
			const directory = path.join(root, "tools")
			await fs.mkdir(directory)
			await fs.writeFile(path.join(directory, ".env"), "retained environment")
			await fs.writeFile(path.join(directory, "failed.ts"),
				'import { readFile } from "node:fs/promises"; globalThis.__failedGenerationReader = () => readFile(new URL(".env", import.meta.url), "utf8"); throw new Error("module evaluation failed"); export default {}')
			const result = await registry.loadFromDirectory(directory)
			assert.equal(result.failed.length, 1)
			assert.match(result.failed[0].error, /module evaluation failed/)
			assert.deepEqual(names(catalog(result)), [])
			registry.clearCache()
			assert.equal(await globalThis.__failedGenerationReader(), "retained environment")
		`)
	}, 60_000)

	it("fails at the compiled generation ceiling without evicting captured env resources", async () => {
		// A copy-only esbuild executable isolates retention accounting from transpiler startup cost.
		// Real bundling, ESM and TypeScript behavior are covered by the other native scenarios.
		await runScenario(
			`
			const extension = path.join(root, "fake-extension"), directory = path.join(root, "tools")
			await fs.mkdir(path.join(extension, "dist", "bin"), { recursive: true })
			await fs.writeFile(path.join(extension, "dist", "bin", "esbuild"),
				'require("node:fs").copyFileSync(process.argv[2], process.argv.find(arg => arg.startsWith("--outfile=")).slice(10))')
			await fs.mkdir(directory)
			await fs.writeFile(path.join(directory, "reader.ts"),
				'import { readFile } from "node:fs/promises"; export default { name: "reader", description: "environment", execute: async () => readFile(new URL(".env", import.meta.url), "utf8") }')
			const owner = new CustomToolRegistry({ cacheDir: path.join(root, "cache"), extensionPath: extension })
			let first
			for (let version = 0; version < 128; version++) {
				await fs.writeFile(path.join(directory, ".env"), "version " + version)
				const result = await owner.loadFromDirectory(directory)
				assert.deepEqual(result.failed, [])
				if (version === 0) first = catalog(result)
			}
			await fs.writeFile(path.join(directory, ".env"), "one too many")
			const exhausted = await owner.loadFromDirectory(directory)
			assert.match(exhausted.failed[0].error, /compiled generation limit reached.*Reload the extension host/)
			assert.deepEqual(names(catalog(exhausted)), [])
			assert.equal(await invoke(first, "reader"), "version 0")
		`,
			100_000,
		)
	}, 120_000)
})
