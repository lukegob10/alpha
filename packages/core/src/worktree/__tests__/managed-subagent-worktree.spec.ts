import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ManagedSubagentWorktreeService } from "../managed-subagent-worktree.js"

const execFileAsync = promisify(execFile)
const WORKTREE_TEST_TIMEOUT_MS = 30_000

describe("ManagedSubagentWorktreeService", () => {
	let root: string
	let repo: string
	let storage: string
	let service: ManagedSubagentWorktreeService

	const git = async (args: string[], cwd = repo) =>
		String((await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout).trim()
	const write = async (relativePath: string, content: string | Buffer) => {
		const target = path.join(repo, relativePath)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, content)
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worker-"))
		repo = path.join(root, "repo with spaces")
		storage = path.join(root, "extension storage")
		await fs.mkdir(repo, { recursive: true })
		await git(["init"])
		await git(["config", "user.name", "Test User"])
		await git(["config", "user.email", "test@example.com"])
		await write("src/value.txt", "base\n")
		await write("keep.txt", "keep\n")
		await git(["add", "-A"])
		await git(["commit", "-m", "initial"])
		service = new ManagedSubagentWorktreeService()
	}, WORKTREE_TEST_TIMEOUT_MS)

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	}, WORKTREE_TEST_TIMEOUT_MS)

	it(
		"snapshots a dirty checkout without changing the parent branch or index, then applies unstaged",
		async () => {
			await write("src/value.txt", "staged\n")
			await git(["add", "src/value.txt"])
			await write("src/value.txt", "working\n")
			await write("src/untracked.txt", "untracked\n")
			const branchBefore = await git(["rev-parse", "--abbrev-ref", "HEAD"])
			const indexBefore = await git(["diff", "--cached", "--binary"])
			const statusBefore = await git(["status", "--porcelain=v1"])

			const validated = await service.validateScope(repo, ["src"])
			const prepared = await service.create(storage, "worker-1", validated)
			expect(
				(await fs.readFile(path.join(prepared.workspacePath, "src/value.txt"), "utf8")).replace(/\r\n/g, "\n"),
			).toBe("working\n")
			expect(
				(await fs.readFile(path.join(prepared.workspacePath, "src/untracked.txt"), "utf8")).replace(
					/\r\n/g,
					"\n",
				),
			).toBe("untracked\n")
			expect(await git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branchBefore)
			expect(await git(["diff", "--cached", "--binary"])).toBe(indexBefore)
			expect(await git(["status", "--porcelain=v1"])).toBe(statusBefore)

			await fs.writeFile(path.join(prepared.workspacePath, "src/value.txt"), "worker\n")
			await fs.writeFile(path.join(prepared.workspacePath, "src/new.bin"), Buffer.from([0, 1, 2, 255]))
			const artifact = await service.capture(storage, prepared.artifact.id)
			expect(artifact.status).toBe("pending_review")
			expect(artifact.changes.map((change) => change.path).sort()).toEqual(["src/new.bin", "src/value.txt"])
			expect((await fs.readFile(path.join(repo, "src/value.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
				"working\n",
			)

			expect(await service.apply(storage, artifact.id)).toEqual({ status: "applied" })
			expect(await service.apply(storage, artifact.id)).toEqual({ status: "applied" })
			expect((await fs.readFile(path.join(repo, "src/value.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
				"worker\n",
			)
			expect(await fs.readFile(path.join(repo, "src/new.bin"))).toEqual(Buffer.from([0, 1, 2, 255]))
			expect(await git(["diff", "--cached", "--binary"])).toBe(indexBefore)
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)

	it(
		"recovers an exact patch that landed before applied metadata was persisted",
		async () => {
			const validated = await service.validateScope(repo, ["src/value.txt"])
			const prepared = await service.create(storage, "worker-recovery", validated)
			await fs.writeFile(path.join(prepared.workspacePath, "src/value.txt"), "worker recovery\n")
			const artifact = await service.capture(storage, prepared.artifact.id)
			const patchPath = path.join(storage, "subagent-change-sets", artifact.id, artifact.patchFile!)

			await git(["apply", "--binary", "--whitespace=nowarn", patchPath])
			expect((await service.load(storage, artifact.id)).status).toBe("pending_review")

			expect(await service.apply(storage, artifact.id)).toEqual({ status: "applied" })
			expect((await service.load(storage, artifact.id)).status).toBe("applied")
			expect((await fs.readFile(path.join(repo, "src/value.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
				"worker recovery\n",
			)
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)

	it(
		"snapshots and applies in an initialized repository before its first commit",
		async () => {
			repo = path.join(root, "unborn repo")
			await fs.mkdir(repo, { recursive: true })
			await git(["init"])
			await write("README.md", "uncommitted baseline\n")
			const branchBefore = await git(["symbolic-ref", "--short", "HEAD"])
			const indexBefore = await git(["ls-files", "--stage"])

			const validated = await service.validateScope(repo, ["docs/subagent-worker-smoke-test.md"])
			expect(validated.fileWriteScope).toEqual(["docs/subagent-worker-smoke-test.md"])
			const prepared = await service.create(storage, "worker-unborn", validated)
			expect(
				(await fs.readFile(path.join(prepared.workspacePath, "README.md"), "utf8")).replace(/\r\n/g, "\n"),
			).toBe("uncommitted baseline\n")

			await fs.mkdir(path.join(prepared.workspacePath, "docs"), { recursive: true })
			await fs.writeFile(path.join(prepared.workspacePath, "docs/subagent-worker-smoke-test.md"), "worker\n")
			const artifact = await service.capture(storage, prepared.artifact.id)

			expect(artifact.status).toBe("pending_review")
			expect(artifact.changes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ status: "A", path: "docs/subagent-worker-smoke-test.md" }),
				]),
			)
			await expect(git(["rev-parse", "--verify", "HEAD"])).rejects.toThrow()
			await expect(fs.readFile(path.join(repo, "docs/subagent-worker-smoke-test.md"), "utf8")).rejects.toThrow()

			expect(await service.apply(storage, artifact.id)).toEqual({ status: "applied" })
			expect(
				(await fs.readFile(path.join(repo, "docs/subagent-worker-smoke-test.md"), "utf8")).replace(
					/\r\n/g,
					"\n",
				),
			).toBe("worker\n")
			expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe(branchBefore)
			expect(await git(["ls-files", "--stage"])).toBe(indexBefore)
			await expect(git(["rev-parse", "--verify", "HEAD"])).rejects.toThrow()
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)

	it(
		"keeps a touched-path conflict quarantined without partially applying",
		async () => {
			const validated = await service.validateScope(repo, ["src"])
			const prepared = await service.create(storage, "worker-2", validated)
			await fs.writeFile(path.join(prepared.workspacePath, "src/value.txt"), "worker\n")
			await fs.writeFile(path.join(prepared.workspacePath, "src/other.txt"), "other\n")
			const artifact = await service.capture(storage, prepared.artifact.id)
			await write("src/value.txt", "parent\n")

			const result = await service.apply(storage, artifact.id)
			expect(result.status).toBe("conflicted")
			expect(result.conflictPaths).toContain("src/value.txt")
			expect(await fs.readFile(path.join(repo, "src/value.txt"), "utf8")).toBe("parent\n")
			await expect(fs.readFile(path.join(repo, "src/other.txt"), "utf8")).rejects.toThrow()
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)

	it(
		"captures and applies renames and deletions without staging them",
		async () => {
			await write("src/rename-me.txt", "rename me\n")
			await write("src/delete-me.txt", "delete me\n")
			await git(["add", "src/rename-me.txt", "src/delete-me.txt"])
			await git(["commit", "-m", "rename and delete fixtures"])

			const validated = await service.validateScope(repo, ["src"])
			const prepared = await service.create(storage, "worker-rename-delete", validated)
			await fs.rename(
				path.join(prepared.workspacePath, "src/rename-me.txt"),
				path.join(prepared.workspacePath, "src/renamed.txt"),
			)
			await fs.unlink(path.join(prepared.workspacePath, "src/delete-me.txt"))

			const artifact = await service.capture(storage, prepared.artifact.id)
			expect(artifact.status).toBe("pending_review")
			expect(artifact.changes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						status: expect.stringMatching(/^R/),
						previousPath: "src/rename-me.txt",
						path: "src/renamed.txt",
					}),
					expect.objectContaining({ status: "D", path: "src/delete-me.txt" }),
				]),
			)

			expect(await service.apply(storage, artifact.id)).toEqual({ status: "applied" })
			expect((await fs.readFile(path.join(repo, "src/renamed.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
				"rename me\n",
			)
			await expect(fs.readFile(path.join(repo, "src/rename-me.txt"), "utf8")).rejects.toThrow()
			await expect(fs.readFile(path.join(repo, "src/delete-me.txt"), "utf8")).rejects.toThrow()
			expect(await git(["diff", "--cached", "--name-only"])).toBe("")
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)

	it(
		"rejects unsafe scope syntax and final changes outside scope",
		async () => {
			await expect(service.validateScope(repo, ["../outside"])).rejects.toThrow(/traversal|escapes/)
			await expect(service.validateScope(repo, [path.resolve(repo, "src")])).rejects.toThrow(/relative/)
			await expect(service.validateScope(repo, ["src/**"])).rejects.toThrow(/globs/)
			await expect(service.validateScope(repo, [".git/config"])).rejects.toThrow(/\.git/)

			const validated = await service.validateScope(repo, ["src/value.txt"])
			const prepared = await service.create(storage, "worker-3", validated)
			await fs.writeFile(path.join(prepared.workspacePath, "keep.txt"), "violation\n")
			const artifact = await service.capture(storage, prepared.artifact.id)
			expect(artifact.status).toBe("scope_violation")
			expect(artifact.error).toContain("keep.txt")
			await expect(service.apply(storage, artifact.id)).rejects.toThrow(/not available/)
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)

	it(
		"treats a missing scope as an exact file rather than a recursive directory",
		async () => {
			const validated = await service.validateScope(repo, ["docs/new.md"])
			expect(validated.fileWriteScope).toEqual(["docs/new.md"])
			const prepared = await service.create(storage, "worker-missing-file-scope", validated)
			await fs.mkdir(path.join(prepared.workspacePath, "docs/new.md"), { recursive: true })
			await fs.writeFile(path.join(prepared.workspacePath, "docs/new.md/escape.txt"), "outside exact scope\n")

			const artifact = await service.capture(storage, prepared.artifact.id)

			expect(artifact.status).toBe("scope_violation")
			expect(artifact.error).toContain("docs/new.md/escape.txt")
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)

	it(
		"copies ignored worktree support files without including them in the change set",
		async () => {
			await write(".gitignore", "support.env\n")
			await write(".worktreeinclude", "support.env\n")
			await write("support.env", "secretless support\n")
			await git(["add", ".gitignore", ".worktreeinclude"])
			await git(["commit", "-m", "worktree support"])

			const validated = await service.validateScope(repo, ["src"])
			const prepared = await service.create(storage, "worker-4", validated)
			expect(await fs.readFile(path.join(prepared.workspacePath, "support.env"), "utf8")).toBe(
				"secretless support\n",
			)
			await fs.writeFile(path.join(prepared.workspacePath, "support.env"), "changed support\n")
			await fs.writeFile(path.join(prepared.workspacePath, "src/value.txt"), "worker\n")
			const artifact = await service.capture(storage, prepared.artifact.id)
			expect(artifact.changes.map((change) => change.path)).toEqual(["src/value.txt"])
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)

	it(
		"recovers partial changes from an orphaned active worktree after reload",
		async () => {
			const validated = await service.validateScope(repo, ["src"])
			const prepared = await service.create(storage, "worker-orphan", validated)
			await fs.writeFile(path.join(prepared.workspacePath, "src/value.txt"), "recover me\n")

			const reloadedService = new ManagedSubagentWorktreeService()
			const recovered = await reloadedService.recoverOrphans(storage)

			expect(recovered).toHaveLength(1)
			const recoveredArtifact = recovered[0]!
			expect(recoveredArtifact).toEqual(
				expect.objectContaining({
					id: prepared.artifact.id,
					status: "pending_review",
					partial: true,
				}),
			)
			expect(recoveredArtifact.changes).toEqual(
				expect.arrayContaining([expect.objectContaining({ status: "M", path: "src/value.txt" })]),
			)
			await expect(fs.access(prepared.workspacePath)).rejects.toThrow()
		},
		WORKTREE_TEST_TIMEOUT_MS,
	)
})
