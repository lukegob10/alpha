import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import test from "node:test"
import * as esbuild from "esbuild"

import {
	captureExtensionBuildSource,
	completeExtensionBuildProvenance,
	createExtensionBuildInputCapture,
	extensionBuildProvenancePath,
	verifyExtensionBuildProvenance,
} from "./extension-build-provenance.mjs"

const build = {
	nodeVersion: process.version,
	platform: process.platform,
	arch: process.arch,
	esbuildVersion: "fixture",
	production: false,
	vsixTarget: null,
}

async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha-build-provenance-"))
	t.after(async () => {
		assert.equal(path.dirname(root), os.tmpdir())
		assert.match(path.basename(root), /^alpha-build-provenance-/u)
		await rm(root, { recursive: true, force: true })
	})
	const write = async (file, content = "fixture") => {
		const target = path.join(root, ...file.split("/"))
		await mkdir(path.dirname(target), { recursive: true })
		await writeFile(target, content)
	}
	for (const file of [
		"src/extension.ts",
		"src/workers/worker.ts",
		"src/esbuild.mjs",
		"src/dist/extension.js",
		"src/dist/workers/worker.js",
		"src/assets/skills/debug/SKILL.md",
		"src/integrations/theme/default-themes/dark.json",
		"src/webview-ui/build/assets/index.js",
		"src/webview-ui/audio/done.wav",
		"src/package.nls.json",
		"src/README.md",
		"src/CHANGELOG.md",
		"src/LICENSE",
		"packages/core/src/index.ts",
		"packages/ipc/src/index.ts",
		"packages/types/src/index.ts",
		"packages/core/package.json",
		"packages/ipc/package.json",
		"packages/types/package.json",
		"packages/build/package.json",
		"packages/types/dist/index.js",
		"packages/build/src/index.ts",
		"packages/build/dist/index.js",
		"webview-ui/src/index.tsx",
		"webview-ui/public/viewer.js",
		"webview-ui/audio/done.wav",
		"webview-ui/package.json",
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"turbo.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		"scripts/extension-build-provenance.mjs",
	])
		await write(file, file.endsWith(".json") ? "{}" : "fixture")
	await write("src/package.json", JSON.stringify({ name: "alpha", version: "1.0.0", main: "dist/extension.js" }))
	for (const name of ["esbuild", "global-agent", "helper"]) {
		await write(
			`src/node_modules/${name}/package.json`,
			JSON.stringify({
				name,
				version: "1.0.0",
				main: "index.js",
				...(name === "global-agent"
					? { dependencies: { helper: "1.0.0" }, optionalDependencies: { "optional-platform": "1.0.0" } }
					: {}),
			}),
		)
		await write(`src/node_modules/${name}/index.js`, `module.exports = ${JSON.stringify(name)}\n`)
	}
	await write(
		"src/node_modules/bundled-only/package.json",
		JSON.stringify({ name: "bundled-only", version: "1.0.0", main: "index.js" }),
	)
	await write("src/node_modules/bundled-only/index.js", "module.exports = 'compiler input'\n")
	execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true })
	execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=empty-hooks",
			"-c",
			"user.name=Build Fixture",
			"-c",
			"user.email=build-fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"--quiet",
			"-m",
			"fixture",
		],
		{ cwd: root, windowsHide: true },
	)
	return { root, extensionPath: path.join(root, "src"), write }
}

async function compilerInputs(f) {
	const observer = createExtensionBuildInputCapture(f.root)
	let load
	observer.plugin.setup({
		onLoad(_options, callback) {
			load = callback
		},
	})
	for (const file of ["extension.ts", "workers/worker.ts", "node_modules/bundled-only/index.js"])
		await load({ path: path.join(f.extensionPath, ...file.split("/")) })
	return observer.finish([
		{
			metafile: {
				inputs: { "extension.ts": {}, "node_modules/bundled-only/index.js": {} },
				outputs: { "dist/extension.js": {} },
			},
		},
		{ metafile: { inputs: { "workers/worker.ts": {} }, outputs: { "dist/workers/worker.js": {} } } },
	])
}

async function complete(f, before) {
	return completeExtensionBuildProvenance({
		repositoryRoot: f.root,
		before,
		compilerInputs: await compilerInputs(f),
		build,
	})
}

async function built(t) {
	const f = await fixture(t)
	const before = await captureExtensionBuildSource(f.root)
	const manifest = await complete(f, before)
	return { ...f, before, manifest }
}

test("completed build binds actual source, packaged assets, workers, metadata and transitive external bytes", async (t) => {
	const f = await built(t)
	const result = await verifyExtensionBuildProvenance({
		extensionPath: f.extensionPath,
		expectedEntrypointSha256: f.manifest.artifacts.entrypointSha256,
		expectedPackageJsonSha256: f.manifest.artifacts.packageJsonSha256,
	})
	assert.equal(result.status, "verified")
	assert.equal(result.provenance, "build-owned-content-association")
	assert.equal(result.sourceAssociation.kind, "controlled-build-boundary-observation")
	assert.equal(result.sourceAssociation.resolverMetadataBytes, "unobserved")
	assert.equal(result.sourceAssociation.immutableFilesystem, false)
	assert.equal(result.sourceAssociation.authentication, "none")
	assert.equal(result.sourceRevision, f.before.revision)
	assert.equal(result.sourceTreeDigest, f.manifest.source.digest)
	assert.equal(f.manifest.source.snapshotDigest, f.before.digest)
	assert(
		f.manifest.compilerInputs.files.some((row) => row.path === "src/node_modules/bundled-only/index.js"),
		JSON.stringify(f.manifest.compilerInputs.files),
	)
	assert.equal(result.manifestDigest, f.manifest.digest)
	assert(f.manifest.artifacts.files.some((row) => row.path === "assets/skills/debug/SKILL.md"))
	assert(f.manifest.artifacts.files.some((row) => row.path === "dist/workers/worker.js"))
	assert.equal(f.manifest.runtimeDependencies.packages.length, 3)
	assert.deepEqual(f.manifest.runtimeDependencies.missing, [])
})

test("changed source or compiled workspace input cannot be stamped onto the resulting bundle", async (t) => {
	for (const file of [
		"src/extension.ts",
		"packages/types/dist/index.js",
		"packages/core/package.json",
		"src/assets/skills/debug/SKILL.md",
	]) {
		const f = await fixture(t)
		const before = await captureExtensionBuildSource(f.root)
		await f.write(file, "changed during build")
		await assert.rejects(complete(f, before), /changed during the build/u)
		assert.equal((await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })).status, "unavailable")
	}
})

test("source snapshots exclude outputs, tests and environment files but retain actual runtime sources", async (t) => {
	const f = await fixture(t)
	await f.write("src/.env", "must not be retained")
	await f.write("src/__tests__/extension.spec.ts", "test source")
	const before = await captureExtensionBuildSource(f.root)
	assert(
		!before.files.some(
			(row) => row.path.includes(".env") || row.path.includes("__tests__") || row.path.startsWith("src/dist/"),
		),
	)
	assert(before.files.some((row) => row.path === "src/extension.ts"))
	assert(before.files.some((row) => row.path === "packages/types/dist/index.js"))
	await f.write("src/dist/extension.js", "new build output")
	await f.write("src/__tests__/extension.spec.ts", "test changed while building")
	await complete(f, before)
	assert.equal((await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })).status, "verified")
})

test("changed entrypoint, metadata, skill, worker and added runtime files invalidate an existing receipt", async (t) => {
	for (const file of [
		"src/dist/extension.js",
		"src/package.json",
		"src/assets/skills/debug/SKILL.md",
		"src/dist/workers/worker.js",
		"src/dist/unrecorded.js",
	]) {
		const f = await built(t)
		await f.write(file, "artifact changed after build")
		assert.equal((await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })).status, "invalid", file)
	}
})

test("external dependency changes are detected both during build and when verifying observed artifacts", async (t) => {
	const f = await fixture(t)
	const before = await captureExtensionBuildSource(f.root)
	await f.write("src/node_modules/helper/index.js", "changed dependency")
	await assert.rejects(complete(f, before), /changed during the build/u)
	const current = await captureExtensionBuildSource(f.root)
	await complete(f, current)
	await f.write("src/node_modules/helper/index.js", "changed again")
	assert.equal((await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })).status, "invalid")
})

test("missing external runtime closure stays unavailable and does not fabricate complete identity", async (t) => {
	const f = await fixture(t)
	const target = path.resolve(f.root, "src/node_modules/helper")
	assert(target.startsWith(f.root + path.sep))
	await rm(target, { recursive: true, force: true })
	const before = await captureExtensionBuildSource(f.root)
	assert(before.runtimeDependencies.missing.length > 0)
	await complete(f, before)
	const result = await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })
	assert.equal(result.status, "unavailable")
	assert.deepEqual(result.missing, ["runtime-dependency-closure"])
})

test("manifest corruption, observed identity mismatch and a second write cannot replace build provenance", async (t) => {
	const f = await built(t)
	assert.equal(
		(
			await verifyExtensionBuildProvenance({
				extensionPath: f.extensionPath,
				expectedEntrypointSha256: "f".repeat(64),
			})
		).status,
		"invalid",
	)
	await assert.rejects(complete(f, f.before), /EEXIST/u)
	const bytes = await readFile(path.join(f.extensionPath, extensionBuildProvenancePath), "utf8")
	const altered = JSON.parse(bytes)
	altered.source.revision = "0".repeat(40)
	await f.write("src/" + extensionBuildProvenancePath, JSON.stringify(altered))
	assert.equal((await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })).status, "invalid")
})

test("uncaptured metafile inputs and changed bundled third-party sources cannot establish a complete build", async (t) => {
	const f = await fixture(t)
	const observer = createExtensionBuildInputCapture(f.root)
	let load
	observer.plugin.setup({
		onLoad(_options, callback) {
			load = callback
		},
	})
	await load({ path: path.join(f.extensionPath, "extension.ts") })
	const metadata = [
		{ metafile: { inputs: { "extension.ts": {} }, outputs: { "dist/extension.js": {} } } },
		{ metafile: { inputs: { "workers/worker.ts": {} }, outputs: { "dist/workers/worker.js": {} } } },
	]
	await assert.rejects(observer.finish(metadata), /not captured before loading/u)
	await load({ path: path.join(f.extensionPath, "workers/worker.ts") })
	await load({ path: path.join(f.extensionPath, "node_modules", "bundled-only", "index.js") })
	await f.write("src/node_modules/bundled-only/index.js", "changed compiler source after load")
	await assert.rejects(observer.finish(metadata), /changed during build/u)
})

test("real extension and worker esbuild invocations emit verifiable input provenance", async (t) => {
	const f = await fixture(t)
	await f.write("src/extension.ts", "import { helper } from 'bundled-only'; export const value = helper\n")
	await f.write("src/workers/worker.ts", "export const worker = 1\n")
	await f.write("src/node_modules/bundled-only/index.js", "exports.helper = 1\n")
	const before = await captureExtensionBuildSource(f.root)
	const observer = createExtensionBuildInputCapture(f.root)
	const options = {
		absWorkingDir: f.extensionPath,
		bundle: true,
		format: "cjs",
		platform: "node",
		metafile: true,
		plugins: [observer.plugin],
		logLevel: "silent",
	}
	const results = await Promise.all([
		esbuild.build({ ...options, entryPoints: ["extension.ts"], outfile: "dist/extension.js" }),
		esbuild.build({ ...options, entryPoints: ["workers/worker.ts"], outfile: "dist/workers/worker.js" }),
	])
	const manifest = await completeExtensionBuildProvenance({
		repositoryRoot: f.root,
		before,
		compilerInputs: await observer.finish(results),
		build: { ...build, esbuildVersion: esbuild.version },
	})
	assert(manifest.compilerInputs.files.some((row) => row.path === "src/node_modules/bundled-only/index.js"))
	assert.equal((await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })).status, "verified")
})

test("an A-to-B-to-A file race cannot substitute bytes after the standard loader captured them", async (t) => {
	const f = await fixture(t)
	const sourceA = 'export const observed = "A"\n'
	await f.write("src/extension.ts", sourceA)
	await f.write("src/workers/worker.ts", "export const worker = 1\n")
	const before = await captureExtensionBuildSource(f.root)
	const observer = createExtensionBuildInputCapture(f.root)
	const racingPlugin = {
		name: "controlled-file-race",
		setup(build) {
			observer.plugin.setup({
				onLoad(options, callback) {
					build.onLoad(options, async (args) => {
						const captured = await callback(args)
						if (path.basename(args.path) === "extension.ts")
							await f.write("src/extension.ts", 'export const observed = "B"\n')
						return captured
					})
				},
			})
		},
	}
	const options = {
		absWorkingDir: f.extensionPath,
		bundle: true,
		format: "cjs",
		platform: "node",
		metafile: true,
		plugins: [racingPlugin],
		logLevel: "silent",
	}
	const results = await Promise.all([
		esbuild.build({ ...options, entryPoints: ["extension.ts"], outfile: "dist/extension.js" }),
		esbuild.build({ ...options, entryPoints: ["workers/worker.ts"], outfile: "dist/workers/worker.js" }),
	])
	await f.write("src/extension.ts", sourceA)
	const compiled = await readFile(path.join(f.extensionPath, "dist/extension.js"), "utf8")
	assert(compiled.includes('"A"'))
	assert(!compiled.includes('"B"'))
	await completeExtensionBuildProvenance({
		repositoryRoot: f.root,
		before,
		compilerInputs: await observer.finish(results),
		build,
	})
	assert.equal((await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })).status, "verified")
})

test("a custom transform that consumed changed bytes cannot attest restored source bytes", async (t) => {
	const f = await fixture(t)
	const observer = createExtensionBuildInputCapture(f.root)
	let load
	observer.plugin.setup({
		onLoad(_options, callback) {
			load = callback
		},
	})
	await observer.captureInput(
		path.join(f.extensionPath, "extension.ts"),
		Buffer.from("different bytes actually read"),
	)
	await load({ path: path.join(f.extensionPath, "workers", "worker.ts") })
	await assert.rejects(
		observer.finish([
			{ metafile: { inputs: { "extension.ts": {} }, outputs: { "dist/extension.js": {} } } },
			{ metafile: { inputs: { "workers/worker.ts": {} }, outputs: { "dist/workers/worker.js": {} } } },
		]),
		/changed during build/u,
	)
})

test("resolver metadata ABA retains explicit controlled-build assumptions through host verification", async (t) => {
	const f = await fixture(t)
	const packagePath = "src/node_modules/bundled-only/package.json"
	const manifestA = JSON.stringify({ name: "bundled-only", version: "1.0.0", main: "a.js" })
	const manifestB = JSON.stringify({ name: "bundled-only", version: "1.0.0", main: "b.js" })
	await f.write(packagePath, manifestA)
	await f.write("src/node_modules/bundled-only/a.js", 'exports.helper = "A"\n')
	await f.write("src/node_modules/bundled-only/b.js", 'exports.helper = "B"\n')
	await f.write("src/extension.ts", "import { helper } from 'bundled-only'; export const observed = helper\n")
	await f.write("src/workers/worker.ts", "export const worker = 1\n")
	const before = await captureExtensionBuildSource(f.root)
	const observer = createExtensionBuildInputCapture(f.root)
	const metadataRace = {
		name: "controlled-resolver-metadata-race",
		setup(build) {
			build.onResolve({ filter: /^bundled-only$/ }, async (args) => {
				if (args.pluginData?.provenancePass) return undefined
				await f.write(packagePath, manifestB)
				try {
					return await build.resolve(args.path, {
						resolveDir: args.resolveDir,
						kind: args.kind,
						pluginData: { provenancePass: true },
					})
				} finally {
					await f.write(packagePath, manifestA)
				}
			})
		},
	}
	const options = {
		absWorkingDir: f.extensionPath,
		bundle: true,
		format: "cjs",
		platform: "node",
		metafile: true,
		plugins: [metadataRace, observer.plugin],
		logLevel: "silent",
	}
	const results = await Promise.all([
		esbuild.build({ ...options, entryPoints: ["extension.ts"], outfile: "dist/extension.js" }),
		esbuild.build({ ...options, entryPoints: ["workers/worker.ts"], outfile: "dist/workers/worker.js" }),
	])
	assert.equal(await readFile(path.join(f.root, packagePath), "utf8"), manifestA)
	assert((await readFile(path.join(f.extensionPath, "dist/extension.js"), "utf8")).includes('"B"'))
	const manifest = await completeExtensionBuildProvenance({
		repositoryRoot: f.root,
		before,
		compilerInputs: await observer.finish(results),
		build,
	})
	assert.equal(manifest.source.boundarySnapshotsUnchanged, true)
	assert.equal(manifest.compilerInputs.loaderBytesVerified, true)
	assert.equal(manifest.compilerInputs.verifiedInputs, undefined)
	assert.equal(manifest.source.inputsUnchanged, undefined)
	const proof = await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })
	assert.equal(proof.status, "verified")
	assert.deepEqual(proof.sourceAssociation, manifest.sourceAssociation)
	assert.equal(proof.sourceAssociation.resolverMetadataBytes, "unobserved")
	assert.equal(proof.sourceAssociation.concurrentFilesystemWrites, "assumed-absent")
	assert.equal(proof.sourceAssociation.immutableFilesystem, false)
})

test("linked runtime directories are rejected without following their contents", async (t) => {
	const f = await built(t)
	await mkdir(path.join(f.root, "outside"))
	try {
		await symlink(
			path.join(f.root, "outside"),
			path.join(f.extensionPath, "assets", "outside"),
			process.platform === "win32" ? "junction" : "dir",
		)
	} catch (error) {
		if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
			t.skip("filesystem cannot create a test link")
			return
		}
		throw error
	}
	assert.equal((await verifyExtensionBuildProvenance({ extensionPath: f.extensionPath })).status, "invalid")
})
