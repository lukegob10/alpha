import { execFile } from "child_process"
import crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { worktreeIncludeService } from "./worktree-include.js"

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 100 * 1024 * 1024
// Managed storage can exceed MAX_PATH even when every path component is valid.
// Override only our Git invocations; never change the user's repository/global config.
const GIT_PLATFORM_ARGS = process.platform === "win32" ? ["-c", "core.longpaths=true"] : []
// Git for Windows 2.43 reserves 40 characters from its 260-character startup path
// limit before loading core.longpaths. This conservative reserve is host-derived.
const MAX_GIT_SETUP_PATH = 260 - 40
const GLOB_PATTERN = /[*?[\]{}!]/
// Match the extension's bounded atomic-replacement allowance: six attempts, 775 ms total backoff.
const METADATA_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

export interface ValidatedWorkerScope {
	gitRoot: string
	logicalWorkspace: string
	logicalWorkspaceFromRoot: string
	writeScope: string[]
	gitRelativeScope: string[]
	fileWriteScope: string[]
	gitRelativeFileScope: string[]
}

export interface ManagedWorkerChange {
	status: string
	path: string
	previousPath?: string
	beforeHash?: string
	afterHash?: string
	beforeMode?: string
	afterMode?: string
	beforeFile?: string
	afterFile?: string
	binary: boolean
}

export interface ManagedWorkerArtifact {
	id: string
	taskId: string
	status: "active" | "pending_review" | "conflicted" | "applied" | "discarded" | "scope_violation"
	createdAt: number
	updatedAt: number
	gitRoot: string
	logicalWorkspace: string
	logicalWorkspaceFromRoot: string
	worktreePath?: string
	baselineCommit: string
	resultCommit?: string
	writeScope: string[]
	gitRelativeScope: string[]
	fileWriteScope: string[]
	gitRelativeFileScope: string[]
	patchFile?: string
	changes: ManagedWorkerChange[]
	partial?: boolean
	conflictPaths?: string[]
	error?: string
}

export interface PreparedManagedWorktree {
	artifact: ManagedWorkerArtifact
	workspacePath: string
}

export interface ApplyManagedWorktreeResult {
	status: "applied" | "conflicted"
	conflictPaths?: string[]
}

export interface ManagedWorkerRecoveryOptions {
	/** Registered task ownership outlives terminal state when process cleanup needs retrying. */
	hasTaskOwner?: (taskId: string) => boolean
}

const normalizeRelative = (value: string): string => value.split(path.sep).join("/").replace(/^\.\//, "")

const isWithin = (root: string, candidate: string): boolean => {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const samePath = (left: string, right: string): boolean =>
	process.platform === "win32"
		? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
		: path.resolve(left) === path.resolve(right)

interface GitPathInvocation {
	cwd: string
	args: string[]
	env?: NodeJS.ProcessEnv
	prefix: string[]
	ownerDirectory?: string
	ownerIdentity?: { dev: bigint; ino: bigint }
	links: Array<{ link: string; target: string }>
	commonDir?: string
	addedWorktree?: string
}

class GitPathCleanupError extends AggregateError {
	constructor(
		errors: unknown[],
		readonly invocation: GitPathInvocation,
		message: string,
	) {
		super(errors, `${message}; recovery owner: ${invocation.ownerDirectory}`)
	}
}

class GitStartupPathCleanupError extends GitPathCleanupError {
	constructor(errors: unknown[], invocation: GitPathInvocation) {
		super(errors, invocation, "Git startup failed and registered path cleanup is unconfirmed")
	}
}

/** Native, platform-neutral quarantine lifecycle for one editing sub-agent. */
export class ManagedSubagentWorktreeService {
	private async readGitPathFile(file: string): Promise<string> {
		if ((await fs.stat(file)).size > 64 * 1024) throw new Error(`Invalid Git path file: ${file}`)
		return (await fs.readFile(file, "utf8")).trim()
	}

	private async resolveGitPaths(
		cwd: string,
		explicitGitDir?: string,
	): Promise<{ root?: string; gitDir: string; commonDir: string }> {
		let root: string | undefined
		let gitDir = explicitGitDir
		if (!gitDir) {
			let candidate = path.resolve(cwd)
			while (true) {
				const marker = path.join(candidate, ".git")
				try {
					const stat = await fs.stat(marker)
					if (stat.isDirectory()) gitDir = marker
					else {
						const value = await this.readGitPathFile(marker)
						if (!value.startsWith("gitdir: ")) throw new Error(`Invalid Git worktree marker: ${marker}`)
						gitDir = path.resolve(candidate, value.slice("gitdir: ".length))
					}
					root = await fs.realpath(candidate)
					break
				} catch (error) {
					const code = (error as NodeJS.ErrnoException | undefined)?.code
					if (code !== "ENOENT" && code !== "ENOTDIR") throw error
					const parent = path.dirname(candidate)
					if (parent === candidate) throw new Error(`Not a Git repository: ${cwd}`)
					candidate = parent
				}
			}
		}
		gitDir = await fs.realpath(path.resolve(cwd, gitDir))
		let commonDir = gitDir
		try {
			commonDir = await fs.realpath(
				path.resolve(gitDir, await this.readGitPathFile(path.join(gitDir, "commondir"))),
			)
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
		}
		return { root, gitDir, commonDir }
	}

	private async releaseGitPaths(invocation: GitPathInvocation): Promise<void> {
		if (!invocation.ownerDirectory) return
		try {
			const owner = await fs.lstat(invocation.ownerDirectory, { bigint: true })
			if (
				!owner.isDirectory() ||
				owner.isSymbolicLink() ||
				owner.dev !== invocation.ownerIdentity?.dev ||
				owner.ino !== invocation.ownerIdentity?.ino
			) {
				throw new Error(`Temporary Git directory ownership changed: ${invocation.ownerDirectory}`)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return
			throw new GitPathCleanupError([error], invocation, "Temporary Git directory cleanup is unconfirmed")
		}
		const errors: unknown[] = []
		for (const { link, target } of [...invocation.links].reverse()) {
			try {
				const stat = await fs.lstat(link)
				const linkedTarget = await fs.readlink(link)
				if (
					!stat.isSymbolicLink() ||
					path.toNamespacedPath(linkedTarget).toLowerCase() !== path.toNamespacedPath(target).toLowerCase()
				) {
					throw new Error(`Temporary Git junction ownership changed: ${link}`)
				}
				// Unlink only the junction. Never recurse through its physical target.
				await fs.unlink(link)
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") errors.push(error)
			}
		}
		if (errors.length === 0) {
			try {
				await fs
					.unlink(path.join(invocation.ownerDirectory, "owner.json"))
					.catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error
					})
				await fs.rmdir(invocation.ownerDirectory).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error
				})
			} catch (error) {
				errors.push(error)
			}
		}
		if (errors.length > 0) {
			throw new GitPathCleanupError(errors, invocation, "Temporary Git path cleanup is unconfirmed")
		}
	}

	private async prepareGitPaths(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitPathInvocation> {
		const invocation: GitPathInvocation = { cwd, args, env, prefix: [], links: [] }
		const addedWorktree =
			args[0] === "worktree" && args[1] === "add" && args[2] === "--detach" ? args[3] : undefined
		if (
			process.platform !== "win32" ||
			![cwd, env?.GIT_WORK_TREE, addedWorktree].some((value) => value && value.length >= MAX_GIT_SETUP_PATH)
		)
			return invocation
		const explicitGitDir = args.find((arg) => arg.startsWith("--git-dir="))?.slice("--git-dir=".length)
		const paths = await this.resolveGitPaths(cwd, explicitGitDir)
		const ownerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worker-git-"))
		invocation.ownerDirectory = ownerDirectory
		try {
			const owner = await fs.lstat(ownerDirectory, { bigint: true })
			invocation.ownerIdentity = { dev: owner.dev, ino: owner.ino }
			await fs.writeFile(
				path.join(ownerDirectory, "owner.json"),
				JSON.stringify({ kind: "managed-worker-git-paths", cwd, worktree: env?.GIT_WORK_TREE, addedWorktree }),
				"utf8",
			)
			if (path.join(ownerDirectory, "repository", "worktrees", "x".repeat(36)).length >= MAX_GIT_SETUP_PATH) {
				throw new Error(`The temporary directory is too long for Git repository setup: ${ownerDirectory}`)
			}
			const alias = async (target: string, name: string): Promise<string> => {
				const physical = await fs.realpath(target)
				const link = path.join(ownerDirectory, name)
				await fs.symlink(physical, link, "junction")
				invocation.links.push({ link, target: physical })
				if (!samePath(await fs.realpath(link), physical))
					throw new Error(`Temporary Git junction target changed: ${link}`)
				return link
			}
			let gitDir = paths.gitDir
			if (gitDir.length >= MAX_GIT_SETUP_PATH) {
				if (!isWithin(paths.commonDir, gitDir))
					throw new Error("Linked Git administration is outside its common directory")
				gitDir = path.join(await alias(paths.commonDir, "repository"), path.relative(paths.commonDir, gitDir))
			}
			const sourceRoot =
				paths.root && paths.root.length >= MAX_GIT_SETUP_PATH ? await alias(paths.root, "worktree") : paths.root
			const worktree = env?.GIT_WORK_TREE ?? paths.root
			const worktreeAlias =
				worktree && paths.root && samePath(worktree, paths.root)
					? sourceRoot
					: worktree && worktree.length >= MAX_GIT_SETUP_PATH
						? await alias(worktree, "result")
						: worktree
			// Keep the native repository-relative prefix for scoped callers. Temporary
			// paths adapt native Git startup; they do not change the logical Git cwd.
			invocation.cwd =
				sourceRoot && paths.root
					? path.join(sourceRoot, path.relative(paths.root, await fs.realpath(cwd)))
					: ownerDirectory
			invocation.prefix = [`--git-dir=${gitDir}`]
			if (worktreeAlias) invocation.prefix.push(`--work-tree=${worktreeAlias}`)
			invocation.env = env?.GIT_WORK_TREE ? { ...env, GIT_WORK_TREE: worktreeAlias } : env
			invocation.args = args.map((arg) => (arg.startsWith("--git-dir=") ? `--git-dir=${gitDir}` : arg))
			if (addedWorktree) {
				const bucket = await alias(path.dirname(addedWorktree), "target")
				invocation.args = [...invocation.args]
				invocation.args[3] = path.join(bucket, path.basename(addedWorktree))
				invocation.commonDir = paths.commonDir
				invocation.addedWorktree = addedWorktree
			}
			return invocation
		} catch (error) {
			try {
				await this.releaseGitPaths(invocation)
			} catch (cleanupError) {
				throw new GitPathCleanupError(
					[error, cleanupError],
					invocation,
					"Git path preparation failed and cleanup is unconfirmed",
				)
			}
			throw error
		}
	}

	private async physicalizeWorktreeRegistration(invocation: GitPathInvocation): Promise<void> {
		if (!invocation.addedWorktree || !invocation.commonDir) return
		const physicalWorktree = invocation.addedWorktree
		const marker = path.join(physicalWorktree, ".git")
		if (!(await fs.lstat(marker)).isFile())
			throw new Error(`Managed worktree marker is not an owned regular file: ${marker}`)
		const markerValue = await this.readGitPathFile(marker)
		if (!markerValue.startsWith("gitdir: ")) throw new Error(`Invalid managed worktree marker: ${marker}`)
		const admin = await fs.realpath(path.resolve(physicalWorktree, markerValue.slice("gitdir: ".length)))
		if (!isWithin(path.join(invocation.commonDir, "worktrees"), admin))
			throw new Error("Managed worktree administration escaped its owning repository")
		const registration = path.join(admin, "gitdir")
		if (
			!(await fs.lstat(registration)).isFile() ||
			!samePath(await fs.realpath(await this.readGitPathFile(registration)), await fs.realpath(marker))
		) {
			throw new Error("Managed worktree registration no longer belongs to its startup target")
		}
		// These two files are startup-owned. No invocation alias may outlive startup.
		if (!samePath(path.resolve(physicalWorktree, markerValue.slice("gitdir: ".length)), admin))
			await fs.writeFile(marker, `gitdir: ${admin}\n`, "utf8")
		if (!samePath(await this.readGitPathFile(registration), marker))
			await fs.writeFile(registration, `${marker}\n`, "utf8")
	}

	private async invokeGit(
		cwd: string,
		args: string[],
		env: NodeJS.ProcessEnv | undefined,
		buffer: boolean,
	): Promise<string | Buffer> {
		const invocation = await this.prepareGitPaths(cwd, args, env)
		const execute = async (commandArgs: string[], asBuffer = false): Promise<string | Buffer> => {
			const command = [...GIT_PLATFORM_ARGS, ...invocation.prefix, ...commandArgs]
			const options = {
				cwd: invocation.cwd,
				env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
				maxBuffer: MAX_GIT_OUTPUT,
				windowsHide: true,
			}
			return asBuffer
				? (await execFileAsync("git", command, { ...options, encoding: "buffer" })).stdout
				: (await execFileAsync("git", command, { ...options, encoding: "utf8" })).stdout
		}
		let failure: unknown
		let failed = false
		let output: string | Buffer = ""
		let retainPaths = false
		try {
			let stdout = await execute(invocation.args, buffer)
			if (invocation.addedWorktree && invocation.commonDir) {
				const physicalWorktree = invocation.addedWorktree
				await this.physicalizeWorktreeRegistration(invocation)
				await execute(["worktree", "repair", physicalWorktree])
				await this.physicalizeWorktreeRegistration(invocation)
				const listed = String(await execute(["worktree", "list", "--porcelain", "-z"]))
				if (
					!listed
						.split("\0")
						.some(
							(entry) =>
								entry.startsWith("worktree ") &&
								samePath(entry.slice("worktree ".length), physicalWorktree),
						)
				) {
					throw new Error("Managed worktree physical registration could not be confirmed")
				}
			}
			if (
				invocation.ownerDirectory &&
				!buffer &&
				args[0] === "rev-parse" &&
				args.some((arg) =>
					["--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--git-dir"].includes(arg),
				)
			) {
				const value = String(stdout)
				stdout = `${await fs.realpath(path.resolve(invocation.cwd, value.trim()))}${value.endsWith("\n") ? "\n" : ""}`
			}
			output = stdout
		} catch (error) {
			failed = true
			failure = error
			if (invocation.addedWorktree) {
				try {
					// Roll back while an unrepaired Git registration can still reach its
					// invocation-owned target. Physical-path removal cannot match that alias.
					const target = invocation.args[3]!
					const listed = String(await execute(["worktree", "list", "--porcelain", "-z"]))
					const registered = listed
						.split("\0")
						.find(
							(entry) =>
								entry.startsWith("worktree ") &&
								[target, invocation.addedWorktree!].some((owned) =>
									samePath(entry.slice("worktree ".length), owned),
								),
						)
					if (registered) {
						await execute(["worktree", "remove", "--force", registered.slice("worktree ".length)])
					}
				} catch (cleanupError) {
					retainPaths = true
					failure = new GitStartupPathCleanupError([error, cleanupError], invocation)
				}
			}
		}
		if (!retainPaths) {
			try {
				if (!retainPaths) await this.releaseGitPaths(invocation)
			} catch (cleanupError) {
				failure = failed
					? new GitPathCleanupError(
							[failure, cleanupError],
							invocation,
							"Git failed and temporary path cleanup is unconfirmed",
						)
					: cleanupError
				failed = true
			}
		}
		if (failed) throw failure
		return output
	}

	private async git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
		return String(await this.invokeGit(cwd, args, env, false))
	}

	private async gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
		const stdout = await this.invokeGit(cwd, args, undefined, true)
		return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
	}

	private async hasRegisteredWorktree(
		gitRoot: string,
		worktreePath: string,
		prefix: string[] = [],
	): Promise<boolean> {
		const output = await this.git(gitRoot, [...prefix, "worktree", "list", "--porcelain", "-z"])
		for (const entry of output.split("\0")) {
			if (!entry.startsWith("worktree ")) continue
			const listed = entry.slice("worktree ".length)
			if (samePath(listed, worktreePath)) return true
			try {
				if (samePath(await fs.realpath(listed), await fs.realpath(worktreePath))) return true
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
			}
		}
		return false
	}

	private artifactDir(storagePath: string, artifactId: string): string {
		return path.join(storagePath, "subagent-change-sets", artifactId)
	}

	private metadataPath(storagePath: string, artifactId: string): string {
		return path.join(this.artifactDir(storagePath, artifactId), "metadata.json")
	}

	private async persist(storagePath: string, artifact: ManagedWorkerArtifact): Promise<void> {
		artifact.updatedAt = Date.now()
		const dir = this.artifactDir(storagePath, artifact.id)
		await fs.mkdir(dir, { recursive: true })
		const metadataPath = this.metadataPath(storagePath, artifact.id)
		const temporaryPath = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`
		try {
			await fs.writeFile(temporaryPath, JSON.stringify(artifact, null, 2), "utf8")
			for (let attempt = 0; ; attempt++) {
				try {
					await fs.rename(temporaryPath, metadataPath)
					break
				} catch (error) {
					const code = (error as NodeJS.ErrnoException | undefined)?.code
					if (
						(code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") ||
						attempt >= METADATA_RETRY_DELAYS_MS.length
					)
						throw error
					// Retry only the same closed temporary file; never remove the committed snapshot.
					await new Promise<void>((resolve) => setTimeout(resolve, METADATA_RETRY_DELAYS_MS[attempt]))
				}
			}
		} finally {
			await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
		}
	}

	async load(storagePath: string, artifactId: string): Promise<ManagedWorkerArtifact> {
		return JSON.parse(
			await fs.readFile(this.metadataPath(storagePath, artifactId), "utf8"),
		) as ManagedWorkerArtifact
	}

	private async resolveArtifactGitCwd(artifact: ManagedWorkerArtifact): Promise<string> {
		for (const candidate of [artifact.gitRoot, artifact.worktreePath]) {
			if (!candidate) continue
			try {
				await fs.access(candidate)
				await this.git(candidate, ["rev-parse", "--git-dir"])
				return candidate
			} catch {
				// A nested Worker records its owning Worker worktree as gitRoot. If
				// cancellation removed that parent layer first, its own linked worktree
				// still has access to the shared object database and can capture safely.
			}
		}
		throw new Error(`Managed Worker ${artifact.taskId} has no reachable Git worktree for change capture`)
	}

	private async resolveWorktreeAdmin(artifact: ManagedWorkerArtifact): Promise<{ cwd: string; prefix: string[] }> {
		try {
			await fs.access(artifact.gitRoot)
			await this.git(artifact.gitRoot, ["rev-parse", "--git-dir"])
			return { cwd: artifact.gitRoot, prefix: [] }
		} catch {
			if (!artifact.worktreePath) throw new Error(`Managed Worker ${artifact.taskId} has no worktree to clean`)
			const commonDirValue = (
				await this.git(artifact.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
			).trim()
			const commonDir = path.isAbsolute(commonDirValue)
				? commonDirValue
				: path.resolve(artifact.worktreePath, commonDirValue)
			return { cwd: path.dirname(commonDir), prefix: [`--git-dir=${commonDir}`] }
		}
	}

	async validateScope(
		workspacePath: string,
		requestedScope: string[],
		options: { allowWorkspaceRoot?: boolean } = {},
	): Promise<ValidatedWorkerScope> {
		if (!Array.isArray(requestedScope) || requestedScope.length < 1 || requestedScope.length > 12) {
			throw new Error("Worker write_scope requires 1 to 12 workspace-relative files or directories")
		}
		const requestedWorkspace = path.resolve(workspacePath)
		const logicalWorkspace = await fs.realpath(requestedWorkspace)
		const gitRoot = await fs.realpath(
			path.resolve((await this.git(logicalWorkspace, ["rev-parse", "--show-toplevel"])).trim()),
		)
		if (!isWithin(gitRoot, logicalWorkspace)) throw new Error("The task workspace is outside its Git root")

		const realWorkspace = await fs.realpath(logicalWorkspace)
		const normalized: string[] = []
		const fileScope = new Set<string>()
		for (const raw of requestedScope) {
			const value = typeof raw === "string" ? raw.trim() : ""
			if (!value) throw new Error("Worker write_scope entries cannot be empty")
			if (value === "." && options.allowWorkspaceRoot && requestedScope.length === 1) {
				normalized.push(".")
				continue
			}
			if (path.isAbsolute(value)) throw new Error(`Worker write_scope must be relative: ${value}`)
			if (GLOB_PATTERN.test(value)) throw new Error(`Worker write_scope does not support globs: ${value}`)
			const segments = normalizeRelative(value).split("/")
			if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
				throw new Error(`Worker write_scope contains traversal: ${value}`)
			}
			if (segments.some((segment) => segment.toLowerCase() === ".git")) {
				throw new Error(`Worker write_scope cannot include .git: ${value}`)
			}

			const resolved = path.resolve(logicalWorkspace, ...segments)
			if (!isWithin(logicalWorkspace, resolved))
				throw new Error(`Worker write_scope escapes the workspace: ${value}`)
			let existing = resolved
			while (true) {
				try {
					const realExisting = await fs.realpath(existing)
					if (!isWithin(realWorkspace, realExisting)) {
						throw new Error(`Worker write_scope follows a symlink outside the workspace: ${value}`)
					}
					break
				} catch (error) {
					if (error instanceof Error && error.message.includes("follows a symlink")) throw error
					const parent = path.dirname(existing)
					if (parent === existing || !isWithin(logicalWorkspace, parent)) throw error
					existing = parent
				}
			}
			const relativeScope = normalizeRelative(path.relative(logicalWorkspace, resolved))
			normalized.push(relativeScope)
			try {
				if (!(await fs.lstat(resolved)).isDirectory()) fileScope.add(relativeScope)
			} catch {
				// A missing path defaults to exact-file authority. Existing directories are
				// the only scopes that recursively authorize descendants.
				fileScope.add(relativeScope)
			}
		}

		const writeScope = [...new Set(normalized)].sort()
		const logicalWorkspaceFromRoot = normalizeRelative(path.relative(gitRoot, logicalWorkspace))
		const gitRelativeScope = writeScope.map((item) => normalizeRelative(path.join(logicalWorkspaceFromRoot, item)))
		const fileWriteScope = [...fileScope].sort()
		const gitRelativeFileScope = fileWriteScope.map((item) =>
			normalizeRelative(path.join(logicalWorkspaceFromRoot, item)),
		)
		return {
			gitRoot,
			logicalWorkspace,
			logicalWorkspaceFromRoot,
			writeScope,
			gitRelativeScope,
			fileWriteScope,
			gitRelativeFileScope,
		}
	}

	async create(
		storagePath: string,
		taskId: string,
		validated: ValidatedWorkerScope,
	): Promise<PreparedManagedWorktree> {
		const artifactId = crypto.randomUUID()
		const dir = this.artifactDir(storagePath, artifactId)
		let worktreePath = path.join(storagePath, "subagent-worktrees", artifactId)
		const indexPath = path.join(dir, "snapshot.index")
		await fs.mkdir(path.dirname(dir), { recursive: true })
		// Exclusive creation establishes ownership before rollback can remove anything.
		await fs.mkdir(dir)
		let artifact: ManagedWorkerArtifact | undefined
		let ownsWorktreePath = false
		let worktreeAdded = false
		try {
			await fs.mkdir(path.dirname(worktreePath), { recursive: true })
			const indexEnv = { GIT_INDEX_FILE: indexPath }
			const parentCommit = (
				await this.git(validated.gitRoot, ["rev-parse", "--verify", "HEAD"]).catch(() => "")
			).trim()
			if (parentCommit) await this.git(validated.gitRoot, ["read-tree", parentCommit], indexEnv)
			await this.git(validated.gitRoot, ["add", "-A"], indexEnv)
			const tree = (await this.git(validated.gitRoot, ["write-tree"], indexEnv)).trim()
			const commitArgs = ["commit-tree", tree]
			if (parentCommit) commitArgs.push("-p", parentCommit)
			commitArgs.push("-m", "Alpha worker baseline")
			const baselineCommit = (
				await this.git(validated.gitRoot, commitArgs, {
					...indexEnv,
					GIT_AUTHOR_NAME: "Alpha",
					GIT_AUTHOR_EMAIL: "alpha@local.invalid",
					GIT_COMMITTER_NAME: "Alpha",
					GIT_COMMITTER_EMAIL: "alpha@local.invalid",
				})
			).trim()
			await fs.rm(indexPath, { force: true })
			const now = Date.now()
			artifact = {
				id: artifactId,
				taskId,
				status: "active",
				createdAt: now,
				updatedAt: now,
				gitRoot: validated.gitRoot,
				logicalWorkspace: validated.logicalWorkspace,
				logicalWorkspaceFromRoot: validated.logicalWorkspaceFromRoot,
				worktreePath,
				baselineCommit,
				writeScope: validated.writeScope,
				gitRelativeScope: validated.gitRelativeScope,
				fileWriteScope: validated.fileWriteScope,
				gitRelativeFileScope: validated.gitRelativeFileScope,
				changes: [],
			}
			// Recent Git for Windows resolves junctions to their physical paths during
			// setup, defeating the invocation adapter's short aliases. Keep durable
			// proposals in extension storage, but allocate an owned short checkout.
			if (process.platform === "win32" && worktreePath.length >= MAX_GIT_SETUP_PATH) {
				worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worker-checkout-"))
				ownsWorktreePath = true
				artifact.worktreePath = worktreePath
				if ((await fs.realpath(worktreePath)).length >= MAX_GIT_SETUP_PATH)
					throw new Error("The temporary directory is too long for a managed Git checkout")
			}
			await this.persist(storagePath, artifact)
			if (!ownsWorktreePath) {
				await fs.mkdir(worktreePath)
				ownsWorktreePath = true
			}
			await this.git(validated.gitRoot, ["worktree", "add", "--detach", worktreePath, baselineCommit])
			worktreeAdded = true
			await this.git(validated.gitRoot, ["worktree", "lock", "--reason", "Alpha editing sub-agent", worktreePath])
			await worktreeIncludeService.copyWorktreeIncludeFiles(validated.gitRoot, worktreePath)
			return {
				artifact,
				workspacePath: path.join(worktreePath, validated.logicalWorkspaceFromRoot),
			}
		} catch (error) {
			try {
				if (error instanceof GitStartupPathCleanupError)
					await this.physicalizeWorktreeRegistration(error.invocation)
				if (ownsWorktreePath && artifact) {
					// A failed `worktree add` can already have registered its target. Check
					// ownership before deleting the directory or discarding recovery metadata.
					const registered =
						worktreeAdded || (await this.hasRegisteredWorktree(validated.gitRoot, worktreePath))
					if (registered) await this.cleanupWorktreeWithRetry(artifact)
					else await fs.rm(worktreePath, { recursive: true, force: true })
				}
				if (error instanceof GitPathCleanupError) await this.releaseGitPaths(error.invocation)
				await fs.rm(dir, { recursive: true, force: true })
			} catch (cleanupError) {
				// Keep an addressable artifact for orphan recovery when cleanup is unproven.
				throw new AggregateError(
					[error, cleanupError],
					`Managed Worker ${taskId} startup failed and owned cleanup could not be confirmed: ${error instanceof Error ? error.message : String(error)}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				)
			}
			throw error
		}
	}

	private parseNameStatus(output: string): Array<{ status: string; path: string; previousPath?: string }> {
		const values = output.split("\0").filter(Boolean)
		const changes: Array<{ status: string; path: string; previousPath?: string }> = []
		for (let index = 0; index < values.length; ) {
			const status = values[index++]!
			if (status.startsWith("R") || status.startsWith("C")) {
				const previousPath = values[index++]!
				const currentPath = values[index++]!
				changes.push({ status, path: currentPath, previousPath })
			} else {
				changes.push({ status, path: values[index++]! })
			}
		}
		return changes
	}

	private pathInScope(candidate: string, scopes: string[], fileScopes: string[]): boolean {
		const normalized = normalizeRelative(candidate)
		return scopes.some(
			(scope) =>
				scope === "." ||
				normalized === scope ||
				(!fileScopes.includes(scope) && normalized.startsWith(`${scope}/`)),
		)
	}

	private async treeEntry(cwd: string, commit: string, filePath: string): Promise<{ mode?: string; hash?: string }> {
		try {
			const output = (await this.git(cwd, ["ls-tree", commit, "--", filePath])).trim()
			const match = /^(\d+)\s+\w+\s+([0-9a-f]+)\t/.exec(output)
			return match ? { mode: match[1], hash: match[2] } : {}
		} catch {
			return {}
		}
	}

	private async writeCommitFile(
		gitRoot: string,
		storagePath: string,
		artifactId: string,
		commit: string,
		filePath: string,
		name: string,
	): Promise<string | undefined> {
		try {
			const target = path.join(this.artifactDir(storagePath, artifactId), name)
			await fs.writeFile(target, await this.gitBuffer(gitRoot, ["show", `${commit}:${filePath}`]))
			return name
		} catch {
			return undefined
		}
	}

	async capture(storagePath: string, artifactId: string, partial = false): Promise<ManagedWorkerArtifact> {
		const artifact = await this.load(storagePath, artifactId)
		if (!artifact.worktreePath) return artifact
		const indexPath = path.join(this.artifactDir(storagePath, artifact.id), "result.index")
		const indexEnv = { GIT_INDEX_FILE: indexPath, GIT_WORK_TREE: artifact.worktreePath }
		let capturePersisted = false
		try {
			const gitCwd = await this.resolveArtifactGitCwd(artifact)
			await fs.rm(indexPath, { force: true })
			await this.git(gitCwd, ["read-tree", artifact.baselineCommit], indexEnv)
			await this.git(gitCwd, ["add", "-A"], indexEnv)
			const tree = (await this.git(gitCwd, ["write-tree"], indexEnv)).trim()
			artifact.resultCommit = (
				await this.git(
					gitCwd,
					["commit-tree", tree, "-p", artifact.baselineCommit, "-m", "Alpha worker result"],
					{
						...indexEnv,
						GIT_AUTHOR_NAME: "Alpha",
						GIT_AUTHOR_EMAIL: "alpha@local.invalid",
						GIT_COMMITTER_NAME: "Alpha",
						GIT_COMMITTER_EMAIL: "alpha@local.invalid",
					},
				)
			).trim()
			const parsed = this.parseNameStatus(
				await this.git(gitCwd, [
					"diff",
					"--name-status",
					"-z",
					"-M",
					artifact.baselineCommit,
					artifact.resultCommit,
				]),
			)
			const violations = parsed
				.flatMap((change) => [change.previousPath, change.path].filter((item): item is string => Boolean(item)))
				.filter(
					(candidate) =>
						!this.pathInScope(candidate, artifact.gitRelativeScope, artifact.gitRelativeFileScope ?? []),
				)
			if (violations.length > 0) {
				artifact.status = "scope_violation"
				artifact.error = `Worker changed paths outside its write scope: ${[...new Set(violations)].join(", ")}`
				artifact.partial = partial
				await this.persist(storagePath, artifact)
				capturePersisted = true
				return artifact
			}

			artifact.changes = []
			for (let index = 0; index < parsed.length; index++) {
				const change = parsed[index]!
				const beforePath = change.previousPath ?? change.path
				const before = await this.treeEntry(gitCwd, artifact.baselineCommit, beforePath)
				const after = await this.treeEntry(gitCwd, artifact.resultCommit, change.path)
				const binary = Boolean(
					(
						await this.git(gitCwd, [
							"diff",
							"--numstat",
							artifact.baselineCommit,
							artifact.resultCommit,
							"--",
							beforePath,
							change.path,
						])
					).includes("-\t-"),
				)
				artifact.changes.push({
					...change,
					beforeHash: before.hash,
					afterHash: after.hash,
					beforeMode: before.mode,
					afterMode: after.mode,
					beforeFile: before.hash
						? await this.writeCommitFile(
								gitCwd,
								storagePath,
								artifact.id,
								artifact.baselineCommit,
								beforePath,
								`${index}-before`,
							)
						: undefined,
					afterFile: after.hash
						? await this.writeCommitFile(
								gitCwd,
								storagePath,
								artifact.id,
								artifact.resultCommit,
								change.path,
								`${index}-after`,
							)
						: undefined,
					binary,
				})
			}
			if (artifact.changes.length === 0) {
				artifact.status = "discarded"
				artifact.partial = partial
				delete artifact.patchFile
				delete artifact.error
				await this.persist(storagePath, artifact)
				capturePersisted = true
				return artifact
			}
			const patchName = "changes.patch"
			await fs.writeFile(
				path.join(this.artifactDir(storagePath, artifact.id), patchName),
				await this.gitBuffer(gitCwd, [
					"diff",
					"--binary",
					"--full-index",
					"-M",
					artifact.baselineCommit,
					artifact.resultCommit,
				]),
			)
			artifact.patchFile = patchName
			artifact.status = "pending_review"
			artifact.partial = partial
			delete artifact.error
			await this.persist(storagePath, artifact)
			capturePersisted = true
			return artifact
		} finally {
			await fs.rm(indexPath, { force: true }).catch(() => undefined)
			// Until export and metadata are durable, the existing active record and
			// physical worktree are the only complete recovery source. A failed capture
			// must not remove them or publish a partially assembled terminal snapshot.
			if (capturePersisted) {
				try {
					await this.cleanupWorktreeWithRetry(artifact)
					delete artifact.worktreePath
				} catch (error) {
					artifact.error = `Captured changes, but managed worktree cleanup must be retried: ${
						error instanceof Error ? error.message : String(error)
					}`
				}
				await this.persist(storagePath, artifact)
			}
		}
	}

	private async cleanupWorktree(artifact: ManagedWorkerArtifact): Promise<void> {
		if (!artifact.worktreePath) return
		const admin = await this.resolveWorktreeAdmin(artifact)
		let absent = false
		try {
			await fs.lstat(artifact.worktreePath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
			absent = true
		}
		// A prior remove may have succeeded before prune or invocation cleanup
		// failed. Skip removal only when both physical and registered ownership ended.
		if (!absent || (await this.hasRegisteredWorktree(admin.cwd, artifact.worktreePath, admin.prefix))) {
			await this.git(admin.cwd, [...admin.prefix, "worktree", "unlock", artifact.worktreePath]).catch(
				() => undefined,
			)
			await this.git(admin.cwd, [...admin.prefix, "worktree", "remove", "--force", artifact.worktreePath])
		}
		await this.git(admin.cwd, [...admin.prefix, "worktree", "prune"])
	}

	private async cleanupWorktreeWithRetry(artifact: ManagedWorkerArtifact): Promise<void> {
		let lastError: unknown
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this.cleanupWorktree(artifact)
				return
			} catch (error) {
				lastError = error
				if (attempt < 2) {
					await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
				}
			}
		}
		throw lastError
	}

	private async currentBlobHash(gitRoot: string, filePath: string): Promise<string | undefined> {
		const absolute = path.join(gitRoot, filePath)
		try {
			const stat = await fs.lstat(absolute)
			if (stat.isDirectory()) return undefined
			return (await this.git(gitRoot, ["hash-object", `--path=${filePath}`, "--", absolute])).trim()
		} catch {
			return undefined
		}
	}

	private async currentPathState(gitRoot: string, filePath: string): Promise<{ hash?: string; mode?: string }> {
		const absolute = path.join(gitRoot, filePath)
		try {
			const stat = await fs.lstat(absolute)
			if (stat.isDirectory()) return {}
			if (stat.isSymbolicLink()) {
				const content = Buffer.from(await fs.readlink(absolute))
				return {
					hash: crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex"),
					mode: "120000",
				}
			}
			return {
				hash: await this.currentBlobHash(gitRoot, filePath),
				mode: process.platform === "win32" || (stat.mode & 0o111) === 0 ? "100644" : "100755",
			}
		} catch {
			return {}
		}
	}

	private async matchesAppliedState(artifact: ManagedWorkerArtifact, compareFileMode: boolean): Promise<boolean> {
		for (const change of artifact.changes) {
			const afterCurrent = await this.currentPathState(artifact.gitRoot, change.path)
			if (afterCurrent.hash !== change.afterHash || (compareFileMode && afterCurrent.mode !== change.afterMode)) {
				return false
			}
			if (
				change.previousPath &&
				change.previousPath !== change.path &&
				(await this.currentPathState(artifact.gitRoot, change.previousPath)).hash
			) {
				return false
			}
		}
		return true
	}

	async apply(storagePath: string, artifactId: string): Promise<ApplyManagedWorktreeResult> {
		const artifact = await this.load(storagePath, artifactId)
		if (artifact.status === "applied") return { status: "applied" }
		if (!["pending_review", "conflicted"].includes(artifact.status) || !artifact.patchFile) {
			throw new Error("This worker change set is not available to apply")
		}
		const compareFileMode =
			(await this.git(artifact.gitRoot, ["config", "--bool", "core.filemode"]).catch(() => "false")).trim() ===
			"true"
		// A prior process may have landed the patch and exited before metadata was
		// durably replaced. Recognize the exact after-state before conflict checks.
		if (await this.matchesAppliedState(artifact, compareFileMode)) {
			artifact.status = "applied"
			delete artifact.conflictPaths
			delete artifact.error
			await this.persist(storagePath, artifact)
			return { status: "applied" }
		}
		const conflicts: string[] = []
		for (const change of artifact.changes) {
			const beforePath = change.previousPath ?? change.path
			const beforeCurrent = await this.currentPathState(artifact.gitRoot, beforePath)
			if (
				beforeCurrent.hash !== change.beforeHash ||
				(compareFileMode && beforeCurrent.mode !== change.beforeMode)
			)
				conflicts.push(beforePath)
			if (change.previousPath && change.path !== change.previousPath) {
				const destinationBaseline = await this.treeEntry(artifact.gitRoot, artifact.baselineCommit, change.path)
				const destinationCurrent = await this.currentPathState(artifact.gitRoot, change.path)
				if (
					destinationCurrent.hash !== destinationBaseline.hash ||
					(compareFileMode && destinationCurrent.mode !== destinationBaseline.mode)
				)
					conflicts.push(change.path)
			}
		}
		if (conflicts.length > 0) {
			artifact.status = "conflicted"
			artifact.conflictPaths = [...new Set(conflicts)]
			await this.persist(storagePath, artifact)
			return { status: "conflicted", conflictPaths: artifact.conflictPaths }
		}

		const patchPath = path.join(this.artifactDir(storagePath, artifact.id), artifact.patchFile)
		try {
			await this.git(artifact.gitRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", patchPath])
		} catch {
			artifact.status = "conflicted"
			artifact.error = "Patch preflight failed against the current parent working tree."
			await this.persist(storagePath, artifact)
			return { status: "conflicted" }
		}
		await this.git(artifact.gitRoot, ["apply", "--binary", "--whitespace=nowarn", patchPath])
		if (!(await this.matchesAppliedState(artifact, compareFileMode))) {
			throw new Error("Applied worker change failed exact after-state verification")
		}
		artifact.status = "applied"
		delete artifact.conflictPaths
		delete artifact.error
		await this.persist(storagePath, artifact)
		return { status: "applied" }
	}

	async discard(storagePath: string, artifactId: string): Promise<ManagedWorkerArtifact> {
		const artifact = await this.load(storagePath, artifactId)
		if (artifact.status === "applied") return artifact
		if (artifact.status !== "discarded") {
			// Commit the decision before deleting proposal data. Keep the patch reference
			// until cleanup settles so interrupted discards can resume idempotently.
			artifact.status = "discarded"
			await this.persist(storagePath, artifact)
		}
		if (artifact.patchFile) {
			await fs.rm(path.join(this.artifactDir(storagePath, artifact.id), artifact.patchFile), { force: true })
			delete artifact.patchFile
			await this.persist(storagePath, artifact)
		}
		return artifact
	}

	async getDiffFiles(
		storagePath: string,
		artifactId: string,
	): Promise<Array<ManagedWorkerChange & { beforePath?: string; afterPath?: string }>> {
		const artifact = await this.load(storagePath, artifactId)
		const dir = this.artifactDir(storagePath, artifact.id)
		return artifact.changes.map((change) => ({
			...change,
			beforePath: change.beforeFile ? path.join(dir, change.beforeFile) : undefined,
			afterPath: change.afterFile ? path.join(dir, change.afterFile) : undefined,
		}))
	}

	async recoverOrphans(
		storagePath: string,
		options: ManagedWorkerRecoveryOptions = {},
	): Promise<ManagedWorkerArtifact[]> {
		const root = path.join(storagePath, "subagent-change-sets")
		const worktreeRoot = path.join(storagePath, "subagent-worktrees")
		let entries: string[] = []
		try {
			entries = await fs.readdir(root)
		} catch {
			return []
		}
		const recovered: ManagedWorkerArtifact[] = []
		for (const id of entries) {
			try {
				const artifact = await this.load(storagePath, id)
				if (options.hasTaskOwner?.(artifact.taskId)) continue
				const conventionalWorktreePath = path.join(worktreeRoot, artifact.id)
				let recoverableWorktreePath: string | undefined
				for (const candidate of [artifact.worktreePath, conventionalWorktreePath]) {
					if (!candidate || recoverableWorktreePath) continue
					try {
						await fs.access(candidate)
						recoverableWorktreePath = candidate
					} catch {
						// Try the conventional path. Older cancellation code could remove
						// worktreePath from metadata even when Git cleanup failed.
					}
				}

				if (options.hasTaskOwner?.(artifact.taskId)) continue
				if (artifact.status === "active") {
					if (recoverableWorktreePath) {
						if (artifact.worktreePath !== recoverableWorktreePath) {
							artifact.worktreePath = recoverableWorktreePath
							await this.persist(storagePath, artifact)
						}
						recovered.push(await this.capture(storagePath, id, true))
					} else {
						artifact.status = "discarded"
						artifact.partial = true
						artifact.error = "The managed worktree disappeared before changes could be recovered."
						delete artifact.worktreePath
						await this.persist(storagePath, artifact)
						recovered.push(artifact)
					}
				} else if (recoverableWorktreePath || artifact.worktreePath) {
					// Capture can finish before a transient Windows/Git lock allows the
					// linked worktree to be removed. Legacy metadata can also omit the
					// still-existing path. A removed path can retain pending prune work.
					// Retry only cleanup; the quarantined commit and patch are authoritative.
					artifact.worktreePath = recoverableWorktreePath ?? artifact.worktreePath
					await this.cleanupWorktreeWithRetry(artifact)
					delete artifact.worktreePath
					if (artifact.error?.startsWith("Captured changes, but managed worktree cleanup")) {
						delete artifact.error
					}
					await this.persist(storagePath, artifact)
				}
			} catch {
				// Leave unknown artifacts untouched; they may belong to a newer Alpha version.
			}
		}
		return recovered
	}

	async deleteArtifact(storagePath: string, artifactId: string): Promise<void> {
		const artifact = await this.load(storagePath, artifactId).catch(() => undefined)
		if (artifact?.worktreePath) await this.cleanupWorktreeWithRetry(artifact)
		await fs.rm(this.artifactDir(storagePath, artifactId), { recursive: true, force: true })
	}
}

export const managedSubagentWorktreeService = new ManagedSubagentWorktreeService()
