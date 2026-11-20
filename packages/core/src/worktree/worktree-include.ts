/**
 * WorktreeIncludeService
 *
 * Platform-agnostic service for handling .worktreeinclude files.
 * Used to copy untracked files (like node_modules) when creating worktrees.
 */

import { execFile, spawn } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { setTimeout as delay } from "timers/promises"
import { promisify } from "util"

import ignore, { type Ignore } from "ignore"

import type { WorktreeIncludeStatus } from "./types.js"
import { createWorktreeGitEnvironment } from "./git-environment.js"
import {
	joinWorktreeProcess,
	WorktreeProcessCleanupError,
	type WorktreeProcessCancellation,
} from "./worktree-process.js"

/**
 * Progress info for copy tracking.
 * Shows activity without trying to predict total size (which is inaccurate).
 */
export interface CopyProgress {
	/** Current bytes copied */
	bytesCopied: number
	/** Name of current item being copied */
	itemName: string
}

/**
 * Callback for reporting copy progress during worktree file copying.
 */
export type CopyProgressCallback = (progress: CopyProgress) => void

const execFileAsync = promisify(execFile)
const MAX_DISCOVERY_ENTRIES = 100_000
const MAX_DISCOVERY_DEPTH = 64

/**
 * Service for managing .worktreeinclude files and copying files to new worktrees.
 * All methods are platform-agnostic and don't depend on VSCode APIs.
 */
export class WorktreeIncludeService {
	/**
	 * Check if .worktreeinclude exists in a directory
	 */
	async hasWorktreeInclude(dir: string): Promise<boolean> {
		try {
			await fs.access(path.join(dir, ".worktreeinclude"))
			return true
		} catch {
			return false
		}
	}

	/**
	 * Check if a specific branch has .worktreeinclude file (in git, not local filesystem)
	 * @param cwd - Current working directory (git repo)
	 * @param branch - Branch name to check
	 */
	async branchHasWorktreeInclude(cwd: string, branch: string): Promise<boolean> {
		try {
			const ref = `${branch}:.worktreeinclude`
			// Use git cat-file -e to check if the file exists on the branch (without printing contents)
			await execFileAsync("git", ["cat-file", "-e", "--", ref], {
				cwd,
				env: createWorktreeGitEnvironment(),
			})
			return true
		} catch {
			// File doesn't exist on this branch
			return false
		}
	}

	/**
	 * Get the status of .worktreeinclude and .gitignore
	 */
	async getStatus(dir: string): Promise<WorktreeIncludeStatus> {
		const worktreeIncludePath = path.join(dir, ".worktreeinclude")
		const gitignorePath = path.join(dir, ".gitignore")

		let exists = false
		let hasGitignore = false
		let gitignoreContent: string | undefined

		try {
			await fs.access(worktreeIncludePath)
			exists = true
		} catch {
			exists = false
		}

		try {
			gitignoreContent = await fs.readFile(gitignorePath, "utf-8")
			hasGitignore = true
		} catch {
			hasGitignore = false
		}

		return {
			exists,
			hasGitignore,
			gitignoreContent,
		}
	}

	/**
	 * Create a .worktreeinclude file with the specified content
	 */
	async createWorktreeInclude(dir: string, content: string): Promise<void> {
		await fs.writeFile(path.join(dir, ".worktreeinclude"), content, "utf-8")
	}

	/**
	 * Copy files matching .worktreeinclude patterns from source to target.
	 * Only copies files that are ALSO in .gitignore (to avoid copying tracked files).
	 *
	 * @param sourceDir - The source directory containing the files to copy
	 * @param targetDir - The target directory where files will be copied
	 * @param onProgress - Optional callback to report copy progress (size-based)
	 * @returns Array of copied file/directory paths
	 */
	async copyWorktreeIncludeFiles(
		sourceDir: string,
		targetDir: string,
		onProgress?: CopyProgressCallback,
		cancellation?: WorktreeProcessCancellation,
	): Promise<string[]> {
		cancellation?.signal.throwIfAborted()
		const worktreeIncludePath = path.join(sourceDir, ".worktreeinclude")
		const gitignorePath = path.join(sourceDir, ".gitignore")

		// Check if both files exist
		let hasWorktreeInclude = false
		let hasGitignore = false

		try {
			await fs.access(worktreeIncludePath)
			hasWorktreeInclude = true
		} catch {
			hasWorktreeInclude = false
		}

		try {
			await fs.access(gitignorePath)
			hasGitignore = true
		} catch {
			hasGitignore = false
		}

		if (!hasWorktreeInclude || !hasGitignore) {
			return []
		}

		// Parse both files
		const worktreeIncludePatterns = await this.parseIgnoreFile(worktreeIncludePath)
		const gitignorePatterns = await this.parseIgnoreFile(gitignorePath)

		if (worktreeIncludePatterns.length === 0 || gitignorePatterns.length === 0) {
			return []
		}

		// Create ignore matchers
		const worktreeIncludeMatcher = ignore().add(worktreeIncludePatterns)
		const gitignoreMatcher = ignore().add(gitignorePatterns)

		// Find items that match BOTH patterns (intersection)
		const itemsToCopy = await this.findMatchingItems(
			sourceDir,
			worktreeIncludeMatcher,
			gitignoreMatcher,
			cancellation?.signal,
		)
		cancellation?.signal.throwIfAborted()

		if (itemsToCopy.length === 0) {
			return []
		}

		let bytesCopied = 0

		// Report initial progress
		if (onProgress && itemsToCopy.length > 0) {
			onProgress({ bytesCopied: 0, itemName: itemsToCopy[0]! })
		}

		// Copy the items with progress tracking (no total size calculation)
		const copiedItems: string[] = []
		for (const item of itemsToCopy) {
			cancellation?.signal.throwIfAborted()
			const sourcePath = path.join(sourceDir, item)
			const targetPath = path.join(targetDir, item)

			try {
				const stats = await fs.stat(sourcePath)

				if (stats.isDirectory()) {
					// Copy directory with progress tracking
					bytesCopied = await this.copyDirectoryWithProgress(
						sourcePath,
						targetPath,
						item,
						bytesCopied,
						onProgress,
						cancellation,
					)
				} else {
					// Report progress before copying
					onProgress?.({ bytesCopied, itemName: item })

					// Ensure parent directory exists
					await fs.mkdir(path.dirname(targetPath), { recursive: true })
					await fs.copyFile(sourcePath, targetPath)

					// Update bytes copied
					if (onProgress) bytesCopied += this.getSizeOnDisk(stats)
				}

				copiedItems.push(item)

				// Report progress after copying
				onProgress?.({ bytesCopied, itemName: item })
			} catch (error) {
				if (cancellation?.signal.aborted || error instanceof WorktreeProcessCleanupError) throw error
				// Log but don't fail on individual copy errors
				console.error(`Failed to copy ${item}:`, error)
			}
		}

		return copiedItems
	}

	/**
	 * Get the size on disk of a file (accounts for filesystem block allocation).
	 * Uses blksize to calculate actual disk usage including block overhead.
	 */
	private getSizeOnDisk(stats: { size: number; blksize?: number }): number {
		// Calculate size on disk using filesystem block size
		if (stats.blksize !== undefined && stats.blksize > 0) {
			return stats.blksize * Math.ceil(stats.size / stats.blksize)
		}
		// Fallback to logical size when blksize not available
		return stats.size
	}

	/**
	 * Recursively calculate directory size on disk using Node.js fs.
	 * Uses parallel processing for better performance on large directories.
	 */
	private async getDirectorySizeRecursive(dirPath: string, signal?: AbortSignal): Promise<number> {
		signal?.throwIfAborted()
		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true })
			const sizes = await Promise.all(
				entries.map(async (entry) => {
					signal?.throwIfAborted()
					const entryPath = path.join(dirPath, entry.name)
					try {
						if (entry.isFile()) {
							const stats = await fs.stat(entryPath)
							return this.getSizeOnDisk(stats)
						} else if (entry.isDirectory()) {
							return await this.getDirectorySizeRecursive(entryPath, signal)
						}
						return 0
					} catch {
						signal?.throwIfAborted()
						return 0 // Skip inaccessible files
					}
				}),
			)
			return sizes.reduce((sum, size) => sum + size, 0)
		} catch {
			signal?.throwIfAborted()
			return 0
		}
	}

	/**
	 * Use the platform's native copy command and measure destination size when reporting progress.
	 */
	private async copyDirectoryWithProgress(
		source: string,
		target: string,
		itemName: string,
		bytesCopiedBefore: number,
		onProgress?: CopyProgressCallback,
		cancellation?: WorktreeProcessCancellation,
	): Promise<number> {
		// Ensure parent directory exists
		await fs.mkdir(path.dirname(target), { recursive: true })
		cancellation?.signal.throwIfAborted()

		const isWindows = process.platform === "win32"
		const program = isWindows ? "robocopy" : "cp"
		// Keep junctions excluded and override Robocopy's default million retries.
		const args = isWindows
			? [source, target, "/E", "/XJ", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"]
			: ["-r", "--", source, target]
		const proc = spawn(program, args, { windowsHide: true, stdio: "ignore" })
		const execution = new Promise<void>((resolve, reject) => {
			proc.once("error", reject)
			proc.once("close", (code) => {
				if (code !== null && (isWindows ? code < 8 : code === 0)) resolve()
				else reject(new Error(`${program} failed with code ${code}`))
			})
		})
		const copy = joinWorktreeProcess(execution, proc, cancellation)
		if (!onProgress) {
			await copy
			return bytesCopiedBefore
		}

		const progress = new AbortController()
		const signal = cancellation ? AbortSignal.any([progress.signal, cancellation.signal]) : progress.signal
		const poll = (async () => {
			while (!signal.aborted) {
				await delay(500, undefined, { signal })
				if (signal.aborted) return
				const currentSize = await this.getDirectorySizeRecursive(target, cancellation?.signal)
				if (signal.aborted) return
				onProgress({ bytesCopied: bytesCopiedBefore + currentSize, itemName })
			}
		})().catch((error: unknown) => {
			if (!signal.aborted) console.error("Failed to update worktree copy progress:", error)
		})

		try {
			await copy
		} finally {
			progress.abort()
			await poll
		}

		const finalSize = await this.getDirectorySizeRecursive(target, cancellation?.signal)
		return bytesCopiedBefore + finalSize
	}

	/**
	 * Parse a .gitignore-style file and return the patterns
	 */
	private async parseIgnoreFile(filePath: string): Promise<string[]> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			return content
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"))
		} catch {
			return []
		}
	}

	/**
	 * Find items in sourceDir that match both matchers
	 */
	private async findMatchingItems(
		sourceDir: string,
		includeMatcher: Ignore,
		gitignoreMatcher: Ignore,
		signal?: AbortSignal,
	): Promise<string[]> {
		const matchingItems: string[] = []
		const pending = [{ relativePath: "", depth: 0 }]
		let visited = 0

		while (pending.length > 0) {
			signal?.throwIfAborted()
			const directory = pending.pop()!
			const directoryPath = path.join(sourceDir, directory.relativePath)
			if (directory.relativePath) {
				const stats = await fs.lstat(directoryPath).catch(() => undefined)
				if (!stats?.isDirectory() || stats.isSymbolicLink()) continue
			}
			const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => [])
			for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
				if (++visited > MAX_DISCOVERY_ENTRIES) {
					throw new Error(".worktreeinclude discovery exceeded its file entry limit")
				}
				if (entry.name.toLowerCase() === ".git" || entry.isSymbolicLink()) continue
				const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name
				const matchPath = entry.isDirectory() ? `${relativePath}/` : relativePath
				const matchesWorktreeInclude = includeMatcher.ignores(matchPath)
				const matchesGitignore = gitignoreMatcher.ignores(matchPath)

				if (matchesWorktreeInclude && matchesGitignore) {
					matchingItems.push(relativePath)
				} else if (entry.isDirectory()) {
					// Parent directories need not match an include pattern for a descendant to match.
					if (directory.depth >= MAX_DISCOVERY_DEPTH) {
						throw new Error(".worktreeinclude discovery exceeded its directory depth limit")
					}
					pending.push({ relativePath, depth: directory.depth + 1 })
				}
			}
		}

		return matchingItems
	}
}

// Export singleton instance for convenience
export const worktreeIncludeService = new WorktreeIncludeService()
