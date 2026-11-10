import { exec, execFile } from "child_process"
import { promisify } from "util"

import type { GitCommit } from "@alpha-code/types"

import { truncateOutput } from "../integrations/misc/extract-text"

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const GIT_OUTPUT_LINE_LIMIT = 500

async function checkGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
	try {
		signal?.throwIfAborted()
		if (signal) await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd, signal })
		else await execAsync("git rev-parse --git-dir", { cwd })
		return true
	} catch (error) {
		signal?.throwIfAborted()
		return false
	}
}

/**
 * Checks if Git is installed on the system by attempting to run git --version
 * @returns {Promise<boolean>} True if Git is installed and accessible, false otherwise
 * @example
 * const isGitInstalled = await checkGitInstalled();
 * if (!isGitInstalled) {
 *   console.log("Git is not installed");
 * }
 */
export async function checkGitInstalled(signal?: AbortSignal): Promise<boolean> {
	try {
		signal?.throwIfAborted()
		if (signal) await execFileAsync("git", ["--version"], { signal })
		else await execAsync("git --version")
		return true
	} catch (error) {
		signal?.throwIfAborted()
		return false
	}
}

export async function searchCommits(query: string, cwd: string): Promise<GitCommit[]> {
	try {
		const isInstalled = await checkGitInstalled()
		if (!isInstalled) {
			console.error("Git is not installed")
			return []
		}

		const isRepo = await checkGitRepo(cwd)
		if (!isRepo) {
			console.error("Not a git repository")
			return []
		}

		// Search commits by hash or message, limiting to 10 results
		const { stdout } = await execFileAsync(
			"git",
			[
				"log",
				"-n",
				"10",
				"--format=%H%n%h%n%s%n%an%n%ad",
				"--date=short",
				`--grep=${query}`,
				"--regexp-ignore-case",
			],
			{ cwd },
		)

		let output = stdout
		if (!output.trim() && /^[a-f0-9]+$/i.test(query)) {
			// If no results from grep search and query looks like a hash, try searching by hash
			const { stdout: hashStdout } = await execFileAsync(
				"git",
				["log", "-n", "10", "--format=%H%n%h%n%s%n%an%n%ad", "--date=short", "--author-date-order", query],
				{ cwd },
			).catch(() => ({ stdout: "" }))

			if (!hashStdout.trim()) {
				return []
			}

			output = hashStdout
		}

		const commits: GitCommit[] = []
		const lines = output
			.trim()
			.split("\n")
			.filter((line) => line !== "--")

		for (let i = 0; i < lines.length; i += 5) {
			commits.push({
				hash: lines[i],
				shortHash: lines[i + 1],
				subject: lines[i + 2],
				author: lines[i + 3],
				date: lines[i + 4],
			})
		}

		return commits
	} catch (error) {
		console.error("Error searching commits:", error)
		return []
	}
}

export async function getCommitInfo(hash: string, cwd: string): Promise<string> {
	try {
		if (!/^[a-f0-9]{4,40}$/i.test(hash)) {
			return "Invalid commit hash"
		}

		const isInstalled = await checkGitInstalled()
		if (!isInstalled) {
			return "Git is not installed"
		}

		const isRepo = await checkGitRepo(cwd)
		if (!isRepo) {
			return "Not a git repository"
		}

		// Get commit info, stats, and diff separately
		const { stdout: info } = await execFileAsync(
			"git",
			["show", "--format=%H%n%h%n%s%n%an%n%ad%n%b", "--no-patch", hash],
			{ cwd },
		)
		const [fullHash, shortHash, subject, author, date, body] = info.trim().split("\n")

		const { stdout: stats } = await execFileAsync("git", ["show", "--stat", "--format=", hash], { cwd })

		const { stdout: diff } = await execFileAsync("git", ["show", "--format=", hash], { cwd })

		const summary = [
			`Commit: ${shortHash} (${fullHash})`,
			`Author: ${author}`,
			`Date: ${date}`,
			`\nMessage: ${subject}`,
			body ? `\nDescription:\n${body}` : "",
			"\nFiles Changed:",
			stats.trim(),
			"\nFull Changes:",
		].join("\n")

		const output = summary + "\n\n" + diff.trim()
		return truncateOutput(output, GIT_OUTPUT_LINE_LIMIT)
	} catch (error) {
		console.error("Error getting commit info:", error)
		return `Failed to get commit info: ${error instanceof Error ? error.message : String(error)}`
	}
}

export async function getWorkingState(cwd: string): Promise<string> {
	try {
		const isInstalled = await checkGitInstalled()
		if (!isInstalled) {
			return "Git is not installed"
		}

		const isRepo = await checkGitRepo(cwd)
		if (!isRepo) {
			return "Not a git repository"
		}

		// Get status of working directory
		const { stdout: status } = await execAsync("git status --short", { cwd })
		if (!status.trim()) {
			return "No changes in working directory"
		}

		// Get all changes (both staged and unstaged) compared to HEAD
		const { stdout: diff } = await execAsync("git diff HEAD", { cwd })
		const lineLimit = GIT_OUTPUT_LINE_LIMIT
		const output = `Working directory changes:\n\n${status}\n\n${diff}`.trim()
		return truncateOutput(output, lineLimit)
	} catch (error) {
		console.error("Error getting working state:", error)
		return `Failed to get working state: ${error instanceof Error ? error.message : String(error)}`
	}
}

/**
 * Gets git status output with configurable file limit
 * @param cwd The working directory to check git status in
 * @param maxFiles Maximum number of file entries to include (0 = disabled)
 * @returns Git status string or null if not a git repository
 */
export async function getGitStatus(cwd: string, maxFiles: number = 20, signal?: AbortSignal): Promise<string | null> {
	try {
		const isInstalled = await checkGitInstalled(signal)
		if (!isInstalled) {
			return null
		}

		const isRepo = await checkGitRepo(cwd, signal)
		if (!isRepo) {
			return null
		}

		// Use porcelain v1 format with branch info
		signal?.throwIfAborted()
		const { stdout } = signal
			? await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], { cwd, signal })
			: await execAsync("git status --porcelain=v1 --branch", { cwd })

		if (!stdout.trim()) {
			return null
		}

		const lines = stdout.trim().split("\n")

		// First line is always branch info (e.g., "## main...origin/main")
		const branchLine = lines[0]
		const fileLines = lines.slice(1)

		// Build output with branch info and limited file entries
		const output: string[] = [branchLine]

		if (maxFiles > 0 && fileLines.length > 0) {
			const filesToShow = fileLines.slice(0, maxFiles)
			output.push(...filesToShow)

			// Add truncation notice if needed
			if (fileLines.length > maxFiles) {
				output.push(`... ${fileLines.length - maxFiles} more files`)
			}
		}

		return output.join("\n")
	} catch (error) {
		signal?.throwIfAborted()
		console.error("Error getting git status:", error)
		return null
	}
}
