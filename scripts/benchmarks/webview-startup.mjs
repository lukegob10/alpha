import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Run: node scripts/benchmarks/webview-startup.mjs [baseline-ref] [welcome|markdown]
// Compares startup JavaScript reachability, not browser timings. Keep the workspace unchanged during both builds.
// Only the selected source differs; both variants use the current production Vite configuration and other sources.
const root = fileURLToPath(new URL("../..", import.meta.url))
const webviewRoot = path.join(root, "webview-ui")
const require = createRequire(path.join(webviewRoot, "package.json"))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href)
const sourcePaths = {
	welcome: "webview-ui/src/components/welcome/WelcomeViewProvider.tsx",
	markdown: "webview-ui/src/components/common/MarkdownBlock.tsx",
}
const sourceName = process.argv[3] ?? "welcome"
assert.ok(Object.hasOwn(sourcePaths, sourceName), "Source must be welcome or markdown")
const sourcePath = sourcePaths[sourceName]
const target = path.join(root, sourcePath).replaceAll("\\", "/")
const baselineRef = process.argv[2] ?? "e3595d3da3966f8e137a1424f79880d9862c14ae"
const baselineCommit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`], {
	cwd: root,
	encoding: "utf8",
	windowsHide: true,
}).trim()
assert.match(baselineCommit, /^[a-f0-9]{40,64}$/)
const sources = {
	baseline: execFileSync("git", ["show", `${baselineCommit}:${sourcePath}`], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
	}),
	current: readFileSync(target, "utf8"),
}

function collectStaticChunks(entry, chunks) {
	const collected = new Map()
	const visit = (chunk) => {
		if (collected.has(chunk.fileName)) return
		collected.set(chunk.fileName, chunk)
		for (const name of chunk.imports) {
			const dependency = chunks.get(name)
			if (dependency) visit(dependency)
		}
	}
	visit(entry)
	return collected
}

process.chdir(webviewRoot)
const variants = []
for (const [name, source] of Object.entries(sources)) {
	const warnings = []
	const loaded = await loadConfigFromFile(
		{ command: "build", mode: "production" },
		path.join(webviewRoot, "vite.config.ts"),
		webviewRoot,
		"silent",
	)
	assert.ok(loaded, "Vite configuration did not load")
	const { config } = loaded
	const result = await build({
		...config,
		configFile: false,
		root: webviewRoot,
		logLevel: "silent",
		cacheDir: path.join(tmpdir(), "alpha-webview-startup-benchmark"),
		plugins: [
			{
				name: "startup-source-measurement",
				enforce: "pre",
				transform(_code, id) {
					if (id.replaceAll("\\", "/").split("?")[0] === target) return { code: source, map: null }
				},
			},
			// This plugin writes files in closeBundle even when Rollup's write option is false.
			...config.plugins.filter((plugin) => plugin?.name !== "vite-plugin-sourcemap"),
		],
		build: {
			...config.build,
			write: false,
			sourcemap: false,
			rollupOptions: {
				...config.build.rollupOptions,
				onwarn(warning, defaultHandler) {
					warnings.push({ code: warning.code, message: warning.message })
					if (config.build.rollupOptions.onwarn) config.build.rollupOptions.onwarn(warning, defaultHandler)
					else defaultHandler(warning)
				},
			},
		},
	})
	const output = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output
	const chunks = new Map(output.filter((item) => item.type === "chunk").map((chunk) => [chunk.fileName, chunk]))
	const entry = [...chunks.values()].find((chunk) => chunk.isEntry && chunk.name === "index")
	assert.ok(entry, "Main entry chunk missing")
	const startup = collectStaticChunks(entry, chunks)
	const modules = [...startup.values()].flatMap((chunk) =>
		Object.keys(chunk.modules).map((id) => id.replaceAll("\\", "/")),
	)
	const apiOptionsStartup = modules.some((id) => id.endsWith("/components/settings/ApiOptions.tsx"))
	const mermaidStartup = modules.some((id) => id.includes("/node_modules/mermaid/"))
	const mermaidChunks = [...chunks.values()].filter((chunk) =>
		Object.keys(chunk.modules).some((id) => id.replaceAll("\\", "/").includes("/node_modules/mermaid/")),
	)
	const lazyDiagramChunk = [...chunks.values()].find((chunk) =>
		Object.keys(chunk.modules).some((id) =>
			id.replaceAll("\\", "/").endsWith("/components/common/MermaidBlock.tsx"),
		),
	)
	const diagramDynamicImport = lazyDiagramChunk
		? [...startup.values()]
				.flatMap((chunk) => chunk.dynamicImports)
				.find((file) => {
					const importedChunk = chunks.get(file)
					return importedChunk && collectStaticChunks(importedChunk, chunks).has(lazyDiagramChunk.fileName)
				})
		: undefined
	const outputCycleWarnings = warnings.filter(
		(warning) => warning.code === "CIRCULAR_CHUNK" || warning.code === "CYCLIC_CROSS_CHUNK_REEXPORT",
	)
	const warningCounts = warnings.reduce((counts, warning) => {
		counts[warning.code] = (counts[warning.code] ?? 0) + 1
		return counts
	}, {})
	const variant = {
		name,
		startupJsBytes: [...startup.values()].reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0),
		startupChunkCount: startup.size,
		startupModuleCount: new Set(modules).size,
		startupChunks: [...startup.values()].map((chunk) => ({
			file: chunk.fileName,
			bytes: Buffer.byteLength(chunk.code),
		})),
		apiOptionsStartup,
		mermaidStartup,
		mermaidChunkCount: mermaidChunks.length,
		lazyDiagramChunk: lazyDiagramChunk?.fileName,
		diagramDynamicImport,
		warningCounts,
		warnings,
		settingsModules: modules
			.filter((id) => id.includes("/components/settings/"))
			.map((id) => path.relative(root, id).replaceAll("\\", "/"))
			.sort(),
	}
	variants.push(variant)
	// Keep small graph diagnostics available even when a later assertion fails; stdout remains one JSON result.
	console.error(
		JSON.stringify({
			name,
			startupJsBytes: variant.startupJsBytes,
			startupModuleCount: variant.startupModuleCount,
			startupChunks: variant.startupChunks,
			apiOptionsStartup,
			mermaidStartup,
			lazyDiagramChunk: variant.lazyDiagramChunk,
			diagramDynamicImport,
			warningCounts,
			outputCycleWarnings,
		}),
	)
	if (name === "current") {
		assert.equal(apiOptionsStartup, false, "Provider settings must remain outside the startup graph")
		assert.equal(mermaidStartup, false, "The diagram engine must remain outside the startup graph")
		assert.ok(mermaidChunks.length > 0, "The diagram engine must be emitted")
		assert.ok(lazyDiagramChunk, "The diagram renderer must be emitted")
		assert.ok(!startup.has(lazyDiagramChunk.fileName), "The diagram renderer must load on demand")
		assert.ok(diagramDynamicImport, "Startup must retain a dynamic import path to the diagram renderer")
		assert.ok(
			mermaidChunks.some((chunk) => collectStaticChunks(lazyDiagramChunk, chunks).has(chunk.fileName)),
			"The lazy diagram renderer must retain its engine dependency",
		)
		assert.deepEqual(outputCycleWarnings, [], "Chunking must not introduce circular chunks or cyclic reexports")
	}
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, baselineCommit, sourcePath, variants }))
