import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import vm from "node:vm"

import { packageVsix } from "./package-vsix.mjs"

const { parse } = createRequire(new URL("../packages/evals/package.json", import.meta.url))("yaml")
const releaseSha = "0123456789abcdef0123456789abcdef01234567"
const releasePlatforms = [
	{ os: "windows-latest", target: "win32-x64", native_index: true },
	{ os: "windows-11-arm", target: "win32-arm64", native_index: true },
	{ os: "macos-15", target: "darwin-arm64", native_index: true },
	{ os: "macos-15-intel", target: "darwin-x64", native_index: false },
	{ os: "ubuntu-latest", target: "linux-x64", native_index: true },
	{ os: "ubuntu-24.04-arm", target: "linux-arm64", native_index: true },
]

function runRelease(root, { extraVsix = false, missingTarget, existingRelease = false } = {}) {
	writeFileSync(path.join(root, "src", "package.json"), JSON.stringify({ version: "3.2.10" }))
	writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 3.2.10\n\n- Release fixture.\n")
	mkdirSync(path.join(root, "bin"))
	const verifiedBytes = new Map()
	for (const { target } of releasePlatforms) {
		if (target === missingTarget) continue
		const filename = `alpha-3.2.10-${target}.vsix`
		const bytes = Buffer.from(`verified ${target} package fixture`)
		verifiedBytes.set(filename, bytes)
		writeFileSync(path.join(root, "bin", filename), bytes)
	}
	if (extraVsix) writeFileSync(path.join(root, "bin", "unexpected.vsix"), "unexpected package")
	const workflow = parse(readFileSync(new URL("../.github/workflows/release-vsix.yml", import.meta.url), "utf8"))
	const publication = workflow.jobs["publish-release"].steps.find((step) => step.name === "Create GitHub release")
	const script = `
$ErrorActionPreference = "Stop"
function gh {
	if ($args[0] -eq "release" -and $args[1] -eq "view") {
		$global:LASTEXITCODE = ${existingRelease ? 0 : 1}
		return
	}
	if ($args[0] -ne "release" -or $args[1] -ne "create") { throw "Unexpected GitHub invocation" }
	ConvertTo-Json -InputObject @($args) | Set-Content -LiteralPath release-args.json -Encoding utf8
	$global:LASTEXITCODE = 0
}
${publication.run.replaceAll("${{ github.sha }}", releaseSha)}
`
	const scriptPath = path.join(root, "release.ps1")
	writeFileSync(scriptPath, script)
	const result = spawnSync(
		process.platform === "win32" ? "pwsh.exe" : "pwsh",
		["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath],
		{ cwd: root, encoding: "utf8", timeout: 20_000, windowsHide: true },
	)
	assert.ifError(result.error)
	return { result, verifiedBytes }
}

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

test("the Docker evaluator installs the package produced for its host target", () => {
	const runner = readFileSync(new URL("../packages/evals/Dockerfile.runner", import.meta.url), "utf8")
	const copyCommand = /node -e "([^"\r\n]*copyFileSync[^"\r\n]*)"/u.exec(runner)?.[1]
	assert.ok(copyCommand, "The evaluator must retain a packaged VSIX for its extension runner")
	for (const target of ["linux-x64", "linux-arm64"]) {
		const copies = []
		vm.runInNewContext(copyCommand, {
			require: (name) => {
				if (name === "node:fs") return { copyFileSync: (...args) => copies.push(args) }
				if (name === "./src/package.json") return { name: "alpha", version: "1.2.3" }
				if (name === "./src/lancedb-native.mjs") return { hostVsixTarget: () => target }
				throw new Error(`Unexpected evaluator dependency: ${name}`)
			},
		})
		assert.deepEqual(copies, [[`bin/alpha-1.2.3-${target}.vsix`, "bin/alpha-code.vsix"]])
	}
})

test("release publication waits for all six verified native host packages", () => {
	const manifest = JSON.parse(readFileSync(new URL("../src/package.json", import.meta.url), "utf8"))
	assert.equal(manifest.scripts.vsix, "node ../scripts/package-vsix.mjs")
	assert.equal(manifest.scripts["publish:marketplace"], undefined)
	const workflow = parse(readFileSync(new URL("../.github/workflows/release-vsix.yml", import.meta.url), "utf8"))
	const packaging = workflow.jobs["package-vsix"]
	assert.equal(packaging.needs, "release-vsix")
	assert.equal(packaging["runs-on"], "${{ matrix.os }}")
	assert.deepEqual(packaging.strategy, {
		"fail-fast": false,
		"max-parallel": 3,
		matrix: { include: releasePlatforms },
	})
	assert.ok(packaging.steps.some((step) => step.run === "pnpm vsix"))
	const nativeIndex = packaging.steps.find(
		(step) => step.run === "pnpm --dir src test services/code-index/vector-store/__tests__/lancedb-native.spec.ts",
	)
	assert.equal(nativeIndex.if, "matrix.native_index")
	const verification = packaging.steps.find((step) => step.id === "artifact")
	assert.ok(verification.run.includes("bin/alpha-$version-${{ matrix.target }}.vsix"))
	assert.ok(verification.run.includes('--check-source --target "${{ matrix.target }}"'))
	const upload = packaging.steps.find((step) => step.uses === "actions/upload-artifact@v6")
	assert.equal(upload.with.name, "alpha-vsix-${{ matrix.target }}")
	assert.equal(upload.with.path, "${{ steps.artifact.outputs.path }}")
	assert.equal(upload.with["if-no-files-found"], "error")
	assert.ok(packaging.steps.indexOf(verification) < packaging.steps.indexOf(upload))
	assert.ok(packaging.steps.every((step) => step["continue-on-error"] !== true))
	assert.doesNotMatch(JSON.stringify(packaging), /gh release create/u)
	const publication = workflow.jobs["publish-release"]
	assert.equal(publication.needs, "package-vsix")
	const download = publication.steps.find((step) => step.uses === "actions/download-artifact@v7")
	assert.deepEqual(download.with, { pattern: "alpha-vsix-*", path: "bin", "merge-multiple": true })
})

test("publication preserves every verified platform package and the historical release title", () => {
	fixture(({ root }) => {
		const { result, verifiedBytes } = runRelease(root)
		assert.equal(result.status, 0, result.stderr || String(result.error))
		const args = JSON.parse(readFileSync(path.join(root, "release-args.json"), "utf8").replace(/^\uFEFF/u, ""))
		assert.deepEqual(args.slice(0, 3), ["release", "create", "vsix-v3.2.10-0123456"])
		const assets = args.slice(3, 3 + releasePlatforms.length)
		assert.deepEqual(
			assets.map((asset) => path.basename(asset)),
			[...verifiedBytes.keys()],
		)
		const metadata = args.slice(3 + releasePlatforms.length)
		assert.deepEqual(metadata.slice(0, 3), ["--title", "Alpha VSIX v3.2.10 (0123456)", "--notes"])
		assert.match(metadata[3], /code --install-extension <downloaded-file\.vsix>/u)
		assert.match(metadata[3], /Intel macOS.*Qdrant/u)
		assert.deepEqual(metadata.slice(4), ["--target", releaseSha])
		assert.deepEqual(readdirSync(path.join(root, "bin")).sort(), [...verifiedBytes.keys()].sort())
		for (const asset of assets) assert.deepEqual(readFileSync(asset), verifiedBytes.get(path.basename(asset)))
	})
})

test("publication refuses unexpected extra packages before publishing", () => {
	fixture(({ root }) => {
		const { result, verifiedBytes } = runRelease(root, { extraVsix: true })
		assert.notEqual(result.status, 0)
		assert.match(result.stderr, /Release artifacts differ from the supported platform matrix/u)
		assert.equal(existsSync(path.join(root, "release-args.json")), false)
		assert.deepEqual(
			readdirSync(path.join(root, "bin")).sort(),
			[...verifiedBytes.keys(), "unexpected.vsix"].sort(),
		)
	})
})

for (const { target } of releasePlatforms) {
	test(`publication refuses a release missing its ${target} package`, () => {
		fixture(({ root }) => {
			const { result } = runRelease(root, { missingTarget: target })
			assert.notEqual(result.status, 0)
			assert.match(result.stderr, new RegExp(`alpha-3\\.2\\.10-${target}\\.vsix`, "u"))
			assert.equal(existsSync(path.join(root, "release-args.json")), false)
		})
	})
}

test("publication refuses to overwrite an existing release", () => {
	fixture(({ root }) => {
		const { result, verifiedBytes } = runRelease(root, { existingRelease: true })
		assert.notEqual(result.status, 0)
		assert.match(result.stderr, /already exists; refusing to overwrite/u)
		assert.equal(existsSync(path.join(root, "release-args.json")), false)
		for (const [filename, bytes] of verifiedBytes) {
			assert.deepEqual(readFileSync(path.join(root, "bin", filename)), bytes)
		}
	})
})

test("only release publication receives a repository write token", () => {
	for (const file of ["code-qa.yml", "release-vsix.yml"]) {
		const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")
		assert.match(workflow, /^permissions:\r?\n {4}contents: read$/mu, file)
		if (file !== "release-vsix.yml") assert.doesNotMatch(workflow, /contents: write/u, file)
	}
	const workflow = readFileSync(new URL("../.github/workflows/release-vsix.yml", import.meta.url), "utf8")
	const [validationAndPackaging, publication] = workflow.split("    publish-release:")
	assert.doesNotMatch(validationAndPackaging, /contents: write/u)
	assert.match(publication, /^ {8}permissions:\r?\n {12}contents: write$/mu)
})
