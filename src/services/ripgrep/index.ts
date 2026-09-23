import * as childProcess from "child_process"
import * as fs from "fs"
import { createRequire } from "module"
import * as path from "path"
import { StringDecoder } from "string_decoder"

import * as vscode from "vscode"
import type { SearchFilesOutputMode } from "@alpha-code/types"

import { AlphaIgnoreController } from "../../core/ignore/AlphaIgnoreController"
import { fileExistsAtPath } from "../../utils/fs"
// All search modes share binary resolution, bounded JSON capture, and ignore filtering.
// Content mode adds one context line on each side; files/count omit source snippets.
// Originally inspired by https://github.com/DiscreteTom/vscode-ripgrep-utils.

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

interface SearchFileResult {
	file: string
	searchResults: SearchResult[]
	matchCount: number
}

interface SearchResult {
	lines: SearchLineResult[]
}

interface SearchLineResult {
	line: number
	text: string
	isMatch: boolean
}

const MAX_RESULTS = 300
const MAX_LINE_LENGTH = 500
const MAX_SEARCH_LINES = MAX_RESULTS * 5
const MAX_OUTPUT_BYTES = 1_048_576

interface RipgrepOutput {
	output: string
	truncated: boolean
}

/**
 * Truncates a line if it exceeds the maximum length
 * @param line The line to truncate
 * @param maxLength The maximum allowed length (defaults to MAX_LINE_LENGTH)
 * @returns The truncated line, or the original line if it's shorter than maxLength
 */
export function truncateLine(line: string, maxLength: number = MAX_LINE_LENGTH): string {
	return line.length > maxLength ? line.substring(0, maxLength) + " [truncated...]" : line
}

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

async function execRipgrep(bin: string, args: string[], signal?: AbortSignal): Promise<RipgrepOutput> {
	signal?.throwIfAborted()
	return executeWithRipgrepFallback(bin, (activeBin) => execRipgrepAtPath(activeBin, args, signal), undefined, signal)
}

function execRipgrepAtPath(bin: string, args: string[], signal?: AbortSignal): Promise<RipgrepOutput> {
	return new Promise((resolve, reject) => {
		const rgProcess = childProcess.spawn(bin, args)
		const decoder = new StringDecoder("utf8")
		let output = ""
		let pendingLine = ""
		let outputBytes = 0
		let lineCount = 0
		let stoppedForLimit = false
		let aborted = false
		let settled = false
		let errorOutput = ""

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort)
			rgProcess.stdout.removeListener("data", onData)
		}
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			cleanup()
			if (error) reject(error)
			else resolve({ output, truncated: stoppedForLimit })
		}
		const stop = (forLimit: boolean) => {
			if (stoppedForLimit || settled) return
			stoppedForLimit = forLimit
			try {
				rgProcess.kill()
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)))
			}
		}
		const onAbort = () => {
			aborted = true
			stop(false)
		}

		const appendLine = (line: string) => {
			if (lineCount < MAX_SEARCH_LINES) {
				output += line + "\n"
				lineCount++
			} else {
				stop(true)
			}
		}
		const onData = (chunk: Buffer) => {
			if (settled || aborted || stoppedForLimit) return
			// Multiline matches are a single JSON record. Bound bytes before buffering
			// a complete record, since a line-oriented reader can retain an entire file.
			const remainingBytes = MAX_OUTPUT_BYTES - outputBytes
			const accepted = chunk.subarray(0, remainingBytes)
			outputBytes += accepted.length
			pendingLine += decoder.write(accepted)
			let newlineIndex: number
			while ((newlineIndex = pendingLine.indexOf("\n")) !== -1) {
				appendLine(pendingLine.slice(0, newlineIndex))
				pendingLine = pendingLine.slice(newlineIndex + 1)
				if (stoppedForLimit) break
			}
			if (chunk.length > remainingBytes) stop(true)
			if (stoppedForLimit) pendingLine = ""
		}
		rgProcess.stdout.on("data", onData)

		rgProcess.stderr.on("data", (data) => {
			// Keep diagnostics bounded; malformed paths and permissions errors should
			// not be able to retain unbounded process output in the extension host.
			if (errorOutput.length < 8_192) {
				errorOutput += data.toString().slice(0, 8_192 - errorOutput.length)
			}
		})

		rgProcess.on("close", (code, exitSignal) => {
			if (settled) return
			if (aborted) {
				const reason = signal?.reason
				finish(reason instanceof Error ? reason : new Error("Ripgrep search cancelled"))
				return
			}
			if (errorOutput) {
				finish(new Error(`ripgrep process error: ${errorOutput}`))
				return
			}
			// ripgrep uses exit code 1 for a valid search with no matches. Any other
			// non-zero exit is an actual execution failure unless we stopped at our
			// bounded output budget.
			if (!stoppedForLimit && code !== 0 && code !== 1) {
				finish(new Error(`ripgrep process exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}`))
				return
			}
			if (!stoppedForLimit) {
				pendingLine += decoder.end()
				if (pendingLine) appendLine(pendingLine)
			}
			finish()
		})
		rgProcess.on("error", (error) => {
			finish(createRipgrepProcessError(error))
		})

		signal?.addEventListener("abort", onAbort, { once: true })
		if (signal?.aborted) onAbort()
	})
}

export interface SearchFilesOptions {
	outputMode?: SearchFilesOutputMode | null
	literal?: boolean | null
}

export async function regexSearchFiles(
	cwd: string,
	directoryPath: string,
	regex: string,
	filePattern?: string,
	alphaIgnoreController?: AlphaIgnoreController,
	signal?: AbortSignal,
	options: SearchFilesOptions = {},
): Promise<string> {
	signal?.throwIfAborted()
	const outputMode = options.outputMode ?? "content"
	const rgPath = await getBinPath()

	if (!rgPath) {
		throw new Error("Could not find ripgrep binary")
	}

	const args = ["--json", "-e", regex]
	if (options.literal) args.push("--fixed-strings")
	// Keep one bounded JSON capture/parser for every mode. Stop early per file
	// when only its path is needed; count mode must retain every occurrence.
	if (outputMode === "files") args.push("--max-count", "1")

	// Only add --glob if a specific file pattern is provided
	// Using --glob "*" overrides .gitignore behavior, so we omit it when no pattern is specified
	if (filePattern) {
		args.push("--glob", filePattern)
	}

	// Keep file-access diagnostics: suppressing them turns a recoverable bad path
	// or permission problem into an unactionable "exited with code 2" error.
	if (outputMode === "content") args.push("--context", "1")
	args.push("--", directoryPath)

	let searchOutput: RipgrepOutput
	try {
		searchOutput = await execRipgrep(rgPath, args, signal)
	} catch (error) {
		// Let ripgrep recognize newline syntax (including hex/Unicode escapes).
		// Retry only this compilation error, once; ordinary searches stay line-oriented.
		if (
			!(error instanceof Error) ||
			!/^ripgrep process error: (?:rg: )?the literal ['"]*\\n['"]* is not allowed in a regex(?:\r?\n|$)/.test(
				error.message,
			)
		) {
			throw error
		}
		searchOutput = await execRipgrep(rgPath, ["--multiline", ...args], signal)
	}

	const results: SearchFileResult[] = []
	let currentFile: SearchFileResult | null = null
	let sourceLineCount = 0
	let truncated = searchOutput.truncated

	parseOutput: for (const line of searchOutput.output.split("\n")) {
		if (line) {
			try {
				const parsed = JSON.parse(line)
				if (parsed.type === "begin") {
					if (currentFile) results.push(currentFile)
					const filePath = parsed.data?.path?.text
					if (typeof filePath !== "string") {
						currentFile = null
						continue
					}
					currentFile = {
						file: filePath,
						searchResults: [],
						matchCount: 0,
					}
				} else if (parsed.type === "end") {
					// Reset the current result when a new file is encountered
					if (currentFile) results.push(currentFile)
					currentFile = null
				} else if ((parsed.type === "match" || parsed.type === "context") && currentFile) {
					if (parsed.type === "match") {
						currentFile.matchCount += Array.isArray(parsed.data.submatches)
							? parsed.data.submatches.length
							: 1
					}
					if (outputMode !== "content") continue
					const text = parsed.data.lines?.text
					if (typeof text !== "string" || !Number.isInteger(parsed.data.line_number)) {
						continue
					}
					// Remove only the final terminator: interior blank lines are source lines.
					const sourceLines = (text.endsWith("\n") ? text.slice(0, -1) : text).split(
						"\n",
						MAX_SEARCH_LINES - sourceLineCount + 1,
					)
					for (const [offset, sourceText] of sourceLines.entries()) {
						if (sourceLineCount === MAX_SEARCH_LINES) {
							truncated = true
							break parseOutput
						}
						sourceLineCount++
						const sourceLine: SearchLineResult = {
							line: parsed.data.line_number + offset,
							text: truncateLine(sourceText.replace(/\r$/, "")),
							isMatch: parsed.type === "match",
						}
						const lastResult = currentFile.searchResults[currentFile.searchResults.length - 1]
						const lastLine = lastResult?.lines[lastResult.lines.length - 1]
						if (lastLine && sourceLine.line <= lastLine.line + 1) {
							lastResult.lines.push(sourceLine)
						} else {
							currentFile.searchResults.push({ lines: [sourceLine] })
						}
					}
				}
			} catch (error) {
				console.error("Error parsing ripgrep output:", error)
			}
		}
	}
	if (currentFile) results.push(currentFile)

	// Filter results using AlphaIgnoreController if provided
	const filteredResults = alphaIgnoreController
		? results.filter((result) => alphaIgnoreController.validateAccess(result.file))
		: results

	return formatResults(filteredResults, cwd, truncated, outputMode)
}

function formatResults(
	fileResults: SearchFileResult[],
	cwd: string,
	truncated: boolean,
	outputMode: SearchFilesOutputMode,
): string {
	if (outputMode !== "content") {
		const counts = new Map<string, number>()
		for (const file of fileResults) {
			if (file.matchCount === 0) continue
			const relativePath = path.relative(cwd, file.file).toPosix()
			counts.set(relativePath, (counts.get(relativePath) ?? 0) + file.matchCount)
		}
		const entries = [...counts.entries()].slice(0, MAX_RESULTS)
		const output = entries.map(([file, count]) => (outputMode === "files" ? file : `${file}: ${count}`)).join("\n")
		if (truncated || counts.size > MAX_RESULTS) {
			return `Search output truncated. Showing ${entries.length} partial file results.${outputMode === "count" ? " Counts are lower bounds." : ""} Refine path, regex, or file_pattern.\n\n${output}`.trim()
		}
		return output || (outputMode === "files" ? "Found 0 files." : "Found 0 matches.")
	}

	const groupedResults = new Map<string, SearchResult[]>()

	const totalResults = fileResults.reduce((sum, file) => sum + file.searchResults.length, 0)
	let output = ""
	if (truncated) {
		output += `Search output truncated. Showing ${Math.min(totalResults, MAX_RESULTS)} partial results. Refine path, regex, or file_pattern.\n\n`
	} else if (totalResults >= MAX_RESULTS) {
		output += `Showing first ${MAX_RESULTS} of ${MAX_RESULTS}+ results. Use a more specific search if necessary.\n\n`
	} else {
		output += `Found ${totalResults === 1 ? "1 result" : `${totalResults.toLocaleString()} results`}.\n\n`
	}

	// Group results by file name
	let remainingResults = MAX_RESULTS
	for (const file of fileResults) {
		if (remainingResults === 0) break
		const relativeFilePath = path.relative(cwd, file.file)
		const existingResults = groupedResults.get(relativeFilePath) ?? []
		const visibleResults = file.searchResults.slice(0, remainingResults)
		remainingResults -= visibleResults.length
		existingResults.push(...visibleResults)
		groupedResults.set(relativeFilePath, existingResults)
	}

	for (const [filePath, fileResults] of groupedResults) {
		output += `# ${filePath.toPosix()}\n`

		fileResults.forEach((result) => {
			// Only show results with at least one line
			if (result.lines.length > 0) {
				// Show all lines in the result
				result.lines.forEach((line) => {
					const lineNumber = String(line.line).padStart(3, " ")
					output += `${lineNumber} | ${line.text.trimEnd()}\n`
				})
				output += "----\n"
			}
		})

		output += "\n"
	}

	return output.trim()
}
