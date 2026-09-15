import * as childProcess from "child_process"
import * as fs from "fs"
import { createRequire } from "module"
import * as path from "path"
import { StringDecoder } from "string_decoder"

import * as vscode from "vscode"

import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import { fileExistsAtPath } from "../../utils/fs"
/*
This file provides functionality to perform regex searches on files using ripgrep.
Inspired by: https://github.com/DiscreteTom/vscode-ripgrep-utils

Key components:
1. getBinPath: Resolves ripgrep from bundled dependencies, PATH, then VS Code internals.
2. execRipgrep: Executes the ripgrep command and returns the output.
3. regexSearchFiles: The main function that performs regex searches on files.
   - Parameters:
     * cwd: The current working directory (for relative path calculation)
     * directoryPath: The directory to search in
     * regex: The regular expression to search for (Rust regex syntax)
     * filePattern: Optional glob pattern to filter files (default: '*')
   - Returns: A formatted string containing search results with context

The search results include:
- Relative file paths
- 2 lines of context before and after each match
- Matches formatted with pipe characters for easy reading

Usage example:
const results = await regexSearchFiles('/path/to/cwd', '/path/to/search', 'TODO:', '*.ts');

rel/path/to/app.ts
│----
│function processData(data: any) {
│  // Some processing logic here
│  // TODO: Implement error handling
│  return processedData;
│}
│----

rel/path/to/helper.ts
│----
│  let result = 0;
│  for (let i = 0; i < input; i++) {
│    // TODO: Optimize this function for performance
│    result += Math.pow(i, 2);
│  }
│----
*/

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
	"@vscode/ripgrep-linux-x64",
	"@vscode/ripgrep-linux-arm64",
	"@vscode/ripgrep-linux-arm",
	"@vscode/ripgrep-linux-ppc64",
	"@vscode/ripgrep-linux-riscv64",
	"@vscode/ripgrep-linux-s390x",
	"@vscode/ripgrep-linux-ia32",
]
const MAX_PACKAGE_SCAN_DEPTH = 5
let cachedResolution: RipgrepResolution | undefined

interface SearchFileResult {
	file: string
	searchResults: SearchResult[]
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
): Promise<{ path: string; packageName: string } | undefined> {
	const foundPath = await findExecutableUnderDirectory(packageRoot, getExecutableName(platform))
	return foundPath ? { path: foundPath, packageName } : undefined
}

async function resolveBundledRipgrep(
	platform: NodeJS.Platform,
	bundledPackageRoots: RipgrepResolverOptions["bundledPackageRoots"] = [],
	skipRuntimePackageLookup = false,
): Promise<{ path: string; packageName: string } | undefined> {
	for (const { packageName, packageRoot } of bundledPackageRoots) {
		const resolved = await resolveBundledPackageRoot(packageName, packageRoot, platform)
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

			if (exportedPath && (await fileExistsAtPath(exportedPath))) {
				return { path: exportedPath, packageName }
			}
		} catch {
			// Platform packages may only ship bin/rg and no importable module.
		}

		if (packageRoot) {
			const resolved = await resolveBundledPackageRoot(packageName, packageRoot, platform)
			if (resolved) {
				return resolved
			}
		}
	}

	return undefined
}

async function resolveSystemRipgrep(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
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
			if (await fileExistsAtPath(candidate)) {
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
				if (await fileExistsAtPath(candidate)) return candidate
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
}

export async function resolveRipgrepBinary(
	options: RipgrepResolverOptions = {},
): Promise<RipgrepResolution | undefined> {
	if (cachedResolution) {
		return cachedResolution
	}

	const env = options.env ?? process.env
	const platform = options.platform ?? process.platform
	const arch = options.arch ?? process.arch
	const logger = options.logger ?? console

	const bundledRipgrep = await resolveBundledRipgrep(
		platform,
		options.bundledPackageRoots,
		options.skipRuntimePackageLookup,
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

	const systemRipgrep = await resolveSystemRipgrep(env, platform)
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
		const internalRipgrep = await resolveInternalRipgrep(options.appRoot, platform, arch)
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
			finish(new Error(`ripgrep process error: ${error.message}`))
		})

		signal?.addEventListener("abort", onAbort, { once: true })
		if (signal?.aborted) onAbort()
	})
}

export async function regexSearchFiles(
	cwd: string,
	directoryPath: string,
	regex: string,
	filePattern?: string,
	rooIgnoreController?: RooIgnoreController,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted()
	const rgPath = await getBinPath()

	if (!rgPath) {
		throw new Error("Could not find ripgrep binary")
	}

	const args = ["--json", "-e", regex]

	// Only add --glob if a specific file pattern is provided
	// Using --glob "*" overrides .gitignore behavior, so we omit it when no pattern is specified
	if (filePattern) {
		args.push("--glob", filePattern)
	}

	// Keep file-access diagnostics: suppressing them turns a recoverable bad path
	// or permission problem into an unactionable "exited with code 2" error.
	args.push("--context", "1", "--", directoryPath)

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
					}
				} else if (parsed.type === "end") {
					// Reset the current result when a new file is encountered
					if (currentFile) results.push(currentFile)
					currentFile = null
				} else if ((parsed.type === "match" || parsed.type === "context") && currentFile) {
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

	// Filter results using RooIgnoreController if provided
	const filteredResults = rooIgnoreController
		? results.filter((result) => rooIgnoreController.validateAccess(result.file))
		: results

	return formatResults(filteredResults, cwd, truncated)
}

function formatResults(fileResults: SearchFileResult[], cwd: string, truncated: boolean): string {
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
