import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { packageVsix } from "./package-vsix.mjs"

function fixture(check) {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "alpha-vsix-package-")))
	try {
		const writePackage = (name, manifest, files = {}) => {
			const directory = path.join(root, "src", "node_modules", name)
			mkdirSync(directory, { recursive: true })
			writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, ...manifest }))
			for (const [file, bytes] of Object.entries(files)) writeFileSync(path.join(directory, file), bytes)
		}
		mkdirSync(path.join(root, "src"))
		writeFileSync(
			path.join(root, "src", "package.json"),
			JSON.stringify({ name: "alpha", version: "1.2.3", publisher: "Alpha" }),
		)
		writePackage("@lancedb/lancedb", {
			optionalDependencies: { "@lancedb/lancedb-win32-x64-msvc": "0.27.2" },
		})
		writePackage(
			"@vscode/vsce",
			{ bin: { vsce: "vsce" } },
			{
				vsce: `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "called.json"))}, JSON.stringify({ args: process.argv.slice(2), target: process.env.ALPHA_VSIX_TARGET, cwd: process.cwd() }))`,
			},
		)
		check({ root, writePackage })
	} finally {
		const resolved = realpathSync(root)
		assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()))
		assert.match(path.basename(resolved), /^alpha-vsix-package-/u)
		rmSync(resolved, { recursive: true, force: true })
	}
}

test("packaging labels the host VSIX and passes the same target to its native bundle", () => {
	fixture(({ root, writePackage }) => {
		writePackage(
			"@lancedb/lancedb-win32-x64-msvc",
			{ main: "lancedb.win32-x64-msvc.node" },
			{ "lancedb.win32-x64-msvc.node": "non-executed fixture binding" },
		)
		const output = packageVsix([], { root, hostTarget: "win32-x64" })
		assert.equal(output, path.join(root, "bin", "alpha-1.2.3-win32-x64.vsix"))
		assert.deepEqual(JSON.parse(readFileSync(path.join(root, "called.json"), "utf8")), {
			args: ["package", "--no-dependencies", "--target", "win32-x64", "--out", output],
			target: "win32-x64",
			cwd: path.join(root, "src"),
		})
	})
})

test("packaging rejects a missing native dependency before running the packager", () => {
	fixture(({ root }) => {
		assert.throws(() => packageVsix([], { root, hostTarget: "win32-x64" }), /Missing LanceDB binding/u)
		assert.throws(() => readFileSync(path.join(root, "called.json")), { code: "ENOENT" })
	})
})

test("Intel macOS packages preserve core extension support without claiming native indexing", () => {
	fixture(({ root }) => {
		assert.equal(
			packageVsix(["--target", "darwin-x64"], { root, hostTarget: "darwin-x64" }),
			path.join(root, "bin", "alpha-1.2.3-darwin-x64.vsix"),
		)
	})
})

test("packaging rejects cross-host targets and ambiguous or unsupported arguments", () => {
	for (const args of [["--target", "linux-x64"], ["--target", "universal"], ["--out", "elsewhere"], ["--target"]])
		assert.throws(
			() => packageVsix(args, { hostTarget: "win32-x64" }),
			/matching host|Unsupported VSIX target|Usage:/u,
		)
})

test("release publication waits for the complete supported desktop target matrix", () => {
	const manifest = JSON.parse(readFileSync(new URL("../src/package.json", import.meta.url), "utf8"))
	assert.equal(manifest.scripts.vsix, "node ../scripts/package-vsix.mjs")
	assert.equal(manifest.scripts["publish:marketplace"], undefined)
	const workflow = readFileSync(new URL("../.github/workflows/release-vsix.yml", import.meta.url), "utf8")
	const packaging = workflow.split("    package-vsix:")[1]?.split("    publish-release:")[0]
	assert.ok(packaging)
	assert.match(packaging, /needs: release-vsix/u)
	const targets = [...packaging.matchAll(/^\s+target: ([a-z0-9-]+)\r?$/gmu)].map((match) => match[1]).sort()
	assert.deepEqual(targets, ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"])
	assert.match(packaging, /os: windows-11-arm\s+target: win32-arm64/u)
	assert.match(packaging, /os: ubuntu-24\.04-arm\s+target: linux-arm64/u)
	assert.match(packaging, /os: macos-15-intel\s+target: darwin-x64\s+native_index: false/u)
	assert.match(packaging, /run: pnpm vsix\s/u)
	assert.ok(packaging.includes('--target "${{ matrix.target }}"'))
	assert.doesNotMatch(packaging, /gh release create/u)
	assert.match(workflow.split("    publish-release:")[1], /needs: package-vsix/u)
})
