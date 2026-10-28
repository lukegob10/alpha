import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ManagedSubagentWorktreeService, type ManagedWorkerArtifact } from "../managed-subagent-worktree.js"

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 30_000

describe("Worker artifact recovery across the parent projection boundary", () => {
	let root: string
	let repo: string
	let storage: string
	let artifact: ManagedWorkerArtifact
	const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, windowsHide: true })

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worker-projection-"))
		repo = path.join(root, "user workspace")
		storage = path.join(root, "extension storage")
		await fs.mkdir(path.join(repo, "src"), { recursive: true })
		await git(["init"])
		await git(["config", "user.name", "Alpha Test"])
		await git(["config", "user.email", "test@local.invalid"])
		await git(["config", "core.autocrlf", "false"])
		await fs.writeFile(path.join(repo, "src/value.txt"), "user baseline\n")
		await git(["add", "-A"])
		await git(["commit", "-m", "baseline"])
		const service = new ManagedSubagentWorktreeService()
		const prepared = await service.create(storage, "worker", await service.validateScope(repo, ["src"]), {
			signal: new AbortController().signal,
			terminateProcessTree: vi.fn(async () => undefined),
			groupId: "continuation-group",
			runId: "worker:continuation-run",
		})
		await fs.writeFile(path.join(prepared.workspacePath, "src/value.txt"), "captured worker change\n")
		// The old host exits here, before child history or the parent card receives the artifact.
		artifact = await service.capture(storage, prepared.artifact.id, true)
	}, TIMEOUT_MS)

	afterEach(async () => {
		vi.restoreAllMocks()
		const target = path.resolve(root)
		expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()))
		expect(path.basename(target)).toMatch(/^alpha-worker-projection-/)
		await fs.rm(target, { recursive: true, force: true })
	}, TIMEOUT_MS)

	it("returns an already captured proposal again without recapturing or modifying user files", async () => {
		const service = new ManagedSubagentWorktreeService()
		const capture = vi.spyOn(service, "capture")
		const first = await service.recoverOrphans(storage)
		const second = await new ManagedSubagentWorktreeService().recoverOrphans(storage)
		expect(first).toEqual([artifact])
		expect(second).toEqual(first)
		expect(first[0]).toMatchObject({
			groupId: "continuation-group",
			runId: "worker:continuation-run",
			partial: true,
			status: "pending_review",
		})
		expect(capture).not.toHaveBeenCalled()
		expect(await fs.readFile(path.join(repo, "src/value.txt"), "utf8")).toBe("user baseline\n")
	})

	it("does not recover a captured artifact while its task still has a live owner", async () => {
		const service = new ManagedSubagentWorktreeService()
		await expect(
			service.recoverOrphans(storage, { hasTaskOwner: (taskId) => taskId === "worker" }),
		).resolves.toEqual([])
		expect(await service.load(storage, artifact.id)).toEqual(artifact)
	})

	it("retries projection of an applied artifact without applying it again", async () => {
		const service = new ManagedSubagentWorktreeService()
		await service.apply(storage, artifact.id)
		const applied = await service.load(storage, artifact.id)
		const apply = vi.spyOn(service, "apply")
		await expect(service.recoverOrphans(storage)).resolves.toEqual([applied])
		await expect(service.recoverOrphans(storage)).resolves.toEqual([applied])
		expect(apply).not.toHaveBeenCalled()
		expect(await service.load(storage, artifact.id)).toEqual(applied)
		expect(await fs.readFile(path.join(repo, "src/value.txt"), "utf8")).toBe("captured worker change\n")
	})
})
