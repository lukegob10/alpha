import { execFile } from "child_process"
import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ManagedSubagentWorktreeService } from "../managed-subagent-worktree.js"
import { WorktreeIncludeService } from "../worktree-include.js"
import { WorktreeService } from "../worktree-service.js"

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 30_000

describe("Worktree Git environment isolation", () => {
	let root: string
	let repo: string
	let foreign: string
	let storage: string
	let fixtureEnv: NodeJS.ProcessEnv

	const git = async (cwd: string, args: string[]) =>
		String(
			(await execFileAsync("git", args, { cwd, env: fixtureEnv, windowsHide: true, encoding: "utf8" })).stdout,
		).trim()

	const snapshotGitDirectory = async () => {
		const directory = path.join(foreign, ".git")
		const files: Record<string, string> = {}
		for (const name of (await fs.readdir(directory, { recursive: true })).sort()) {
			const file = path.join(directory, name)
			if ((await fs.lstat(file)).isFile()) {
				files[name] = createHash("sha256")
					.update(await fs.readFile(file))
					.digest("hex")
			}
		}
		return files
	}

	beforeEach(async () => {
		fixtureEnv = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
		)
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worker-env-")))
		repo = path.join(root, "parent repo")
		foreign = path.join(root, "foreign repo")
		storage = path.join(root, "storage")
		for (const directory of [repo, foreign]) {
			await fs.mkdir(path.join(directory, "src"), { recursive: true })
			await git(directory, ["init", "--template="])
			await git(directory, ["config", "user.name", "Fixture User"])
			await git(directory, ["config", "user.email", "fixture@local.invalid"])
			await git(directory, ["config", "commit.gpgsign", "false"])
			await git(directory, ["config", "core.hooksPath", path.join(root, "no-hooks")])
			await git(directory, ["config", "core.autocrlf", "false"])
			await fs.writeFile(path.join(directory, "src/value.txt"), "baseline\n")
			await git(directory, ["add", "-A"])
			await git(directory, ["commit", "-m", "fixture"])
		}
		await git(foreign, ["config", "core.autocrlf", "true"])
		await fs.writeFile(path.join(foreign, "foreign-only.txt"), "foreign canary\n")
		await git(foreign, ["add", "foreign-only.txt"])
		await fs.writeFile(path.join(foreign, "foreign-only.txt"), "unstaged foreign canary\n")
	}, TIMEOUT_MS)

	afterEach(async () => {
		vi.unstubAllEnvs()
		await fs.rm(root, { recursive: true, force: true })
	}, TIMEOUT_MS)

	it.each(
		(["selectors", "index", "config parameters", "config entries", "config file"] as const).flatMap((kind) =>
			[false, true].map((plain) => ({ kind, plain })),
		),
	)(
		"ignores inherited $kind through create, capture, apply and cleanup (plain folder: $plain)",
		async ({ kind, plain }) => {
			const source = plain ? path.join(root, "plain folder") : repo
			if (plain) {
				await fs.mkdir(path.join(source, "src"), { recursive: true })
				await fs.writeFile(path.join(source, "src/value.txt"), "baseline\n")
			}
			await fs.writeFile(path.join(repo, "parent-only.txt"), "staged parent canary\n")
			await git(repo, ["add", "parent-only.txt"])
			const parentHead = await git(repo, ["rev-parse", "HEAD"])
			const parentIndex = await fs.readFile(path.join(repo, ".git/index"))
			const foreignBefore = await snapshotGitDirectory()
			const foreignGit = path.join(foreign, ".git")
			const selectors: Record<string, string> = {
				GIT_DIR: foreignGit,
				GIT_WORK_TREE: foreign,
				GIT_COMMON_DIR: foreignGit,
				GIT_OBJECT_DIRECTORY: path.join(foreignGit, "objects"),
				GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(foreignGit, "objects"),
				GIT_SHALLOW_FILE: path.join(foreignGit, "foreign-shallow"),
				GIT_GRAFT_FILE: path.join(foreignGit, "foreign-grafts"),
				GIT_PREFIX: "foreign-prefix/",
				GIT_NAMESPACE: "foreign-namespace",
			}
			const quoteGitConfig = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
			const environments: Record<typeof kind, Record<string, string>> = {
				selectors,
				index: { GIT_INDEX_FILE: path.join(foreignGit, "index") },
				"config parameters": { GIT_CONFIG_PARAMETERS: `'core.worktree'=${quoteGitConfig(foreign)}` },
				"config entries": {
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "core.worktree",
					GIT_CONFIG_VALUE_0: foreign,
				},
				"config file": { GIT_CONFIG: path.join(foreignGit, "config") },
			}
			for (const [name, value] of Object.entries(environments[kind])) vi.stubEnv(name, value)
			try {
				const service = new ManagedSubagentWorktreeService()
				const scope = await service.validateScope(source, ["src"])
				expect(scope.gitRoot).toBe(await fs.realpath(source))
				expect(Boolean(scope.privateRepository)).toBe(plain)
				const worker = await service.create(storage, "isolated-env-worker", scope)
				expect(await fs.readFile(path.join(worker.workspacePath, "src/value.txt"), "utf8")).toBe("baseline\n")
				await fs.writeFile(path.join(worker.workspacePath, "src/value.txt"), "worker result\n")
				const artifact = await service.capture(storage, worker.artifact.id)
				expect(artifact.status).toBe("pending_review")
				expect(artifact.changes.map((change) => change.path)).toEqual(["src/value.txt"])
				await expect(service.apply(storage, artifact.id)).resolves.toEqual({ status: "applied" })
				await service.deleteArtifact(storage, artifact.id)
			} finally {
				vi.unstubAllEnvs()
			}
			expect(await fs.readFile(path.join(source, "src/value.txt"), "utf8")).toBe("worker result\n")
			expect(await git(repo, ["rev-parse", "HEAD"])).toBe(parentHead)
			expect(await fs.readFile(path.join(repo, ".git/index"))).toEqual(parentIndex)
			expect(await snapshotGitDirectory()).toEqual(foreignBefore)
			expect(await fs.readFile(path.join(foreign, "src/value.txt"), "utf8")).toBe("baseline\n")
			expect(await fs.readFile(path.join(foreign, "foreign-only.txt"), "utf8")).toBe("unstaged foreign canary\n")
			if (plain) await expect(fs.access(path.join(source, ".git"))).rejects.toMatchObject({ code: "ENOENT" })
		},
		TIMEOUT_MS,
	)

	it.each(["selectors", "config entries"] as const)(
		"isolates ordinary worktree operations and branch probes from inherited %s",
		async (kind) => {
			await fs.writeFile(path.join(repo, ".worktreeinclude"), "node_modules\n")
			await git(repo, ["add", ".worktreeinclude"])
			await git(repo, ["commit", "-m", "include fixture"])
			const parentBranch = await git(repo, ["branch", "--show-current"])
			for (const branch of ["parent-available", "parent-checkout"]) await git(repo, ["branch", branch])
			await git(foreign, ["checkout", "-b", "foreign-current"])
			const foreignBefore = await snapshotGitDirectory()
			const foreignGit = path.join(foreign, ".git")
			const checkout = path.join(root, "ordinary worktree")
			const plain = path.join(root, "plain folder")
			await fs.mkdir(plain)
			const environments: Record<typeof kind, Record<string, string>> = {
				selectors: {
					GIT_DIR: foreignGit,
					GIT_WORK_TREE: foreign,
					GIT_INDEX_FILE: path.join(foreignGit, "index"),
					GIT_COMMON_DIR: foreignGit,
				},
				"config entries": {
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "core.worktree",
					GIT_CONFIG_VALUE_0: foreign,
				},
			}
			for (const [name, value] of Object.entries(environments[kind])) vi.stubEnv(name, value)
			try {
				const service = new WorktreeService()
				const includes = new WorktreeIncludeService()
				expect(await service.checkGitRepo(repo)).toBe(true)
				expect(await service.checkGitRepo(plain)).toBe(false)
				expect(path.resolve((await service.getGitRootPath(repo))!)).toBe(await fs.realpath(repo))
				expect(path.resolve((await service.getCurrentWorktreePath(repo))!)).toBe(await fs.realpath(repo))
				expect(await service.getCurrentBranch(repo)).toBe(parentBranch)
				expect((await service.listWorktrees(repo)).map((entry) => path.resolve(entry.path))).toContain(
					await fs.realpath(repo),
				)
				expect((await service.getAvailableBranches(repo, true)).localBranches).toContain("parent-available")
				expect(await includes.branchHasWorktreeInclude(repo, "HEAD")).toBe(true)
				expect(await includes.branchHasWorktreeInclude(foreign, "HEAD")).toBe(false)
				const created = await service.createWorktree(repo, {
					path: checkout,
					branch: "ui-worktree",
					baseBranch: parentBranch,
					createNewBranch: true,
				})
				expect(created.success).toBe(true)
				expect(path.resolve(created.worktree!.path)).toBe(checkout)
				expect(await fs.readFile(path.join(checkout, ".worktreeinclude"), "utf8")).toBe("node_modules\n")
				expect((await service.checkoutBranch(repo, "parent-checkout")).success).toBe(true)
				expect((await service.deleteWorktree(repo, checkout)).success).toBe(true)
			} finally {
				vi.unstubAllEnvs()
			}
			expect(await git(repo, ["branch", "--show-current"])).toBe("parent-checkout")
			await expect(git(repo, ["rev-parse", "--verify", "refs/heads/ui-worktree"])).rejects.toThrow()
			await expect(fs.access(checkout)).rejects.toMatchObject({ code: "ENOENT" })
			expect(await snapshotGitDirectory()).toEqual(foreignBefore)
			expect(await fs.readFile(path.join(foreign, "src/value.txt"), "utf8")).toBe("baseline\n")
			expect(await fs.readFile(path.join(foreign, "foreign-only.txt"), "utf8")).toBe("unstaged foreign canary\n")
		},
		TIMEOUT_MS,
	)
})
