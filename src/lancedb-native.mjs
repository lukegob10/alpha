import * as fs from "node:fs"
import * as path from "node:path"
import { createRequire } from "node:module"

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
export function resolveLanceDbNativeDependencies(extensionRequire = createRequire(import.meta.url)) {
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
	return { packages, bindings }
}
