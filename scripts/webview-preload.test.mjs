import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const require = createRequire(new URL("../webview-ui/package.json", import.meta.url))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href)

test("webview build cache tracks the release version and shared package metadata", { timeout: 45_000 }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha-webview-version-test-"))
	const execute = promisify(execFile)
	const writeJson = (file, value) => writeFile(path.join(root, file), JSON.stringify(value) + "\n")
	try {
		await mkdir(path.join(root, "webview-ui", "src"), { recursive: true })
		await mkdir(path.join(root, "src", "shared"), { recursive: true })
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
		await writeJson("package.json", {
			name: "webview-version-fixture",
			private: true,
			packageManager: manifest.packageManager,
		})
		await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - src\n  - webview-ui\n")
		await writeFile(
			path.join(root, "pnpm-lock.yaml"),
			"lockfileVersion: '9.0'\nimporters:\n  .: {}\n  src: {}\n  webview-ui: {}\n",
		)
		await writeFile(path.join(root, "turbo.json"), await readFile(new URL("../turbo.json", import.meta.url)))
		await writeFile(
			path.join(root, "webview-ui", "turbo.json"),
			await readFile(new URL("../webview-ui/turbo.json", import.meta.url)),
		)
		await writeJson("webview-ui/package.json", {
			name: "@alpha-code/vscode-webview",
			scripts: { build: "node build.mjs" },
		})
		await writeJson("src/package.json", { name: "alpha", version: "3.1.3" })
		await writeFile(path.join(root, "src", "shared", "package.ts"), 'export const channel = "Alpha"\n')
		await writeFile(path.join(root, "webview-ui", "src", "index.ts"), 'export const view = "settings"\n')
		await execute("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true })
		await execute("git", ["add", "."], { cwd: root, windowsHide: true })
		const hash = async () => {
			const { stdout } = await execute(
				process.execPath,
				[
					require.resolve("turbo/bin/turbo"),
					"run",
					"build",
					"--filter=@alpha-code/vscode-webview",
					"--dry=json",
				],
				{ cwd: root, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
			)
			const task = JSON.parse(stdout).tasks.find((item) => item.taskId === "@alpha-code/vscode-webview#build")
			assert.ok(task?.hash, "the actual Turbo runner must provide a webview cache key")
			return task.hash
		}
		const initial = await hash()
		await writeJson("src/package.json", { name: "alpha", version: "3.1.4" })
		const versioned = await hash()
		assert.notEqual(versioned, initial, "a release version bump must invalidate a cached UI version")
		await writeFile(path.join(root, "src", "shared", "package.ts"), 'export const channel = "Updated Alpha"\n')
		assert.notEqual(await hash(), versioned, "changes to shared package metadata must invalidate the webview")
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

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
