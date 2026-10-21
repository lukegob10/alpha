import * as fs from "node:fs"
import * as path from "node:path"
import { createRequire } from "node:module"
import process from "node:process"

// VS Code target names differ from the native loader's libc/toolchain suffixes.
// Intel macOS retains core extension support; LanceDB 0.27.2 ships no matching native package.
export const lanceDbTargetBindings = Object.freeze({
	"win32-x64": "lancedb.win32-x64-msvc.node",
	"win32-arm64": "lancedb.win32-arm64-msvc.node",
	"darwin-x64": null,
	"darwin-arm64": "lancedb.darwin-arm64.node",
	"linux-x64": "lancedb.linux-x64-gnu.node",
	"linux-arm64": "lancedb.linux-arm64-gnu.node",
	"alpine-x64": "lancedb.linux-x64-musl.node",
	"alpine-arm64": "lancedb.linux-arm64-musl.node",
})

export function lanceDbBindingForTarget(target) {
	if (!Object.hasOwn(lanceDbTargetBindings, target)) throw new Error(`Unsupported VSIX target: ${target}`)
	return lanceDbTargetBindings[target]
}

export function hostVsixTarget({ platform = process.platform, arch = process.arch, libc } = {}) {
	if (platform === "linux") {
		libc ??= process.report.getReport().header.glibcVersionRuntime ? "gnu" : "musl"
		if (libc !== "gnu" && libc !== "musl") throw new Error(`Unsupported Linux libc: ${libc}`)
	}
	const target = `${platform === "linux" && libc === "musl" ? "alpine" : platform}-${arch}`
	lanceDbBindingForTarget(target)
	return target
}

function resolvePackageManifest(packageName, packageRequire) {
	try {
		return packageRequire.resolve(`${packageName}/package.json`)
	} catch (error) {
		if (error.code === "MODULE_NOT_FOUND") return undefined
		if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error
	}

	// Some packages export their entry point but hide package.json. Resolve without executing native code.
	let directory = path.dirname(packageRequire.resolve(packageName))
	while (true) {
		const manifestPath = path.join(directory, "package.json")
		try {
			if (JSON.parse(fs.readFileSync(manifestPath, "utf8")).name === packageName) return manifestPath
		} catch (error) {
			if (error.code !== "ENOENT") throw error
		}
		const parent = path.dirname(directory)
		if (parent === directory) throw new Error(`Cannot locate the manifest for ${packageName}`)
		directory = parent
	}
}

/** One inventory drives external imports and the flat dist/*.node runtime layout; importing performs no I/O. */
export function resolveLanceDbNativeDependencies(extensionRequire = createRequire(import.meta.url), target) {
	const requiredBinding = target === undefined ? undefined : lanceDbBindingForTarget(target)
	const manifestPath = resolvePackageManifest("@lancedb/lancedb", extensionRequire)
	if (!manifestPath) throw new Error("Cannot resolve @lancedb/lancedb for extension packaging")
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
	if (manifest.name !== "@lancedb/lancedb" || !manifest.optionalDependencies) {
		throw new Error("LanceDB native optional dependency metadata is missing")
	}
	const packages = Object.keys(manifest.optionalDependencies)
		.filter((name) => /^@lancedb\/lancedb-[a-z0-9-]+$/.test(name))
		.sort()
	if (packages.length === 0) throw new Error("LanceDB declares no native optional packages")
	const packageRequire = createRequire(manifestPath)
	const bindings = []
	const destinations = new Set()
	for (const packageName of packages) {
		const nativeManifestPath = resolvePackageManifest(packageName, packageRequire)
		// Optional packages may be absent on another platform. Malformed installed packages must not be skipped.
		if (!nativeManifestPath) continue
		const nativeManifest = JSON.parse(fs.readFileSync(nativeManifestPath, "utf8"))
		const main = nativeManifest.main
		if (
			nativeManifest.name !== packageName ||
			typeof main !== "string" ||
			!/^(?:\.\/)?lancedb\.[a-z0-9-]+\.node$/.test(main)
		) {
			throw new Error(`Invalid LanceDB native entry point for ${packageName}`)
		}
		const binding = path.join(path.dirname(nativeManifestPath), main)
		if (!fs.statSync(binding).isFile()) throw new Error(`LanceDB native entry point is not a file: ${packageName}`)
		const destination = path.basename(binding).toLowerCase()
		if (destinations.has(destination)) throw new Error(`Conflicting LanceDB native destination: ${destination}`)
		destinations.add(destination)
		bindings.push(binding)
	}
	if (target !== undefined) {
		if (requiredBinding === null) return { packages, bindings: [] }
		const binding = bindings.find((file) => path.basename(file) === requiredBinding)
		if (!binding) {
			throw new Error(
				`Missing LanceDB binding ${requiredBinding} for VSIX target ${target}; install the target's optional dependencies before packaging`,
			)
		}
		return { packages, bindings: [binding] }
	}
	return { packages, bindings }
}
