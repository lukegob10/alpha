import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ManagedSubagentWorktreeService } from "../managed-subagent-worktree.js"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
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

	afterEach(async () => {
		vi.restoreAllMocks()
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile)
		vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
		await actual.rm(root, { recursive: true, force: true })
	}, TIMEOUT)

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
