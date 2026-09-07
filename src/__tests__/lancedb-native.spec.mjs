import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import * as esbuild from "esbuild"

import { resolveLanceDbNativeDependencies } from "../lancedb-native.mjs"

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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-native-packaging-"))
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
