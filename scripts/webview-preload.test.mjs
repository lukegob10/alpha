import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const require = createRequire(new URL("../webview-ui/package.json", import.meta.url))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href)

test("built lazy module preloads use the extension resource URI instead of the webview origin", async () => {
	const { config } = await loadConfigFromFile(
		{ command: "build", mode: "production" },
		fileURLToPath(new URL("../webview-ui/vite.config.ts", import.meta.url)),
	)
	const modules = {
		"virtual:entry": 'export function loadFeature() { return import("virtual:feature") }',
		"virtual:feature": 'import { value } from "virtual:shared"; export const feature = value',
		"virtual:shared": 'export const value = "ready"',
	}
	const result = await build({
		configFile: false,
		base: config.base,
		logLevel: "silent",
		plugins: [
			{ name: "preload-fixture", resolveId: (id) => (id in modules ? id : null), load: (id) => modules[id] },
		],
		build: {
			write: false,
			minify: false,
			modulePreload: { polyfill: false },
			rollupOptions: {
				input: "virtual:entry",
				preserveEntrySignatures: "strict",
				output: { manualChunks: { shared: ["virtual:shared"] } },
			},
		},
	})
	assert.ok(!Array.isArray(result) && "output" in result)
	const entry = result.output.find((item) => item.type === "chunk" && item.isEntry)
	assert.ok(entry)
	const resourceRoot = "https://file+.vscode-resource.vscode-cdn.net/c%3A/extensions/alpha/webview-ui/build/"
	const entryUrl = new URL(entry.fileName, resourceRoot).href
	const requests = []
	const document = {
		getElementsByTagName: () => [],
		querySelector: () => null,
		createElement: () => ({}),
		head: { appendChild: (link) => requests.push(new URL(link.href, "vscode-webview://alpha/fake.html").href) },
	}
	// Execute Vite's emitted preload code; substitute only the dynamic import so
	// the test can observe resource requests without a browser or network server.
	const code = entry.code
		.replaceAll("import.meta.url", JSON.stringify(entryUrl))
		.replace(/import\("[^"]+"\)/gu, "Promise.resolve({})")
		.replace(/export\s*\{[^}]*\};?/gu, "")
	await new Function("document", `${code}\nreturn loadFeature()`)(document)
	assert.ok(requests.length >= 2, "the fixture must preload the lazy module and its shared dependency")
	for (const request of requests) {
		assert.ok(request.startsWith(resourceRoot), `preload escaped the extension resource root: ${request}`)
	}
})
