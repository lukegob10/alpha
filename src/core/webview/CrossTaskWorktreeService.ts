import { execFile } from "child_process"
import fs from "fs/promises"
import path from "path"
import { promisify } from "util"

import { worktreeIncludeService } from "@alpha-code/core"

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 1024 * 1024
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

export interface CrossTaskWorktree {
	workspacePath: string
	workspaceRelativePath: string
	baselineCommit: string
	cleanup: () => Promise<void>
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizePersistedRelativePath(value: string): string {
	if (typeof value !== "string" || value.includes("\\") || path.posix.isAbsolute(value)) {
		throw new Error("The saved task worktree path is invalid")
	}
	if (value === "") return ""
	const segments = value.split("/")
	if (
		segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git")
	) {
		throw new Error("The saved task worktree path is invalid")
	}
	return segments.join("/")
}

/** Creates task-owned Git worktrees without changing the user's checkout or Git index. */
export class CrossTaskWorktreeService {
	async create(globalStoragePath: string, taskId: string, sourceWorkspacePath: string): Promise<CrossTaskWorktree> {
		if (!TASK_ID_PATTERN.test(taskId)) throw new Error("The task ID is invalid for a worktree path")

		const sourceWorkspace = await fs.realpath(path.resolve(sourceWorkspacePath))
		const gitRootOutput = await this.git(sourceWorkspace, ["rev-parse", "--show-toplevel"])
		const gitRoot = await fs.realpath(path.resolve(gitRootOutput.trim()))
		if (!isWithin(gitRoot, sourceWorkspace)) throw new Error("The task workspace is outside its Git repository")

		const relativeNative = path.relative(gitRoot, sourceWorkspace)
		const relativeParts = relativeNative ? relativeNative.split(path.sep) : []
		if (
			relativeNative.startsWith("..") ||
			path.isAbsolute(relativeNative) ||
			relativeParts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
		) {
			throw new Error("The task workspace path cannot be represented safely inside a Git worktree")
		}
		const workspaceRelativePath = relativeParts.join("/")

		const storageRoot = await fs.realpath(path.resolve(globalStoragePath))
		const requestedWorktreeParent = path.resolve(storageRoot, "cross-task-worktrees")
		await fs.mkdir(requestedWorktreeParent, { recursive: true })
		const worktreeParent = await fs.realpath(requestedWorktreeParent)
		if (!isWithin(storageRoot, worktreeParent) || worktreeParent === storageRoot) {
			throw new Error("The task worktree directory escapes extension storage")
		}
		const worktreePath = path.resolve(worktreeParent, taskId)
		if (!isWithin(worktreeParent, worktreePath) || worktreePath === worktreeParent) {
			throw new Error("The task worktree path escapes extension storage")
		}
		try {
			await fs.lstat(worktreePath)
			throw new Error("A worktree already exists for this task")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}

		const baselineCommit = (await this.git(gitRoot, ["rev-parse", "--verify", "HEAD"])).trim()
		if (!/^[0-9a-f]{40,64}$/i.test(baselineCommit)) throw new Error("The repository has no valid HEAD commit")

		let worktreeAdded = false
		try {
			await this.git(gitRoot, ["worktree", "add", "--detach", worktreePath, baselineCommit])
			worktreeAdded = true
			await worktreeIncludeService.copyWorktreeIncludeFiles(gitRoot, worktreePath)
			await this.ensureWorkspaceDirectory(worktreePath, relativeParts)
		} catch (error) {
			if (worktreeAdded) await this.removeWorktree(gitRoot, worktreeParent, worktreePath)
			else await this.removeCreatedPath(worktreeParent, worktreePath)
			throw error
		}

		const workspacePath = path.resolve(worktreePath, ...relativeParts)
		if (!isWithin(worktreePath, workspacePath)) {
			await this.removeWorktree(gitRoot, worktreeParent, worktreePath)
			throw new Error("The task workspace escaped its Git worktree")
		}
		return {
			workspacePath,
			workspaceRelativePath,
			baselineCommit,
			cleanup: () => this.removeWorktree(gitRoot, worktreeParent, worktreePath),
		}
	}

	async resolve(globalStoragePath: string, taskId: string, workspaceRelativePath: string): Promise<string> {
		if (!TASK_ID_PATTERN.test(taskId)) throw new Error("The task ID is invalid for a worktree path")
		const safeRelativePath = normalizePersistedRelativePath(workspaceRelativePath)
		const storageRoot = await fs.realpath(path.resolve(globalStoragePath))
		const worktreeParent = await fs.realpath(path.resolve(storageRoot, "cross-task-worktrees")).catch(() => {
			throw new Error("The task worktree is missing; it was not restored")
		})
		if (!isWithin(storageRoot, worktreeParent) || worktreeParent === storageRoot) {
			throw new Error("The saved task worktree directory escapes extension storage")
		}
		const worktreePath = path.resolve(worktreeParent, taskId)
		if (!isWithin(worktreeParent, worktreePath) || worktreePath === worktreeParent) {
			throw new Error("The saved task worktree path escapes extension storage")
		}
		const realWorktreePath = await fs.realpath(worktreePath).catch(() => {
			throw new Error("The task worktree is missing; it was not restored")
		})
		if (!isWithin(worktreeParent, realWorktreePath))
			throw new Error("The task worktree resolves outside extension storage")
		const workspacePath = path.resolve(realWorktreePath, ...safeRelativePath.split("/").filter(Boolean))
		if (!isWithin(realWorktreePath, workspacePath)) throw new Error("The saved task workspace escapes its worktree")
		const realWorkspacePath = await fs.realpath(workspacePath).catch(() => {
			throw new Error("The task workspace inside its worktree is missing")
		})
		if (!isWithin(realWorktreePath, realWorkspacePath))
			throw new Error("The task workspace resolves outside its worktree")
		const gitRootOutput = await this.git(realWorkspacePath, ["rev-parse", "--show-toplevel"])
		const realGitRoot = await fs.realpath(path.resolve(gitRootOutput.trim()))
		if (path.resolve(realGitRoot) !== path.resolve(realWorktreePath)) {
			throw new Error("The task worktree no longer points to its recorded repository")
		}
		return realWorkspacePath
	}

	private async git(cwd: string, args: string[]): Promise<string> {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			env: process.env,
			encoding: "utf8",
			maxBuffer: MAX_GIT_OUTPUT,
			windowsHide: true,
		})
		return String(stdout)
	}

	private async removeCreatedPath(parent: string, target: string): Promise<void> {
		const resolvedParent = path.resolve(parent)
		const resolvedTarget = path.resolve(target)
		if (!isWithin(resolvedParent, resolvedTarget) || resolvedParent === resolvedTarget) return
		try {
			const stats = await fs.lstat(resolvedTarget)
			if (stats.isSymbolicLink()) {
				await fs.unlink(resolvedTarget)
				return
			}
			await fs.rm(resolvedTarget, { recursive: true, force: true })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
	}

	private async ensureWorkspaceDirectory(worktreePath: string, relativeParts: string[]): Promise<void> {
		let currentPath = worktreePath
		for (const part of relativeParts) {
			currentPath = path.resolve(currentPath, part)
			if (!isWithin(worktreePath, currentPath) || currentPath === worktreePath) {
				throw new Error("The task workspace escaped its Git worktree")
			}
			try {
				await fs.mkdir(currentPath)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			}
			const stats = await fs.lstat(currentPath)
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				throw new Error("The task workspace contains a link or non-directory path inside its Git worktree")
			}
		}
	}

	private async removeWorktree(gitRoot: string, worktreeParent: string, worktreePath: string): Promise<void> {
		try {
			await this.git(gitRoot, ["worktree", "remove", "--force", worktreePath])
		} catch (removeError) {
			await this.removeCreatedPath(worktreeParent, worktreePath)
			try {
				await this.git(gitRoot, ["worktree", "prune"])
			} catch (pruneError) {
				throw new AggregateError([removeError, pruneError], "Unable to remove the task worktree cleanly")
			}
		}
	}
}

export const crossTaskWorktreeService = new CrossTaskWorktreeService()
