import * as fs from "fs"
import { createRequire } from "module"
import * as path from "path"

import * as vscode from "vscode"

import { fileExistsAtPath } from "../../utils/fs"

export type RipgrepResolutionSource = "bundled" | "system" | "vscode-internal"

export interface RipgrepResolution {
	path: string
	source: RipgrepResolutionSource
	reason: string
}

interface RipgrepResolverOptions {
	appRoot?: string
	bundledPackageRoots?: Array<{ packageName: string; packageRoot: string }>
	skipRuntimePackageLookup?: boolean
	env?: NodeJS.ProcessEnv
	platform?: NodeJS.Platform
	arch?: NodeJS.Architecture
	excludedPaths?: string[]
	logger?: Pick<Console, "info" | "warn">
}

const BUNDLED_RIPGREP_PACKAGES = [
	"@vscode/ripgrep",
	"@vscode/ripgrep-universal",
	"@vscode/ripgrep-darwin-x64",
	"@vscode/ripgrep-darwin-arm64",
	"@vscode/ripgrep-win32-x64",
	"@vscode/ripgrep-win32-arm64",
	"@vscode/ripgrep-win32-ia32",
]
const MAX_PACKAGE_SCAN_DEPTH = 5
let cachedResolution: RipgrepResolution | undefined
const unavailableBinaryPaths = new Set<string>()

function getExecutableName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "rg.exe" : "rg"
}

function normalizeBinaryPath(binaryPath: string, platform: NodeJS.Platform = process.platform): string {
	const resolvedPath = path.resolve(binaryPath)
	return platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath
}

function isExcludedBinaryPath(binaryPath: string, excludedPaths: string[], platform: NodeJS.Platform): boolean {
	const normalizedPath = normalizeBinaryPath(binaryPath, platform)
	return excludedPaths.some((excludedPath) => normalizeBinaryPath(excludedPath, platform) === normalizedPath)
}

function isMissingExecutable(error: unknown, binaryPath: string): boolean {
	let processError: unknown = error
	while (processError instanceof Error && "cause" in processError) {
		const cause = (processError as Error & { cause?: unknown }).cause
		if (!cause) break
		processError = cause
	}

	if (!(processError instanceof Error)) return false
	const errnoError = processError as NodeJS.ErrnoException
	if (errnoError.code !== "ENOENT" || (errnoError.syscall && !errnoError.syscall.startsWith("spawn"))) return false
	return !errnoError.path || normalizeBinaryPath(errnoError.path) === normalizeBinaryPath(binaryPath)
}

export function createRipgrepProcessError(error: Error): Error {
	const wrappedError = new Error(`ripgrep process error: ${error.message}`)
	;(wrappedError as Error & { cause?: unknown }).cause = error
	return wrappedError
}

export async function executeWithRipgrepFallback<T>(
	initialBinaryPath: string,
	execute: (binaryPath: string) => Promise<T>,
	resolveFallback: () => Promise<string | undefined> = getBinPath,
	signal?: AbortSignal,
): Promise<T> {
	let binaryPath = initialBinaryPath
	let lastError: unknown
	const attemptedPaths = new Set<string>()
	if (unavailableBinaryPaths.has(normalizeBinaryPath(binaryPath))) {
		const fallbackPath = await resolveFallback()
		if (!fallbackPath || unavailableBinaryPaths.has(normalizeBinaryPath(fallbackPath))) {
			throw new Error("Could not find an available ripgrep binary")
		}
		binaryPath = fallbackPath
	}

	for (let attempt = 0; attempt < 3; attempt++) {
		signal?.throwIfAborted()
		const normalizedPath = normalizeBinaryPath(binaryPath)
		if (attemptedPaths.has(normalizedPath)) break
		attemptedPaths.add(normalizedPath)

		try {
			return await execute(binaryPath)
		} catch (error) {
			if (signal?.aborted) throw signal.reason ?? error
			if (!isMissingExecutable(error, binaryPath)) throw error

			lastError = error
			unavailableBinaryPaths.add(normalizedPath)
			if (cachedResolution && normalizeBinaryPath(cachedResolution.path) === normalizedPath) {
				cachedResolution = undefined
			}

			const fallbackPath = await resolveFallback()
			signal?.throwIfAborted()
			if (!fallbackPath || attemptedPaths.has(normalizeBinaryPath(fallbackPath))) break
			binaryPath = fallbackPath
		}
	}

	throw lastError ?? new Error("Could not find ripgrep binary")
}

async function findExecutableUnderDirectory(
	directory: string,
	executableName: string,
	maxDepth = MAX_PACKAGE_SCAN_DEPTH,
): Promise<string | undefined> {
	const queue: Array<{ dir: string; depth: number }> = [{ dir: directory, depth: 0 }]

	while (queue.length > 0) {
		const current = queue.shift()

		if (!current) {
			continue
		}

		let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
		try {
			entries = (await fs.promises.readdir(current.dir, { withFileTypes: true })) as typeof entries
		} catch {
			continue
		}

		for (const entry of entries) {
			const entryPath = path.join(current.dir, entry.name)
			if (entry.isFile() && entry.name === executableName) {
				return entryPath
			}
		}

		if (current.depth >= maxDepth) {
			continue
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
			}
		}
	}

	return undefined
}

async function resolveBundledPackageRoot(
	packageName: string,
	packageRoot: string,
	platform: NodeJS.Platform,
	excludedPaths: string[],
): Promise<{ path: string; packageName: string } | undefined> {
	const foundPath = await findExecutableUnderDirectory(packageRoot, getExecutableName(platform))
	return foundPath && !isExcludedBinaryPath(foundPath, excludedPaths, platform)
		? { path: foundPath, packageName }
		: undefined
}

async function resolveBundledRipgrep(
	platform: NodeJS.Platform,
	bundledPackageRoots: RipgrepResolverOptions["bundledPackageRoots"] = [],
	skipRuntimePackageLookup = false,
	excludedPaths: string[] = [],
): Promise<{ path: string; packageName: string } | undefined> {
	for (const { packageName, packageRoot } of bundledPackageRoots) {
		const resolved = await resolveBundledPackageRoot(packageName, packageRoot, platform, excludedPaths)
		if (resolved) {
			return resolved
		}
	}

	if (skipRuntimePackageLookup) {
		return undefined
	}

	const runtimeRequire = createRequire(__filename)

	for (const packageName of BUNDLED_RIPGREP_PACKAGES) {
		let packageRoot: string | undefined

		try {
			const packageJsonPath = runtimeRequire.resolve(`${packageName}/package.json`)
			packageRoot = path.dirname(packageJsonPath)
		} catch {
			// Package not installed or package.json not exported by this package.
		}

		if (!packageRoot) {
			try {
				let current = path.dirname(runtimeRequire.resolve(packageName))
				const expectedPackageName = packageName.split("/").pop()

				while (current && current !== path.dirname(current)) {
					if (
						path.basename(current) === expectedPackageName &&
						(await fileExistsAtPath(path.join(current, "package.json")))
					) {
						packageRoot = current
						break
					}
					current = path.dirname(current)
				}
			} catch {
				// Package not installed or not resolvable from the runtime bundle.
			}
		}

		try {
			const packageRequire = runtimeRequire(packageName) as { rgPath?: string }
			const exportedPath = packageRequire.rgPath

			if (
				exportedPath &&
				!isExcludedBinaryPath(exportedPath, excludedPaths, platform) &&
				(await fileExistsAtPath(exportedPath))
			) {
				return { path: exportedPath, packageName }
			}
		} catch {
			// Platform packages may only ship bin/rg and no importable module.
		}

		if (packageRoot) {
			const resolved = await resolveBundledPackageRoot(packageName, packageRoot, platform, excludedPaths)
			if (resolved) {
				return resolved
			}
		}
	}

	return undefined
}

async function resolveSystemRipgrep(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	excludedPaths: string[],
): Promise<string | undefined> {
	const pathValue = env.PATH || env.Path || env.path
	if (!pathValue) {
		return undefined
	}

	const executableNames = [getExecutableName(platform)]
	if (platform === "win32") {
		const pathExts = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.toLowerCase())
		if (!pathExts.includes(".exe")) {
			executableNames.push("rg.exe")
		}
	}

	for (const pathEntry of pathValue.split(path.delimiter).filter(Boolean)) {
		for (const executableName of executableNames) {
			const candidate = path.join(pathEntry, executableName)
			if (!isExcludedBinaryPath(candidate, excludedPaths, platform) && (await fileExistsAtPath(candidate))) {
				return candidate
			}
		}
	}

	return undefined
}

async function resolveInternalRipgrep(
	appRoot: string,
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
	excludedPaths: string[],
): Promise<string | undefined> {
	const executableName = getExecutableName(platform)
	const target = `${platform}-${arch}`
	const packages = ["@vscode/ripgrep", "@vscode/ripgrep-universal", `@vscode/ripgrep-${target}`, "vscode-ripgrep"]

	for (const moduleDirectory of ["node_modules", "node_modules.asar.unpacked"]) {
		for (const packageName of packages) {
			const binDirectory = path.join(appRoot, moduleDirectory, packageName, "bin")
			// Current hosts use bin/<platform>-<arch>; retain flat legacy layouts without scanning other targets.
			for (const directory of [path.join(binDirectory, target), binDirectory]) {
				const candidate = path.join(directory, executableName)
				if (!isExcludedBinaryPath(candidate, excludedPaths, platform) && (await fileExistsAtPath(candidate))) {
					return candidate
				}
			}
		}
	}

	return undefined
}

function logResolution(resolution: RipgrepResolution, logger: Pick<Console, "info" | "warn">): void {
	const message = `[ripgrep] Selected binary: ${resolution.path} (${resolution.reason})`

	if (resolution.source === "vscode-internal") {
		logger.warn(message)
	} else {
		logger.info(message)
	}
}

export function clearRipgrepPathCache(): void {
	cachedResolution = undefined
	unavailableBinaryPaths.clear()
}

export async function resolveRipgrepBinary(
	options: RipgrepResolverOptions = {},
): Promise<RipgrepResolution | undefined> {
	const env = options.env ?? process.env
	const platform = options.platform ?? process.platform
	const arch = options.arch ?? process.arch
	const logger = options.logger ?? console
	const excludedPaths = [...unavailableBinaryPaths, ...(options.excludedPaths ?? [])]

	if (cachedResolution) {
		if (!isExcludedBinaryPath(cachedResolution.path, excludedPaths, platform)) {
			return cachedResolution
		}
		cachedResolution = undefined
	}

	const bundledRipgrep = await resolveBundledRipgrep(
		platform,
		options.bundledPackageRoots,
		options.skipRuntimePackageLookup,
		excludedPaths,
	)
	if (bundledRipgrep) {
		cachedResolution = {
			path: bundledRipgrep.path,
			source: "bundled",
			reason: `using extension-bundled ${bundledRipgrep.packageName}`,
		}
		logResolution(cachedResolution, logger)
		return cachedResolution
	}

	const systemRipgrep = await resolveSystemRipgrep(env, platform, excludedPaths)
	if (systemRipgrep) {
		cachedResolution = {
			path: systemRipgrep,
			source: "system",
			reason: "extension-bundled ripgrep was unavailable; using rg from PATH",
		}
		logResolution(cachedResolution, logger)
		return cachedResolution
	}

	if (options.appRoot) {
		const internalRipgrep = await resolveInternalRipgrep(options.appRoot, platform, arch, excludedPaths)
		if (internalRipgrep) {
			cachedResolution = {
				path: internalRipgrep,
				source: "vscode-internal",
				reason: "bundled and system ripgrep were unavailable; using VS Code internal compatibility fallback",
			}
			logResolution(cachedResolution, logger)
			return cachedResolution
		}
	}

	logger.warn("[ripgrep] No ripgrep binary found in bundled dependencies, PATH, or VS Code internal fallbacks")
	return undefined
}

/**
 * Get the path to the ripgrep binary.
 */
export async function getBinPath(vscodeAppRoot?: string): Promise<string | undefined> {
	return (await resolveRipgrepBinary({ appRoot: vscodeAppRoot ?? vscode.env.appRoot }))?.path
}
