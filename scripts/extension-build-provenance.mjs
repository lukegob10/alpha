import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { execFileSync } from "node:child_process"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

export const extensionBuildProvenancePath = "dist/extension-build-provenance.json"
export const extensionBuildSourceAssociation = Object.freeze({
	kind: "controlled-build-boundary-observation",
	compilerLoaderBytes: "captured",
	resolverMetadataBytes: "unobserved",
	concurrentFilesystemWrites: "assumed-absent",
	immutableFilesystem: false,
	authentication: "none",
})
const sourceRoots = [
	"src",
	"packages/core/src",
	"packages/core/package.json",
	"packages/ipc/src",
	"packages/ipc/package.json",
	"packages/types/src",
	"packages/types/dist",
	"packages/types/package.json",
	"packages/build/src",
	"packages/build/dist",
	"packages/build/package.json",
	"webview-ui/src",
	"webview-ui/public",
	"webview-ui/audio",
	"webview-ui/package.json",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"turbo.json",
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
	"scripts/extension-build-provenance.mjs",
]
const artifactRoots = [
	"dist",
	"assets",
	"integrations/theme/default-themes",
	"webview-ui/build",
	"webview-ui/audio",
	"package.json",
	"package.nls.json",
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
]
const dependencyRoots = ["esbuild", "global-agent"]
const maxFiles = 50_000
const maxFileBytes = 512 * 1024 * 1024
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const canonical = (value) =>
	JSON.stringify(value, (_, child) =>
		child && typeof child === "object" && !Array.isArray(child)
			? Object.fromEntries(Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: child,
	)
const digest = (value) => sha(canonical(value))
const same = (a, b) => canonical(a) === canonical(b)
const hashPattern = /^[a-f0-9]{64}$/u

function validRows(rows) {
	if (!Array.isArray(rows) || !rows.length || rows.length > maxFiles) return false
	let previous = ""
	return rows.every((row) => {
		if (
			!row ||
			!same(Object.keys(row).sort(), ["path", "sha256", "size"]) ||
			!hashPattern.test(row.sha256) ||
			!Number.isSafeInteger(row.size) ||
			row.size < 0 ||
			row.size > maxFileBytes
		)
			return false
		try {
			safeRelative(row.path)
		} catch {
			return false
		}
		if (row.path <= previous) return false
		previous = row.path
		return true
	})
}

function safeRelative(relative) {
	if (
		typeof relative !== "string" ||
		!relative ||
		relative.includes("\\") ||
		relative.includes(":") ||
		relative.includes("\0") ||
		relative.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("unsafe provenance path")
	return relative
}

async function stableFile(file, relative) {
	const before = await lstat(file)
	if (!before.isFile() || before.isSymbolicLink() || before.size > maxFileBytes)
		throw new Error("unsafe provenance file")
	const hash = createHash("sha256")
	for await (const chunk of createReadStream(file)) hash.update(chunk)
	const after = await lstat(file)
	if (
		!after.isFile() ||
		after.isSymbolicLink() ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		before.ctimeMs !== after.ctimeMs
	)
		throw new Error("provenance input changed while hashing")
	return { path: safeRelative(relative), sha256: hash.digest("hex"), size: before.size }
}

const sourceExcluded = (relative) => {
	const parts = relative.split("/")
	return (
		parts.some((part) =>
			["node_modules", ".git", ".turbo", "__tests__", "test", "tests", "coverage"].includes(part),
		) ||
		parts.some((part) => part === ".env" || part.startsWith(".env.")) ||
		/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative) ||
		["src/dist", "src/webview-ui", "src/assets/vscode-material-icons"].some(
			(root) => relative === root || relative.startsWith(root + "/"),
		) ||
		["src/README.md", "src/CHANGELOG.md", "src/LICENSE"].includes(relative)
	)
}

async function inventory(root, roots, excluded = () => false) {
	const rows = []
	async function visit(relative) {
		if (excluded(relative)) return
		const absolute = path.join(root, ...safeRelative(relative).split("/"))
		const info = await lstat(absolute)
		if (info.isSymbolicLink()) throw new Error("linked provenance path")
		if (info.isDirectory()) {
			for (const child of (await readdir(absolute)).sort()) await visit(relative + "/" + child)
		} else {
			if (rows.length >= maxFiles) throw new Error("provenance inventory exceeds its bound")
			rows.push(await stableFile(absolute, relative))
		}
	}
	for (const relative of roots) await visit(relative)
	rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	if (new Set(rows.map((row) => row.path)).size !== rows.length) throw new Error("overlapping provenance roots")
	return rows
}

/** Supply exactly the captured bytes to the standard loader; custom transforms report their actual input bytes. */
export function createExtensionBuildInputCapture(repositoryRoot) {
	let rootPromise
	const resolveRoot = () => (rootPromise ??= realpath(repositoryRoot))
	const observed = new Map()
	let incomplete = false
	const logicalPath = (absolute, root) => {
		const relative = path.relative(root, absolute).split(path.sep).join("/")
		return relative && !relative.startsWith("../") && !path.isAbsolute(relative)
			? relative
			: "external/" + sha(absolute) + "/" + path.basename(absolute)
	}
	async function observe(file, contents) {
		const root = await resolveRoot()
		const absolute = await realpath(file)
		const info = await lstat(absolute)
		if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes)
			throw new Error("unsafe compiler input")
		const bytes = contents === undefined ? await readFile(absolute) : Buffer.from(contents)
		if (bytes.length > maxFileBytes) throw new Error("compiler input exceeds its size bound")
		const row = { path: safeRelative(logicalPath(absolute, root)), sha256: sha(bytes), size: bytes.length }
		const previous = observed.get(absolute)
		if (previous && !same(previous, row)) throw new Error("compiler input changed between loads")
		observed.set(absolute, row)
		return bytes
	}
	return {
		async captureInput(file, contents) {
			try {
				await observe(file, contents)
			} catch {
				incomplete = true
			}
		},
		plugin: {
			name: "extension-build-provenance-inputs",
			setup(build) {
				build.onLoad({ filter: /.*/, namespace: "file" }, async ({ path: file }) => {
					const loader = {
						".js": "js",
						".mjs": "js",
						".cjs": "js",
						".jsx": "jsx",
						".ts": "ts",
						".mts": "ts",
						".cts": "ts",
						".tsx": "tsx",
						".json": "json",
						".css": "css",
					}[path.extname(file)]
					if (!loader) {
						incomplete = true
						return undefined
					}
					try {
						const contents = await observe(file)
						let cursor = path.dirname(file)
						while (true) {
							try {
								await observe(path.join(cursor, "package.json"))
								break
							} catch (error) {
								if (error.code !== "ENOENT") throw error
							}
							const parent = path.dirname(cursor)
							if (parent === cursor) break
							cursor = parent
						}
						return { contents, loader, resolveDir: path.dirname(file) }
					} catch {
						incomplete = true
					}
					return undefined
				})
			},
		},
		async finish(results) {
			const root = await resolveRoot()
			if (
				incomplete ||
				!Array.isArray(results) ||
				results.length !== 2 ||
				results.some(
					(result) =>
						!result.metafile ||
						!Object.keys(result.metafile.inputs).length ||
						!Object.keys(result.metafile.outputs).length,
				)
			)
				throw new Error("compiler input provenance is incomplete")
			for (const result of results)
				for (const input of Object.keys(result.metafile.inputs)) {
					const absolute = await realpath(path.resolve(root, "src", input))
					if (!observed.has(absolute)) throw new Error("compiler input was not captured before loading")
				}
			for (const [absolute, row] of observed)
				if (!same(row, await stableFile(absolute, row.path)))
					throw new Error("compiler input changed during build")
			const files = [...observed.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			return {
				files,
				digest: digest(files),
				loaderBytesVerified: true,
				metafileDigest: digest(results.map((result) => result.metafile)),
			}
		},
	}
}

async function packageManifest(request, require) {
	try {
		return await realpath(require.resolve(request + "/package.json"))
	} catch (error) {
		if (!["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(error.code)) throw error
	}
	let cursor
	try {
		cursor = path.dirname(await realpath(require.resolve(request)))
	} catch (error) {
		if (error.code === "MODULE_NOT_FOUND") return null
		throw error
	}
	while (true) {
		const file = path.join(cursor, "package.json")
		try {
			if (JSON.parse(await readFile(file, "utf8")).name === request) return file
		} catch (error) {
			if (error.code !== "ENOENT") throw error
		}
		const parent = path.dirname(cursor)
		if (parent === cursor) return null
		cursor = parent
	}
}

async function runtimeDependencies(extensionPath) {
	const packages = [],
		missing = [],
		visited = new Map()
	async function collect(request, require, key, optional = false) {
		const manifestPath = await packageManifest(request, require)
		if (!manifestPath) {
			if (!optional) missing.push(key)
			return { request, status: optional ? "absent-optional" : "missing" }
		}
		if (visited.has(manifestPath)) return { request, status: "captured", key: visited.get(manifestPath) }
		if (packages.length >= 1_024) throw new Error("runtime dependency graph exceeds its bound")
		visited.set(manifestPath, key)
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
		if (manifest.name !== request || typeof manifest.version !== "string")
			throw new Error("invalid runtime dependency")
		const root = path.dirname(manifestPath)
		const children = (await readdir(root)).filter((name) => !["node_modules", ".git", ".turbo"].includes(name))
		const files = await inventory(root, children)
		const row = { key, request, version: manifest.version, files, digest: digest(files), dependencies: [] }
		packages.push(row)
		const childRequire = createRequire(manifestPath)
		const required = { ...manifest.dependencies, ...manifest.peerDependencies }
		const optionalNames = new Set([
			...Object.keys(manifest.optionalDependencies ?? {}),
			...Object.keys(manifest.peerDependenciesMeta ?? {}).filter(
				(name) => manifest.peerDependenciesMeta[name]?.optional,
			),
		])
		for (const name of Object.keys({ ...required, ...manifest.optionalDependencies }).sort())
			row.dependencies.push(await collect(name, childRequire, key + "/" + name, optionalNames.has(name)))
		return { request, status: "captured", key }
	}
	const require = createRequire(path.join(extensionPath, "dist", "extension.js"))
	const roots = []
	for (const request of dependencyRoots) roots.push(await collect(request, require, request))
	const body = {
		roots,
		packages: packages.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
		missing: missing.sort(),
	}
	return { ...body, digest: digest(body) }
}

function revision(repositoryRoot) {
	const value = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		windowsHide: true,
	}).trim()
	if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error("source revision is unavailable")
	return value
}

/** Capture before the official esbuild invocation; a later checkout hash cannot attest an old bundle. */
export async function captureExtensionBuildSource(repositoryRoot) {
	const root = await realpath(repositoryRoot)
	const files = await inventory(root, sourceRoots, sourceExcluded)
	return {
		revision: revision(root),
		roots: [...sourceRoots],
		files,
		digest: digest(files),
		runtimeDependencies: await runtimeDependencies(path.join(root, "src")),
	}
}

/** Called after both extension/workers and copy plugins settle. Every output file is bound to this build. */
export async function completeExtensionBuildProvenance({ repositoryRoot, before, compilerInputs, build }) {
	const root = await realpath(repositoryRoot)
	const after = await captureExtensionBuildSource(root)
	if (!same(before, after)) throw new Error("Extension source or runtime dependencies changed during the build")
	if (
		!compilerInputs ||
		compilerInputs.loaderBytesVerified !== true ||
		!validRows(compilerInputs.files) ||
		compilerInputs.digest !== digest(compilerInputs.files) ||
		!hashPattern.test(compilerInputs.metafileDigest)
	)
		throw new Error("compiler input provenance is incomplete")
	const extensionPath = path.join(root, "src")
	const files = await inventory(extensionPath, artifactRoots, (relative) => relative === extensionBuildProvenancePath)
	const entrypoint = files.find((row) => row.path === "dist/extension.js")
	const packageJson = files.find((row) => row.path === "package.json")
	if (!entrypoint?.size || !packageJson?.size) throw new Error("Extension build artifacts are incomplete")
	const { runtimeDependencies: dependencies, ...source } = before
	const body = {
		schemaVersion: 1,
		kind: "alpha-extension-build-provenance",
		producer: "src/esbuild.mjs",
		identityScope: "conservative-whole-source",
		scopeVersion: 2,
		sourceAssociation: extensionBuildSourceAssociation,
		source: {
			...source,
			snapshotDigest: source.digest,
			digest: digest({ snapshotDigest: source.digest, compilerInputDigest: compilerInputs.digest }),
			boundarySnapshotsUnchanged: true,
		},
		compilerInputs,
		build,
		artifacts: {
			roots: [...artifactRoots],
			files,
			digest: digest(files),
			entrypoint: entrypoint.path,
			entrypointSha256: entrypoint.sha256,
			packageJsonSha256: packageJson.sha256,
		},
		runtimeDependencies: dependencies,
	}
	const manifest = { ...body, digest: digest(body) }
	await writeFile(path.join(extensionPath, extensionBuildProvenancePath), JSON.stringify(manifest, null, 2) + "\n", {
		flag: "wx",
	})
	return manifest
}

/** Rehash installed/development artifact bytes and actual external resolution. This does not authenticate the builder. */
export async function verifyExtensionBuildProvenance({
	extensionPath,
	expectedEntrypointSha256,
	expectedPackageJsonSha256,
}) {
	const result = {
		status: "unavailable",
		identityScope: "conservative-whole-source",
		provenance: "build-owned-content-association",
		sourceAssociation: extensionBuildSourceAssociation,
		missing: [],
	}
	try {
		const root = await realpath(extensionPath)
		const file = path.join(root, extensionBuildProvenancePath)
		const info = await lstat(file)
		if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
			throw new Error("invalid manifest file")
		const manifest = JSON.parse(await readFile(file, "utf8"))
		const { digest: manifestDigest, ...body } = manifest
		if (
			manifestDigest !== digest(body) ||
			manifest.schemaVersion !== 1 ||
			manifest.kind !== "alpha-extension-build-provenance" ||
			manifest.producer !== "src/esbuild.mjs" ||
			manifest.identityScope !== "conservative-whole-source" ||
			manifest.scopeVersion !== 2 ||
			!same(manifest.sourceAssociation, extensionBuildSourceAssociation) ||
			manifest.source?.boundarySnapshotsUnchanged !== true ||
			!/^[a-f0-9]{40}$/u.test(manifest.source.revision) ||
			!same(manifest.source.roots, sourceRoots) ||
			!same(manifest.artifacts?.roots, artifactRoots) ||
			!validRows(manifest.source.files) ||
			!validRows(manifest.artifacts.files) ||
			!validRows(manifest.compilerInputs?.files) ||
			manifest.compilerInputs.loaderBytesVerified !== true ||
			!hashPattern.test(manifest.compilerInputs.metafileDigest) ||
			manifest.compilerInputs.digest !== digest(manifest.compilerInputs.files) ||
			manifest.source.snapshotDigest !== digest(manifest.source.files) ||
			manifest.source.digest !==
				digest({
					snapshotDigest: manifest.source.snapshotDigest,
					compilerInputDigest: manifest.compilerInputs.digest,
				}) ||
			manifest.artifacts.digest !== digest(manifest.artifacts.files)
		)
			throw new Error("invalid manifest contract")
		const files = await inventory(root, artifactRoots, (relative) => relative === extensionBuildProvenancePath)
		if (!same(files, manifest.artifacts.files)) throw new Error("extension artifact bytes changed")
		const entrypoint = files.find((row) => row.path === "dist/extension.js")
		const packageJson = files.find((row) => row.path === "package.json")
		if (
			!entrypoint?.size ||
			!packageJson?.size ||
			manifest.artifacts.entrypoint !== "dist/extension.js" ||
			entrypoint.sha256 !== manifest.artifacts.entrypointSha256 ||
			packageJson.sha256 !== manifest.artifacts.packageJsonSha256
		)
			throw new Error("entrypoint or package identity differs")
		for (const [expected, actual] of [
			[expectedEntrypointSha256, entrypoint.sha256],
			[expectedPackageJsonSha256, packageJson.sha256],
		])
			if (expected !== undefined && (!hashPattern.test(expected) || expected !== actual))
				throw new Error("observed extension identity differs")
		const dependencies = await runtimeDependencies(root)
		if (!same(dependencies, manifest.runtimeDependencies)) throw new Error("runtime dependency bytes changed")
		if (dependencies.missing.length) return { ...result, missing: ["runtime-dependency-closure"] }
		return {
			...result,
			status: "verified",
			manifestDigest,
			sourceRevision: manifest.source.revision,
			sourceTreeDigest: manifest.source.digest,
			artifactTreeDigest: manifest.artifacts.digest,
			entrypointSha256: entrypoint.sha256,
			packageJsonSha256: packageJson.sha256,
		}
	} catch (error) {
		return {
			...result,
			status: error.code === "ENOENT" ? "unavailable" : "invalid",
			missing: [error.code === "ENOENT" ? "build-provenance-unavailable" : "build-provenance-invalid"],
		}
	}
}
