import fs from "fs/promises"
import { realpathSync } from "fs"
import os from "os"
import * as path from "path"
import crypto from "crypto"
import EventEmitter from "events"

import simpleGit, { SimpleGit, SimpleGitOptions } from "simple-git"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual } from "../../utils/path"
import { executeRipgrep } from "../../services/search/file-search"
import { t } from "../../i18n"

import { CheckpointDiff, CheckpointResult, CheckpointEventMap } from "./types"
import { getExcludePatterns } from "./excludes"

type CheckpointSimpleGitOptions = Partial<SimpleGitOptions> & {
	unsafe?: NonNullable<SimpleGitOptions["unsafe"]> & {
		allowUnsafeConfigEnvCount?: boolean
		allowUnsafeTemplateDir?: boolean
	}
}

const EXCLUDED_VENV_PATHSPECS = [":(glob).venv", ":(glob).venv/**", ":(glob)**/.venv", ":(glob)**/.venv/**"] as const

/**
 * Creates a SimpleGit instance with sanitized environment variables to prevent
 * interference from inherited git environment variables like GIT_DIR and GIT_WORK_TREE.
 * This ensures checkpoint operations always target the intended shadow repository.
 *
 * @param baseDir - The directory where git operations should be executed
 * @returns A SimpleGit instance with sanitized environment
 */
function createSanitizedGit(baseDir: string): SimpleGit {
	// Create a clean environment by explicitly unsetting git-related environment variables
	// that could interfere with checkpoint operations
	const sanitizedEnv: Record<string, string> = {}
	const removedVars: string[] = []

	// Copy all environment variables except git-specific ones
	for (const [key, value] of Object.entries(process.env)) {
		// Skip git environment variables that would override repository location
		// or inject process-level Git config into checkpoint operations.
		if (
			key === "GIT_DIR" ||
			key === "GIT_WORK_TREE" ||
			key === "GIT_INDEX_FILE" ||
			key === "GIT_OBJECT_DIRECTORY" ||
			key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
			key === "GIT_CEILING_DIRECTORIES" ||
			key === "GIT_TEMPLATE_DIR" ||
			key === "GIT_CONFIG_COUNT" ||
			key === "GIT_CONFIG_PARAMETERS" ||
			/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
		) {
			removedVars.push(key)
			continue
		}

		// Only include defined values
		if (value !== undefined) {
			sanitizedEnv[key] = value
		}
	}

	// Log which git env vars were removed (helps with debugging Dev Container issues)
	if (removedVars.length > 0) {
		console.log(
			`[createSanitizedGit] Removed git environment variables for checkpoint isolation: ${removedVars.join(", ")}`,
		)
	}

	const options: CheckpointSimpleGitOptions = {
		baseDir,
		config: [],
		unsafe: {
			allowUnsafeConfigEnvCount: true,
			allowUnsafeTemplateDir: true,
		},
	}

	// Create git instance and set the sanitized environment
	const git = simpleGit(options)

	// Use the .env() method to set the complete sanitized environment
	// This replaces the inherited environment with our sanitized version
	git.env(sanitizedEnv)

	console.log(`[createSanitizedGit] Created git instance for baseDir: ${baseDir}`)

	return git
}

export abstract class ShadowCheckpointService extends EventEmitter {
	public readonly taskId: string
	public readonly checkpointsDir: string
	public readonly workspaceDir: string

	protected _checkpoints: string[] = []
	protected _baseHash?: string

	protected readonly dotGitDir: string
	protected git?: SimpleGit
	protected readonly log: (message: string) => void
	protected shadowGitConfigWorktree?: string
	private checkpointOperationTail: Promise<void> = Promise.resolve()

	public get baseHash() {
		return this._baseHash
	}

	protected set baseHash(value: string | undefined) {
		this._baseHash = value
	}

	public get isInitialized() {
		return !!this.git
	}

	public getCheckpoints(): string[] {
		return this._checkpoints.slice()
	}

	constructor(taskId: string, checkpointsDir: string, workspaceDir: string, log: (message: string) => void) {
		super()

		const homedir = os.homedir()
		const desktopPath = path.join(homedir, "Desktop")
		const documentsPath = path.join(homedir, "Documents")
		const downloadsPath = path.join(homedir, "Downloads")
		const protectedPaths = [homedir, desktopPath, documentsPath, downloadsPath]
		let canonicalWorkspaceDir: string
		try {
			canonicalWorkspaceDir = realpathSync.native(path.resolve(workspaceDir))
		} catch {
			throw new Error(`Cannot use checkpoints in ${workspaceDir}`)
		}
		const canonicalProtectedPaths = protectedPaths.map((protectedPath) => {
			try {
				return realpathSync.native(path.resolve(protectedPath))
			} catch {
				return path.resolve(protectedPath)
			}
		})
		const filesystemRoot = path.parse(canonicalWorkspaceDir).root

		if (
			arePathsEqual(canonicalWorkspaceDir, filesystemRoot) ||
			canonicalProtectedPaths.some((protectedPath) => arePathsEqual(protectedPath, canonicalWorkspaceDir))
		) {
			throw new Error(`Cannot use checkpoints in ${workspaceDir}`)
		}

		this.taskId = taskId
		this.checkpointsDir = checkpointsDir
		this.workspaceDir = workspaceDir

		this.dotGitDir = path.join(this.checkpointsDir, ".git")
		this.log = log
	}

	public async initShadowGit(onInit?: () => Promise<void>) {
		if (this.git) {
			throw new Error("Shadow git repo already initialized")
		}

		const nestedGitPath = await this.getNestedGitRepository()

		if (nestedGitPath) {
			// Show persistent error message with the offending path
			const relativePath = path.relative(this.workspaceDir, nestedGitPath)
			const message = t("common:errors.nested_git_repos_warning", { path: relativePath })
			vscode.window.showErrorMessage(message)

			throw new Error(
				`Checkpoints are disabled because a nested git repository was detected at: ${relativePath}. ` +
					"Please remove or relocate nested git repositories to use the checkpoints feature.",
			)
		}

		await fs.mkdir(this.checkpointsDir, { recursive: true })
		const git = createSanitizedGit(this.checkpointsDir)
		const gitVersion = await git.version()
		this.log(`[${this.constructor.name}#create] git = ${gitVersion}`)

		let created = false
		const startTime = Date.now()

		if (await fileExistsAtPath(this.dotGitDir)) {
			this.log(`[${this.constructor.name}#initShadowGit] shadow git repo already exists at ${this.dotGitDir}`)
			const worktree = await this.getShadowGitConfigWorktree(git)

			if (!worktree) {
				throw new Error("Checkpoints require core.worktree to be set in the shadow git config")
			}

			const worktreeTrimmed = worktree.trim()

			if (!arePathsEqual(worktreeTrimmed, this.workspaceDir)) {
				throw new Error(
					`Checkpoints can only be used in the original workspace: ${worktreeTrimmed} !== ${this.workspaceDir}`,
				)
			}

			await this.writeExcludeFile()
			await this.migrateTrackedExcludes(git)
			this.baseHash = await git.revparse(["HEAD"])
		} else {
			this.log(`[${this.constructor.name}#initShadowGit] creating shadow git repo at ${this.checkpointsDir}`)
			await git.init({ "--template": "" })
			await git.addConfig("core.worktree", this.workspaceDir) // Sets the working tree to the current workspace.
			await git.addConfig("commit.gpgSign", "false") // Disable commit signing for shadow repo.
			await git.addConfig("user.name", "Alpha")
			await git.addConfig("user.email", "noreply@example.com")
			await this.writeExcludeFile()
			await this.stageAll(git)
			const { commit } = await git.commit("initial commit", { "--allow-empty": null })
			this.baseHash = commit
			created = true
		}

		const duration = Date.now() - startTime

		this.log(
			`[${this.constructor.name}#initShadowGit] initialized shadow repo with base commit ${this.baseHash} in ${duration}ms`,
		)

		this.git = git

		await onInit?.()

		this.emit("initialize", {
			type: "initialize",
			workspaceDir: this.workspaceDir,
			baseHash: this.baseHash,
			created,
			duration,
		})

		return { created, duration }
	}

	// Add basic excludes directly in git config, while respecting any
	// .gitignore in the workspace.
	// .git/info/exclude is local to the shadow git repo, so it's not
	// shared with the main repo - and won't conflict with user's
	// .gitignore.
	protected async writeExcludeFile() {
		await fs.mkdir(path.join(this.dotGitDir, "info"), { recursive: true })
		const patterns = await getExcludePatterns(this.workspaceDir)
		await fs.writeFile(path.join(this.dotGitDir, "info", "exclude"), patterns.join("\n"))
	}

	private async stageAll(git: SimpleGit) {
		try {
			await git.add([".", "--ignore-errors"])
		} catch (error) {
			const normalizedError = error instanceof Error ? error : new Error(String(error))
			this.log(`[${this.constructor.name}#stageAll] failed to add files to git: ${normalizedError.message}`)
			throw normalizedError
		}
	}

	private async migrateTrackedExcludes(git: SimpleGit): Promise<void> {
		// A failed add can leave this private index partially staged. Rebuild it
		// from the last complete checkpoint before applying exclusion migrations.
		await git.raw(["read-tree", "HEAD"])

		const trackedVenvPaths = await git.raw(["ls-files", "-z", "--", ...EXCLUDED_VENV_PATHSPECS])
		if (!trackedVenvPaths) {
			return
		}

		// Remove dependency environments from the shadow index only. The user's
		// workspace remains untouched and the new exclude prevents re-staging.
		await git.raw(["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", ...EXCLUDED_VENV_PATHSPECS])

		const stagedChanges = await git.diffSummary(["--cached"])
		const unexpectedChanges = stagedChanges.files.filter(({ file }) => !file.split(/[\\/]/).includes(".venv"))
		if (unexpectedChanges.length > 0) {
			throw new Error(
				`Checkpoint exclusion migration staged unexpected paths: ${unexpectedChanges
					.map(({ file }) => file)
					.join(", ")}`,
			)
		}

		const { commit } = await git.commit("Update checkpoint exclusions")
		if (!commit) {
			throw new Error("Checkpoint exclusion migration did not create a commit")
		}

		this.log(
			`[${this.constructor.name}#migrateTrackedExcludes] removed ${stagedChanges.files.length} tracked .venv path(s) from the shadow repository`,
		)
	}

	private async getNestedGitRepository(): Promise<string | null> {
		try {
			// Find all .git/HEAD files that are not at the root level.
			const args = [
				"--files",
				"--hidden",
				"--follow",
				"-g",
				"**/.git/HEAD",
				"-g",
				"!**/.venv/**",
				this.workspaceDir,
			]

			const gitPaths = await executeRipgrep({ args, workspacePath: this.workspaceDir })

			// Filter to only include nested git directories (not the root .git).
			// Since we're searching for HEAD files, we expect type to be "file"
			const nestedGitPaths = gitPaths.filter(({ type, path: filePath }) => {
				// Check if it's a file and is a nested .git/HEAD (not at root)
				if (type !== "file") return false

				// Ensure it's a .git/HEAD file and not the root one
				const normalizedPath = filePath.replace(/\\/g, "/")
				return (
					normalizedPath.includes(".git/HEAD") &&
					!normalizedPath.startsWith(".git/") &&
					normalizedPath !== ".git/HEAD"
				)
			})

			if (nestedGitPaths.length > 0) {
				// Get the first nested git repository path
				// Remove .git/HEAD from the path to get the repository directory
				const headPath = nestedGitPaths[0].path

				// Use path module to properly extract the repository directory
				// The HEAD file is at .git/HEAD, so we need to go up two directories
				const gitDir = path.dirname(headPath) // removes HEAD, gives us .git
				const repoDir = path.dirname(gitDir) // removes .git, gives us the repo directory

				const absolutePath = path.join(this.workspaceDir, repoDir)

				this.log(
					`[${this.constructor.name}#getNestedGitRepository] found ${nestedGitPaths.length} nested git repositories, first at: ${repoDir}`,
				)
				return absolutePath
			}

			return null
		} catch (error) {
			this.log(
				`[${this.constructor.name}#getNestedGitRepository] failed to check for nested git repos: ${error instanceof Error ? error.message : String(error)}`,
			)

			throw new Error("Unable to verify that the workspace contains no nested Git repositories", {
				cause: error,
			})
		}
	}

	private async getShadowGitConfigWorktree(git: SimpleGit) {
		if (!this.shadowGitConfigWorktree) {
			try {
				this.shadowGitConfigWorktree = (await git.getConfig("core.worktree")).value || undefined
			} catch (error) {
				this.log(
					`[${this.constructor.name}#getShadowGitConfigWorktree] failed to get core.worktree: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		return this.shadowGitConfigWorktree
	}

	private enqueueCheckpointOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.checkpointOperationTail.then(operation, operation)
		this.checkpointOperationTail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	public saveCheckpoint(
		message: string,
		options?: { allowEmpty?: boolean; suppressMessage?: boolean },
	): Promise<CheckpointResult | undefined> {
		return this.enqueueCheckpointOperation(() => this.saveCheckpointTransaction(message, options))
	}

	private async saveCheckpointTransaction(
		message: string,
		options?: { allowEmpty?: boolean; suppressMessage?: boolean },
	): Promise<CheckpointResult | undefined> {
		try {
			this.log(
				`[${this.constructor.name}#saveCheckpoint] starting checkpoint save (allowEmpty: ${options?.allowEmpty ?? false})`,
			)

			if (!this.git) {
				throw new Error("Shadow git repo not initialized")
			}

			const startTime = Date.now()
			await this.stageAll(this.git)

			if (!options?.allowEmpty) {
				const stagedChanges = await this.git.diffSummary(["--cached"])
				if (stagedChanges.files.length === 0) {
					const duration = Date.now() - startTime
					this.log(
						`[${this.constructor.name}#saveCheckpoint] found no staged changes after ${duration}ms; skipping checkpoint commit`,
					)
					return undefined
				}
			}

			const commitArgs = options?.allowEmpty ? { "--allow-empty": null } : undefined
			const result = await this.git.commit(message, commitArgs)
			const fromHash = this._checkpoints[this._checkpoints.length - 1] ?? this.baseHash!
			const toHash = result.commit || fromHash
			const duration = Date.now() - startTime

			if (result.commit) {
				this._checkpoints.push(toHash)
				this.emit("checkpoint", {
					type: "checkpoint",
					fromHash,
					toHash,
					duration,
					suppressMessage: options?.suppressMessage ?? false,
				})
			}

			if (result.commit) {
				this.log(
					`[${this.constructor.name}#saveCheckpoint] checkpoint saved in ${duration}ms -> ${result.commit}`,
				)
				return result
			} else {
				this.log(`[${this.constructor.name}#saveCheckpoint] found no changes to commit in ${duration}ms`)
				return undefined
			}
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			this.log(`[${this.constructor.name}#saveCheckpoint] failed to create checkpoint: ${error.message}`)
			this.emitCheckpointError(error)
			throw error
		}
	}

	public restoreCheckpoint(commitHash: string): Promise<void> {
		return this.enqueueCheckpointOperation(() => this.restoreCheckpointTransaction(commitHash))
	}

	private async restoreCheckpointTransaction(commitHash: string) {
		try {
			this.log(`[${this.constructor.name}#restoreCheckpoint] starting checkpoint restore`)

			if (!this.git) {
				throw new Error("Shadow git repo not initialized")
			}

			const start = Date.now()
			await this.git.clean("f", ["-d", "-f"])
			await this.git.reset(["--hard", commitHash])

			// Remove all checkpoints after the specified commitHash.
			const checkpointIndex = this._checkpoints.indexOf(commitHash)

			if (checkpointIndex !== -1) {
				this._checkpoints = this._checkpoints.slice(0, checkpointIndex + 1)
			}

			const duration = Date.now() - start
			this.emit("restore", { type: "restore", commitHash, duration })
			this.log(`[${this.constructor.name}#restoreCheckpoint] restored checkpoint ${commitHash} in ${duration}ms`)
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			this.log(`[${this.constructor.name}#restoreCheckpoint] failed to restore checkpoint: ${error.message}`)
			this.emitCheckpointError(error)
			throw error
		}
	}

	public getDiff({ from, to }: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
		return this.enqueueCheckpointOperation(() => this.getDiffTransaction({ from, to }))
	}

	private async readCurrentDiffContent(git: SimpleGit, relativePath: string, absolutePath: string): Promise<string> {
		try {
			const stats = await fs.lstat(absolutePath)
			return stats.isSymbolicLink()
				? await git.show([`:${relativePath}`])
				: await fs.readFile(absolutePath, "utf8")
		} catch {
			return ""
		}
	}

	private async getDiffTransaction({ from, to }: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
		if (!this.git) {
			throw new Error("Shadow git repo not initialized")
		}

		const result = []

		if (!from) {
			from = (await this.git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim()
		}

		// Stage all changes so that untracked files appear in diff summary.
		await this.stageAll(this.git)

		this.log(`[${this.constructor.name}#getDiff] diffing ${to ? `${from}..${to}` : `${from}..HEAD`}`)
		const { files } = to ? await this.git.diffSummary([`${from}..${to}`]) : await this.git.diffSummary([from])

		const cwdPath = (await this.getShadowGitConfigWorktree(this.git)) || this.workspaceDir || ""

		for (const file of files) {
			const relPath = file.file
			const absPath = path.join(cwdPath, relPath)
			const before = await this.git.show([`${from}:${relPath}`]).catch(() => "")

			const after = to
				? await this.git.show([`${to}:${relPath}`]).catch(() => "")
				: await this.readCurrentDiffContent(this.git, relPath, absPath)

			result.push({ paths: { relative: relPath, absolute: absPath }, content: { before, after } })
		}

		return result
	}

	/**
	 * EventEmitter
	 */

	private emitCheckpointError(error: Error): void {
		// Node treats an unhandled "error" event as a new exception. Preserve the
		// original Git error when the UI has not registered an observer yet.
		if (this.listenerCount("error") > 0) {
			this.emit("error", { type: "error", error })
		}
	}

	override emit<K extends keyof CheckpointEventMap>(event: K, data: CheckpointEventMap[K]) {
		return super.emit(event, data)
	}

	override on<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.on(event, listener)
	}

	override off<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.off(event, listener)
	}

	override once<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.once(event, listener)
	}

	/**
	 * Storage
	 */

	public static hashWorkspaceDir(workspaceDir: string) {
		return crypto.createHash("sha256").update(workspaceDir).digest("hex").toString().slice(0, 8)
	}

	protected static taskRepoDir({ taskId, globalStorageDir }: { taskId: string; globalStorageDir: string }) {
		return path.join(globalStorageDir, "tasks", taskId, "checkpoints")
	}

	protected static workspaceRepoDir({
		globalStorageDir,
		workspaceDir,
	}: {
		globalStorageDir: string
		workspaceDir: string
	}) {
		return path.join(globalStorageDir, "checkpoints", this.hashWorkspaceDir(workspaceDir))
	}

	public static async deleteTask({
		taskId,
		globalStorageDir,
		workspaceDir,
	}: {
		taskId: string
		globalStorageDir: string
		workspaceDir: string
	}) {
		const workspaceRepoDir = this.workspaceRepoDir({ globalStorageDir, workspaceDir })
		const branchName = `roo-${taskId}`
		const git = createSanitizedGit(workspaceRepoDir)
		const success = await this.deleteBranch(git, branchName)

		if (success) {
			console.log(`[${this.name}#deleteTask.${taskId}] deleted branch ${branchName}`)
		} else {
			console.error(`[${this.name}#deleteTask.${taskId}] failed to delete branch ${branchName}`)
		}
	}

	public static async deleteBranch(git: SimpleGit, branchName: string) {
		const branches = await git.branchLocal()

		if (!branches.all.includes(branchName)) {
			console.error(`[${this.constructor.name}#deleteBranch] branch ${branchName} does not exist`)
			return false
		}

		const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"])

		if (currentBranch === branchName) {
			const worktree = await git.getConfig("core.worktree")

			try {
				await git.raw(["config", "--unset", "core.worktree"])
				await git.reset(["--hard"])
				await git.clean("f", ["-d"])
				const defaultBranch = branches.all.includes("main") ? "main" : "master"
				await git.checkout([defaultBranch, "--force"])

				await pWaitFor(
					async () => {
						const newBranch = await git.revparse(["--abbrev-ref", "HEAD"])
						return newBranch === defaultBranch
					},
					{ interval: 500, timeout: 2_000 },
				)

				await git.branch(["-D", branchName])
				return true
			} catch (error) {
				console.error(
					`[${this.constructor.name}#deleteBranch] failed to delete branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`,
				)

				return false
			} finally {
				if (worktree.value) {
					await git.addConfig("core.worktree", worktree.value)
				}
			}
		} else {
			await git.branch(["-D", branchName])
			return true
		}
	}
}
