import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import * as childProcess from "child_process"
import * as readline from "readline"
import { byLengthAsc, Fzf } from "fzf"
import { createRipgrepProcessError, executeWithRipgrepFallback, getBinPath } from "../ripgrep"
import { Package } from "../../shared/package"

export type FileResult = { path: string; type: "file" | "folder"; label?: string }

const MAX_RIPGREP_STDERR_BYTES = 64 * 1024

function normalizeResultPath(result: FileResult): FileResult {
	// File paths cross the extension/webview boundary and are later parsed with
	// POSIX separators by the mention UI. Keep native separators for filesystem
	// calls, but normalize the relative presentation path on Windows as well.
	return process.platform === "win32" ? { ...result, path: result.path.replace(/\\/g, "/") } : result
}

export async function executeRipgrep({
	args,
	workspacePath,
	limit = 500,
	signal,
}: {
	args: string[]
	workspacePath: string
	limit?: number
	signal?: AbortSignal
}): Promise<FileResult[]> {
	signal?.throwIfAborted()
	const rgPath = await getBinPath()
	signal?.throwIfAborted()

	if (!rgPath) {
		throw new Error(`ripgrep not found: ${rgPath}`)
	}

	return executeWithRipgrepFallback(
		rgPath,
		(activeRgPath) => executeRipgrepAtPath(activeRgPath, args, workspacePath, limit, signal),
		undefined,
		signal,
	)
}

function executeRipgrepAtPath(
	rgPath: string,
	args: string[],
	workspacePath: string,
	limit: number,
	signal?: AbortSignal,
): Promise<FileResult[]> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted()
		const rgProcess = signal
			? childProcess.spawn(rgPath, args, { signal, windowsHide: true })
			: childProcess.spawn(rgPath, args)
		const rl = readline.createInterface({ input: rgProcess.stdout, crlfDelay: Infinity })
		const fileResults: FileResult[] = []
		const dirSet = new Set<string>() // Track unique directory paths.
		const stderrChunks: Buffer[] = []
		let stderrBytes = 0
		let stderrTruncated = false
		let count = 0
		let reachedLimit = false
		let stopping = false
		let settled = false
		let processError: Error | undefined
		const onProcessError = (error: Error) => {
			processError ??= createRipgrepProcessError(error)
		}
		const stop = () => {
			if (stopping || settled) return
			stopping = true
			try {
				rgProcess.kill()
			} catch (error) {
				onProcessError(error instanceof Error ? error : new Error(String(error)))
			}
		}
		const onStreamError = (error: Error) => {
			onProcessError(error)
			stop()
		}

		const onLine = (line: string) => {
			if (reachedLimit || processError || signal?.aborted) return
			if (count < limit) {
				try {
					const relativePath = path.relative(workspacePath, line)

					// Add the file itself.
					fileResults.push({ path: relativePath, type: "file", label: path.basename(relativePath) })

					// Extract and store all parent directory paths.
					let dirPath = path.dirname(relativePath)

					while (dirPath && dirPath !== "." && dirPath !== "/") {
						dirSet.add(dirPath)
						dirPath = path.dirname(dirPath)
					}

					count++
				} catch (error) {
					// Silently ignore errors processing individual paths.
				}
			} else {
				reachedLimit = true
				// Keep draining the pipes until child close acknowledges termination.
				stop()
			}
		}

		const onStderr = (data: Buffer) => {
			const retainedBytes = Math.min(data.length, MAX_RIPGREP_STDERR_BYTES - stderrBytes)
			if (retainedBytes > 0) {
				// Copy the bounded prefix so a large chunk's backing buffer is not retained.
				stderrChunks.push(Buffer.from(data.subarray(0, retainedBytes)))
				stderrBytes += retainedBytes
			}
			if (retainedBytes < data.length) stderrTruncated = true
		}

		// stdout EOF can precede late stderr, process errors, and cancellation.
		// Only child close establishes that the process and both pipes have ended.
		rgProcess.once("close", (code, exitSignal) => {
			if (settled) return
			settled = true
			rgProcess.removeListener("error", onProcessError)
			rgProcess.stdout.removeListener("error", onStreamError)
			rgProcess.stderr.removeListener("error", onStreamError)
			rgProcess.stderr.removeListener("data", onStderr)
			rl.removeListener("line", onLine)
			rl.removeListener("error", onStreamError)
			rl.close()
			const errorOutput =
				Buffer.concat(stderrChunks, stderrBytes).toString("utf8") +
				(stderrTruncated ? "\n[stderr truncated]" : "")
			stderrChunks.length = 0
			if (signal?.aborted) {
				reject(signal.reason ?? new Error("File search cancelled"))
				return
			}
			if (processError) {
				reject(processError)
				return
			}
			if (
				(!reachedLimit && exitSignal) ||
				(fileResults.length === 0 && (errorOutput || (!reachedLimit && code !== 0 && code !== 1)))
			) {
				const status = exitSignal ? `signal ${exitSignal}` : `code ${code}`
				reject(
					new Error(`ripgrep process error: exited with ${status}${errorOutput ? `\n${errorOutput}` : ""}`),
				)
				return
			}
			// Retain the existing partial-file behavior for filesystem errors and
			// deliberate output-limit termination. Exit 1 is an ordinary no-match result.
			const dirResults = Array.from(dirSet).map((dirPath) => ({
				path: dirPath,
				type: "folder" as const,
				label: path.basename(dirPath),
			}))

			resolve([...fileResults, ...dirResults])
		})

		rgProcess.on("error", onProcessError)
		rgProcess.stdout.on("error", onStreamError)
		rgProcess.stderr.on("error", onStreamError)
		rgProcess.stderr.on("data", onStderr)
		rl.on("error", onStreamError)
		rl.on("line", onLine)
	})
}

/**
 * Get extra ripgrep arguments based on VSCode search configuration
 */
function getRipgrepSearchOptions(): string[] {
	const config = vscode.workspace.getConfiguration("search")
	const extraArgs: string[] = []

	// Respect VSCode's search.useIgnoreFiles setting
	if (config.get("useIgnoreFiles") === false) {
		extraArgs.push("--no-ignore")
	}

	// Respect VSCode's search.useGlobalIgnoreFiles setting
	if (config.get("useGlobalIgnoreFiles") === false) {
		extraArgs.push("--no-ignore-global")
	}

	// Respect VSCode's search.useParentIgnoreFiles setting
	if (config.get("useParentIgnoreFiles") === false) {
		extraArgs.push("--no-ignore-parent")
	}

	return extraArgs
}

export async function executeRipgrepForFiles(
	workspacePath: string,
	limit?: number,
): Promise<{ path: string; type: "file" | "folder"; label?: string }[]> {
	// Get limit from configuration if not provided
	const effectiveLimit =
		limit ?? vscode.workspace.getConfiguration(Package.name).get<number>("maximumIndexedFilesForFileSearch", 10000)

	const args = [
		"--files",
		"--follow",
		"--hidden",
		...getRipgrepSearchOptions(),
		"-g",
		"!**/node_modules/**",
		"-g",
		"!**/.git/**",
		"-g",
		"!**/out/**",
		"-g",
		"!**/dist/**",
		workspacePath,
	]

	return executeRipgrep({ args, workspacePath, limit: effectiveLimit })
}

export async function searchWorkspaceFiles(
	query: string,
	workspacePath: string,
	limit: number = 20,
): Promise<{ path: string; type: "file" | "folder"; label?: string }[]> {
	try {
		// Get all files and directories (uses configured limit)
		const allItems = (await executeRipgrepForFiles(workspacePath)).map(normalizeResultPath)

		// If no query, just return the top items
		if (!query.trim()) {
			return allItems.slice(0, limit)
		}

		// Create search items for all files AND directories
		const searchItems = allItems.map((item) => ({
			original: item,
			searchStr: `${item.path} ${item.label || ""}`,
		}))

		// Run fzf search on all items
		const fzf = new Fzf(searchItems, {
			selector: (item) => item.searchStr,
			tiebreakers: [byLengthAsc],
			limit: limit,
		})

		// Get all matching results from fzf
		const fzfResults = fzf.find(query).map((result) => result.item.original)

		// Verify types of the shortest results
		const verifiedResults = await Promise.all(
			fzfResults.map(async (result) => {
				const fullPath = path.join(workspacePath, result.path)
				// Verify if the path exists and is actually a directory
				if (fs.existsSync(fullPath)) {
					const isDirectory = fs.lstatSync(fullPath).isDirectory()
					return {
						...result,
						path: result.path.toPosix(),
						type: isDirectory ? ("folder" as const) : ("file" as const),
					}
				}
				// If path doesn't exist, keep original type
				return result
			}),
		)

		return verifiedResults
	} catch (error) {
		console.error("Error in searchWorkspaceFiles:", error)
		return []
	}
}
