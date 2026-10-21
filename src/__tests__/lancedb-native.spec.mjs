import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import * as esbuild from "esbuild"

import { hostVsixTarget, lanceDbBindingForTarget, resolveLanceDbNativeDependencies } from "../lancedb-native.mjs"

const platformNames = [
	"darwin-arm64",
	"linux-x64-gnu",
	"linux-arm64-gnu",
	"linux-x64-musl",
	"linux-arm64-musl",
	"win32-x64-msvc",
	"win32-arm64-msvc",
]
// Synthetic identities prevent Vitest's dependency fallback from finding the developer's real native packages.
const packageName = (platform) => `@lancedb/lancedb-fixture-${platform}`
const nativePackages = platformNames.map(packageName)
const roots = []

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(installed = platformNames, hideManifests = false) {
	// Node's package resolver canonicalizes symlinked temp parents, including macOS /var -> /private/var.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-native-packaging-")))
	roots.push(root)
	const writePackage = (name, manifest, files) => {
		const directory = path.join(root, "node_modules", name)
		fs.mkdirSync(directory, { recursive: true })
		fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, ...manifest }))
		for (const [filename, contents] of Object.entries(files))
			fs.writeFileSync(path.join(directory, filename), contents)
		return directory
	}
	const entry = nativePackages
		.map(
			(name) =>
				`try { require(${JSON.stringify(name)}); require(${JSON.stringify(`${name}/package.json`)}) } catch {}`,
		)
		.join("\n")
	writePackage(
		"@lancedb/lancedb",
		{
			main: "index.js",
			...(hideManifests ? { exports: { ".": "./index.js" } } : {}),
			optionalDependencies: Object.fromEntries(
				[...nativePackages, "unrelated-js"].map((name) => [name, "1.0.0"]),
			),
		},
		{ "index.js": `${entry}\nmodule.exports = require("unrelated-js")` },
	)
	writePackage("unrelated-js", { main: "index.js" }, { "index.js": "module.exports = 'ordinary-js-stays-bundled'" })
	for (const name of installed) {
		const main = `lancedb.${name}.node`
		writePackage(
			packageName(name),
			{
				main,
				...(hideManifests ? { exports: { ".": `./${main}` } } : {}),
			},
			{ [main]: `synthetic non-executed binary for ${name}` },
		)
	}
	return { root, require: createRequire(path.join(root, "fixture.cjs")) }
}

describe("LanceDB extension native packaging inventory", () => {
	it.each([
		["win32-x64", "win32-x64-msvc"],
		["win32-arm64", "win32-arm64-msvc"],
		["darwin-arm64", "darwin-arm64"],
		["linux-x64", "linux-x64-gnu"],
		["linux-arm64", "linux-arm64-gnu"],
		["alpine-x64", "linux-x64-musl"],
		["alpine-arm64", "linux-arm64-musl"],
	])("requires the matching native binding for %s", (target, nativePlatform) => {
		const item = fixture()
		expect(
			resolveLanceDbNativeDependencies(item.require, target).bindings.map((file) => path.basename(file)),
		).toEqual([`lancedb.${nativePlatform}.node`])
		expect(() => resolveLanceDbNativeDependencies(fixture([]).require, target)).toThrow(
			`Missing LanceDB binding lancedb.${nativePlatform}.node for VSIX target ${target}`,
		)
	})

	it("keeps Intel macOS core-only and rejects unsupported platform claims", () => {
		expect(lanceDbBindingForTarget("darwin-x64")).toBeNull()
		expect(resolveLanceDbNativeDependencies(fixture().require, "darwin-x64").bindings).toEqual([])
		for (const target of ["universal", "web", "linux-armhf", "__proto__", undefined])
			expect(() => lanceDbBindingForTarget(target)).toThrow("Unsupported VSIX target")
	})

	it.each([
		["win32", "arm64", undefined, "win32-arm64"],
		["darwin", "x64", undefined, "darwin-x64"],
		["linux", "x64", "gnu", "linux-x64"],
		["linux", "arm64", "musl", "alpine-arm64"],
	])("maps the host %s/%s/%s to %s", (platform, arch, libc, target) => {
		expect(hostVsixTarget({ platform, arch, libc })).toBe(target)
	})

	it("rejects unknown host architectures and Linux libc", () => {
		expect(() => hostVsixTarget({ platform: "win32", arch: "ia32" })).toThrow("Unsupported VSIX target")
		expect(() => hostVsixTarget({ platform: "linux", arch: "x64", libc: "unknown" })).toThrow(
			"Unsupported Linux libc",
		)
	})

	it("keeps the bundled CommonJS backend lazy when its native dependency cannot load", async () => {
		const item = fixture([])
		const backendEntry = item.require.resolve("@lancedb/lancedb")
		fs.writeFileSync(backendEntry, `module.exports = require(${JSON.stringify(nativePackages[0])})`)
		const result = await esbuild.build({
			entryPoints: [path.resolve(import.meta.dirname, "../services/code-index/vector-store/lancedb-client.ts")],
			bundle: true,
			format: "cjs",
			platform: "node",
			write: false,
			logLevel: "silent",
			alias: { "@lancedb/lancedb": backendEntry },
			external: nativePackages,
			plugins: [
				{
					name: "fixture-localization",
					setup(build) {
						build.onResolve({ filter: /\/i18n$/ }, () => ({ path: "fixture-i18n", namespace: "fixture" }))
						build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
							contents: "export const t = (_key, params) => Object.values(params).join(': ')",
						}))
					},
				},
			],
		})
		const module = { exports: {} }
		const packageRequire = createRequire(import.meta.url)
		let nativeLoads = 0
		let directoryWrites = 0
		runInNewContext(result.outputFiles[0].text, {
			module,
			exports: module.exports,
			process: { platform: "darwin", arch: "x64" },
			console: { error() {} },
			require(name) {
				if (nativePackages.includes(name)) {
					nativeLoads++
					throw new Error("Cannot find native binding")
				}
				if (name === "fs/promises") return { mkdir: async () => directoryWrites++ }
				return packageRequire(name)
			},
		})
		const store = new module.exports.LanceDbVectorStore(path.resolve("workspace"), undefined, 3)
		expect(nativeLoads).toBe(0)
		await expect(store.initialize()).rejects.toThrow(/darwin-x64.*Cannot find native binding/)
		await expect(store.initialize()).rejects.toThrow(/darwin-x64.*Cannot find native binding/)
		expect(nativeLoads).toBe(1)
		expect(directoryWrites).toBe(0)
	})

	it("keeps all declared native imports external but copies only the installed subset", () => {
		for (const installed of [[], ["win32-x64-msvc"], ["darwin-arm64", "linux-arm64-musl"]]) {
			const item = fixture(installed)
			const result = resolveLanceDbNativeDependencies(item.require)
			for (const file of result.bindings) expect(file.startsWith(item.root), file).toBe(true)
			expect(result.packages).toEqual([...nativePackages].sort())
			expect(result.bindings.map((file) => path.basename(file)).sort()).toEqual(
				installed.map((name) => `lancedb.${name}.node`).sort(),
			)
		}
	})

	it("maps every declared installed main to its flat native filename, including ARM64", () => {
		const item = fixture()
		const result = resolveLanceDbNativeDependencies(item.require)
		expect(result.bindings).toHaveLength(nativePackages.length)
		for (const file of result.bindings) {
			const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "package.json"), "utf8"))
			expect(path.basename(file)).toBe(manifest.main)
			expect(fs.readFileSync(file, "utf8")).toContain("synthetic non-executed binary")
		}
	})

	it("resolves package metadata even when package.json is hidden by exports", () => {
		const item = fixture(platformNames, true)
		expect(() => item.require.resolve("@lancedb/lancedb/package.json")).toThrow()
		const result = resolveLanceDbNativeDependencies(item.require)
		expect(result.packages).toHaveLength(7)
		expect(result.bindings).toHaveLength(7)
	})

	it("reproduces all-architecture native loader errors with the old inventory and bundles with the shared inventory", async () => {
		const item = fixture()
		const options = {
			entryPoints: [item.require.resolve("@lancedb/lancedb")],
			bundle: true,
			platform: "node",
			format: "cjs",
			write: false,
			logLevel: "silent",
			metafile: true,
		}
		const oldPackages = ["win32-x64-msvc", "linux-x64-gnu", "linux-x64-musl"].map(packageName)
		let failure
		try {
			await esbuild.build({ ...options, external: oldPackages })
		} catch (error) {
			failure = error
		}
		expect(failure?.errors).toHaveLength(4)
		expect(failure.errors.every((error) => error.text.includes('No loader is configured for ".node"'))).toBe(true)
		const inventory = resolveLanceDbNativeDependencies(item.require)
		const result = await esbuild.build({ ...options, external: inventory.packages })
		expect(Object.keys(result.metafile.inputs).some((file) => file.endsWith(".node"))).toBe(false)
		expect(result.outputFiles[0].text).toContain("ordinary-js-stays-bundled")
		const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
		for (const name of nativePackages) {
			expect(imports).toContainEqual(expect.objectContaining({ path: name, external: true }))
			expect(imports).toContainEqual(expect.objectContaining({ path: `${name}/package.json`, external: true }))
		}
	})

	it("rejects collisions instead of overwriting one platform's binary", () => {
		const item = fixture(["win32-x64-msvc", "win32-arm64-msvc"])
		const directory = path.dirname(item.require.resolve(`${packageName("win32-arm64-msvc")}/package.json`))
		const manifestPath = path.join(directory, "package.json")
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
		manifest.main = "lancedb.win32-x64-msvc.node"
		fs.writeFileSync(manifestPath, JSON.stringify(manifest))
		fs.writeFileSync(path.join(directory, manifest.main), "conflicting binary")
		expect(() => resolveLanceDbNativeDependencies(item.require)).toThrow("Conflicting LanceDB native destination")
	})

	it.each(["../outside.node", "index.js", "nested/lancedb.win32-x64-msvc.node", null])(
		"rejects invalid native main %s",
		(main) => {
			const item = fixture(["win32-x64-msvc"])
			const manifestPath = item.require.resolve(`${packageName("win32-x64-msvc")}/package.json`)
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, main }))
			expect(() => resolveLanceDbNativeDependencies(item.require)).toThrow("Invalid LanceDB native entry point")
		},
	)

	it("does not swallow missing binaries or malformed metadata in installed packages", () => {
		for (const defect of ["missing-binary", "malformed-manifest"]) {
			const item = fixture(["win32-x64-msvc"])
			const manifestPath = item.require.resolve(`${packageName("win32-x64-msvc")}/package.json`)
			if (defect === "missing-binary")
				fs.unlinkSync(path.join(path.dirname(manifestPath), "lancedb.win32-x64-msvc.node"))
			else fs.writeFileSync(manifestPath, "{")
			expect(() => resolveLanceDbNativeDependencies(item.require)).toThrow()
		}
	})
})
