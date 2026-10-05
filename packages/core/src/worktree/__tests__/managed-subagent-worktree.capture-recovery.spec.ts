import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ManagedSubagentWorktreeService } from "../managed-subagent-worktree.js"
import { worktreeIncludeService } from "../worktree-include.js"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})

const execFileAsync = promisify(execFile)
const TIMEOUT = 30_000
type GitEffect = { git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> }

describe("Worker capture failure preserves uncommitted changes", () => {
	let root: string
	let repo: string
	let storage: string
	let service: ManagedSubagentWorktreeService
	const git = async (args: string[]) =>
		String((await execFileAsync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true })).stdout).trim()

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worker-capture-"))
		repo = path.join(root, "repo with spaces")
		storage = path.join(root, "extension storage")
		await fs.mkdir(path.join(repo, "src"), { recursive: true })
		await git(["init"])
		await git(["config", "user.name", "Alpha Test"])
		await git(["config", "user.email", "test@local.invalid"])
		await git(["config", "core.autocrlf", "false"])
		await fs.writeFile(path.join(repo, "src/value.txt"), "baseline\n")
		await git(["add", "-A"])
		await git(["commit", "-m", "initial"])
		service = new ManagedSubagentWorktreeService()
	}, TIMEOUT)

	it(
		"recovers retained terminal cleanup after removal completed but every prune attempt failed",
		async () => {
			const worktreesBefore = await git(["worktree", "list", "--porcelain"])
			const prepared = await service.create(
				storage,
				"retained-prune-worker",
				await service.validateScope(repo, ["src"]),
			)
			const owner = service as unknown as GitEffect
			const actualGit = owner.git.bind(service)
			const effect = vi.spyOn(owner, "git").mockImplementation(async (cwd, args, env) => {
				if (args[0] === "worktree" && args[1] === "prune")
					throw new Error("Owned prune is temporarily unavailable")
				return actualGit(cwd, args, env)
			})
			try {
				const captured = await service.capture(storage, prepared.artifact.id)
				expect(captured).toMatchObject({ status: "discarded", worktreePath: prepared.workspacePath })
				expect(captured.error).toContain("managed worktree cleanup must be retried")
				await expect(fs.access(prepared.workspacePath)).rejects.toMatchObject({ code: "ENOENT" })
				expect(await git(["worktree", "list", "--porcelain"])).toBe(worktreesBefore)
				effect.mockRestore()

				const reloaded = new ManagedSubagentWorktreeService()
				await expect(reloaded.recoverOrphans(storage, { hasTaskOwner: () => true })).resolves.toEqual([])
				expect((await reloaded.load(storage, prepared.artifact.id)).worktreePath).toBe(prepared.workspacePath)
				await expect(reloaded.recoverOrphans(storage)).resolves.toEqual([])
				const recovered = await reloaded.load(storage, prepared.artifact.id)
				expect(recovered.status).toBe("discarded")
				expect(recovered.worktreePath).toBeUndefined()
				expect(recovered.error).toBeUndefined()
				expect(await git(["worktree", "list", "--porcelain"])).toBe(worktreesBefore)
			} finally {
				effect.mockRestore()
				await service.deleteArtifact(storage, prepared.artifact.id)
			}
		},
		TIMEOUT,
	)

	it.each(["capture", "delete"] as const)(
		"finishes %s cleanup when removal completed before one prune failure",
		async (operation) => {
			const worktreesBefore = await git(["worktree", "list", "--porcelain"])
			const prepared = await service.create(
				storage,
				"partial-removal-worker",
				await service.validateScope(repo, ["src"]),
			)
			const owner = service as unknown as GitEffect
			const actualGit = owner.git.bind(service)
			let injected = false
			const effect = vi.spyOn(owner, "git").mockImplementation(async (cwd, args, env) => {
				if (!injected && args[0] === "worktree" && args[1] === "prune") {
					injected = true
					throw new Error("Git prune temporarily failed after owned removal")
				}
				return actualGit(cwd, args, env)
			})
			try {
				if (operation === "capture") {
					const captured = await service.capture(storage, prepared.artifact.id)
					expect(captured.status).toBe("discarded")
					expect(captured.worktreePath).toBeUndefined()
					expect(captured.error).toBeUndefined()
				} else {
					await service.deleteArtifact(storage, prepared.artifact.id)
					await expect(service.load(storage, prepared.artifact.id)).rejects.toMatchObject({ code: "ENOENT" })
				}
				expect(injected).toBe(true)
				await expect(fs.access(prepared.workspacePath)).rejects.toMatchObject({ code: "ENOENT" })
				expect(await git(["worktree", "list", "--porcelain"])).toBe(worktreesBefore)
			} finally {
				effect.mockRestore()
			}
		},
		TIMEOUT,
	)

	afterEach(async () => {
		vi.restoreAllMocks()
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile)
		vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
		vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink)
		await actual.rm(root, { recursive: true, force: true })
	}, TIMEOUT)

	it.skipIf(process.platform !== "win32").each(["junction", "owner marker"] as const)(
		"rolls back long-path startup after a failed %s unlink and retries partially completed owned cleanup",
		async (stage) => {
			const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			let longStorage = path.join(await fs.realpath(root), "long storage")
			while (longStorage.length < 202) {
				const remaining = 202 - longStorage.length
				longStorage = path.join(
					longStorage,
					"s".repeat(remaining > 63 ? Math.min(62, remaining - 3) : remaining - 1),
				)
			}
			const bucket = path.join(longStorage, "subagent-worktrees")
			await fs.mkdir(bucket, { recursive: true })
			await fs.writeFile(path.join(bucket, "external.txt"), "preserve\n")
			const before = await git(["worktree", "list", "--porcelain"])
			const ownerDirectories = new Set<string>()
			const cleanupInvocations = async () => {
				// Unlink only entries in the exact observed invocation directories.
				for (const directory of ownerDirectories) {
					let entries: string[]
					try {
						entries = await actual.readdir(directory)
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
						throw error
					}
					for (const name of entries) {
						const owned = path.join(directory, name)
						if (name !== "owner.json" && !(await actual.lstat(owned)).isSymbolicLink())
							throw new Error("Unexpected Git cleanup fixture entry")
						await actual.unlink(owned)
					}
					await actual.rmdir(directory)
				}
			}
			let injected = false
			vi.mocked(fs.unlink).mockImplementation(async (target) => {
				const value = String(target)
				const parent = path.dirname(value)
				if (path.basename(parent).startsWith("alpha-worker-git-")) {
					ownerDirectories.add(parent)
					if (!injected && path.basename(value) === (stage === "junction" ? "target" : "owner.json")) {
						injected = true
						throw Object.assign(new Error("Owned Git unlink is temporarily unavailable"), { code: "EBUSY" })
					}
				}
				return actual.unlink(target)
			})
			const failures: unknown[] = []
			try {
				await expect(
					service.create(longStorage, "unlink-failure-worker", await service.validateScope(repo, ["src"])),
				).rejects.toThrow("Temporary Git path cleanup is unconfirmed")
				expect(injected).toBe(true)
				expect(ownerDirectories.size).toBeGreaterThan(0)
				for (const directory of ownerDirectories)
					await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" })
				expect(await fs.readdir(path.join(longStorage, "subagent-change-sets"))).toEqual([])
				expect(await fs.readdir(bucket)).toEqual(["external.txt"])
				expect(await fs.readFile(path.join(bucket, "external.txt"), "utf8")).toBe("preserve\n")
				expect(await git(["worktree", "list", "--porcelain"])).toBe(before)
			} catch (error) {
				failures.push(error)
			}
			vi.mocked(fs.unlink).mockImplementation(actual.unlink)
			await cleanupInvocations().catch((error: unknown) => failures.push(error))
			if (failures.length === 1) throw failures[0]
			if (failures.length > 1) throw new AggregateError(failures, "Git fixture assertion and cleanup failed")
		},
		TIMEOUT,
	)

	it.each(["startup", "delete"] as const)(
		"retains addressable ownership when %s worktree cleanup cannot be confirmed",
		async (operation) => {
			const validated = await service.validateScope(repo, ["src"])
			// Fail only the external Git removal effect; the registered checkout,
			// artifact reader and subsequent recovery use real Git and filesystem state.
			const owner = service as unknown as GitEffect
			const actualGit = owner.git.bind(service)
			const removal = vi.spyOn(owner, "git").mockImplementation(async (cwd, args, env) => {
				if (args[0] === "worktree" && args[1] === "remove") throw new Error("Owned checkout is still locked")
				return actualGit(cwd, args, env)
			})
			let id: string
			if (operation === "startup") {
				vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles").mockRejectedValueOnce(
					new Error("include failed"),
				)
				await expect(service.create(storage, "worker", validated)).rejects.toThrow(
					"owned cleanup could not be confirmed",
				)
				const ids = await fs.readdir(path.join(storage, "subagent-change-sets"))
				expect(ids).toHaveLength(1)
				id = ids[0]!
			} else {
				const prepared = await service.create(storage, "worker", validated)
				id = prepared.artifact.id
				await expect(service.deleteArtifact(storage, id)).rejects.toThrow("Owned checkout is still locked")
			}
			try {
				const retained = await service.load(storage, id)
				expect(retained).toMatchObject({ id, status: "active" })
				expect(retained.worktreePath).toBeDefined()
				expect(await fs.readFile(path.join(retained.worktreePath!, "src/value.txt"), "utf8")).toBe("baseline\n")
				expect(await git(["worktree", "list", "--porcelain"])).toContain(id)
				removal.mockRestore()
				const recovered = await new ManagedSubagentWorktreeService().recoverOrphans(storage)
				expect(recovered).toEqual([expect.objectContaining({ id, status: "discarded", partial: true })])
				expect((await service.load(storage, id)).worktreePath).toBeUndefined()
				expect(await git(["worktree", "list", "--porcelain"])).not.toContain(id)
			} finally {
				removal.mockRestore()
				await new ManagedSubagentWorktreeService().deleteArtifact(storage, id)
			}
		},
		TIMEOUT,
	)

	it.each(["index", "patch", "metadata"] as const)(
		"retains the worktree after a failed %s write and recovers it on reload",
		async (stage) => {
			const prepared = await service.create(storage, "worker", await service.validateScope(repo, ["src"]))
			const artifactId = prepared.artifact.id
			const artifactDirectory = path.join(storage, "subagent-change-sets", artifactId)
			const valuePath = path.join(prepared.workspacePath, "src/value.txt")
			const newPath = path.join(prepared.workspacePath, "src/new.txt")
			await fs.writeFile(valuePath, "worker changes\n")
			await fs.writeFile(newPath, "new worker file\n")
			const failure = Object.assign(new Error(`${stage} capture write failed`), { code: "EIO" })
			const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			let injected = false
			if (stage === "index") {
				// Inject only the Git effect; the real worktree and its physical cleanup stay observable.
				const owner = service as unknown as GitEffect
				const actualGit = owner.git.bind(service)
				vi.spyOn(owner, "git").mockImplementation(async (cwd, args, env) => {
					if (!injected && args[0] === "read-tree") {
						injected = true
						throw failure
					}
					return actualGit(cwd, args, env)
				})
			} else if (stage === "patch") {
				vi.mocked(fs.writeFile).mockImplementation(async (target, data, options) => {
					if (!injected && target === path.join(artifactDirectory, "changes.patch")) {
						injected = true
						throw failure
					}
					return actual.writeFile(target, data, options)
				})
			} else {
				vi.mocked(fs.rename).mockImplementation(async (from, to) => {
					if (!injected && to === path.join(artifactDirectory, "metadata.json")) {
						injected = true
						throw failure
					}
					return actual.rename(from, to)
				})
			}

			await expect(service.capture(storage, artifactId)).rejects.toBe(failure)
			expect(injected).toBe(true)
			expect(await fs.readFile(valuePath, "utf8")).toBe("worker changes\n")
			expect(await fs.readFile(newPath, "utf8")).toBe("new worker file\n")
			expect(await service.load(storage, artifactId)).toMatchObject({
				status: "active",
				worktreePath: prepared.workspacePath,
			})
			expect(await fs.readFile(path.join(repo, "src/value.txt"), "utf8")).toBe("baseline\n")
			expect(await git(["status", "--porcelain=v1"])).toBe("")

			const recovered = await new ManagedSubagentWorktreeService().recoverOrphans(storage)
			expect(recovered).toHaveLength(1)
			const artifact = recovered[0]!
			expect(artifact).toMatchObject({ id: artifactId, status: "pending_review", partial: true })
			expect(artifact.worktreePath).toBeUndefined()
			expect(artifact.changes.map(({ path: changedPath }) => changedPath).sort()).toEqual([
				"src/new.txt",
				"src/value.txt",
			])
			const changed = artifact.changes.find(({ path: changedPath }) => changedPath === "src/value.txt")!
			expect(await fs.readFile(path.join(artifactDirectory, changed.afterFile!), "utf8")).toBe("worker changes\n")
			await expect(fs.access(prepared.workspacePath)).rejects.toMatchObject({ code: "ENOENT" })
			await expect(new ManagedSubagentWorktreeService().recoverOrphans(storage)).resolves.toEqual([])
		},
		TIMEOUT,
	)
})
