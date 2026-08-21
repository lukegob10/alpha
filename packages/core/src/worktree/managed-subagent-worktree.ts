import { execFile } from "child_process"
import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"

import { worktreeIncludeService } from "./worktree-include.js"

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 100 * 1024 * 1024
const GLOB_PATTERN = /[*?[\]{}!]/

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

const normalizeRelative = (value: string): string => value.split(path.sep).join("/").replace(/^\.\//, "")

const isWithin = (root: string, candidate: string): boolean => {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Native, platform-neutral quarantine lifecycle for one editing sub-agent. */
export class ManagedSubagentWorktreeService {
	private async git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
			encoding: "utf8",
			maxBuffer: MAX_GIT_OUTPUT,
			windowsHide: true,
		})
		return String(stdout)
	}

	private async gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			encoding: "buffer",
			maxBuffer: MAX_GIT_OUTPUT,
			windowsHide: true,
		})
		return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
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
			await fs.rename(temporaryPath, metadataPath)
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

	async validateScope(workspacePath: string, requestedScope: string[]): Promise<ValidatedWorkerScope> {
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
		const worktreePath = path.join(storagePath, "subagent-worktrees", artifactId)
		const indexPath = path.join(dir, "snapshot.index")
		await fs.mkdir(dir, { recursive: true })
		await fs.mkdir(path.dirname(worktreePath), { recursive: true })
		await fs.rm(indexPath, { force: true })
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
		const artifact: ManagedWorkerArtifact = {
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
		await this.persist(storagePath, artifact)
		try {
			await this.git(validated.gitRoot, ["worktree", "add", "--detach", worktreePath, baselineCommit])
			await this.git(validated.gitRoot, ["worktree", "lock", "--reason", "Alpha editing sub-agent", worktreePath])
			await worktreeIncludeService.copyWorktreeIncludeFiles(validated.gitRoot, worktreePath)
		} catch (error) {
			await this.git(validated.gitRoot, ["worktree", "unlock", worktreePath]).catch(() => undefined)
			await this.git(validated.gitRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined)
			await fs.rm(dir, { recursive: true, force: true })
			throw error
		}
		return {
			artifact,
			workspacePath: path.join(worktreePath, validated.logicalWorkspaceFromRoot),
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
			(scope) => normalized === scope || (!fileScopes.includes(scope) && normalized.startsWith(`${scope}/`)),
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
			return artifact
		} finally {
			await fs.rm(indexPath, { force: true }).catch(() => undefined)
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

	private async cleanupWorktree(artifact: ManagedWorkerArtifact): Promise<void> {
		if (!artifact.worktreePath) return
		const admin = await this.resolveWorktreeAdmin(artifact)
		await this.git(admin.cwd, [...admin.prefix, "worktree", "unlock", artifact.worktreePath]).catch(() => undefined)
		await this.git(admin.cwd, [...admin.prefix, "worktree", "remove", "--force", artifact.worktreePath])
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
		if (["applied", "discarded"].includes(artifact.status)) return artifact
		if (artifact.patchFile) {
			await fs.rm(path.join(this.artifactDir(storagePath, artifact.id), artifact.patchFile), { force: true })
			delete artifact.patchFile
		}
		artifact.status = "discarded"
		await this.persist(storagePath, artifact)
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

	async recoverOrphans(storagePath: string): Promise<ManagedWorkerArtifact[]> {
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
				} else if (recoverableWorktreePath) {
					// Capture can finish before a transient Windows/Git lock allows the
					// linked worktree to be removed. Legacy metadata can also omit the
					// still-existing path. Retry only cleanup; the quarantined commit and
					// patch are already authoritative.
					artifact.worktreePath = recoverableWorktreePath
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
		if (artifact?.worktreePath) await this.cleanupWorktreeWithRetry(artifact).catch(() => undefined)
		await fs.rm(this.artifactDir(storagePath, artifactId), { recursive: true, force: true })
	}
}

export const managedSubagentWorktreeService = new ManagedSubagentWorktreeService()
