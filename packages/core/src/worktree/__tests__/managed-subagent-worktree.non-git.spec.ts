import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ManagedSubagentWorktreeService } from "../managed-subagent-worktree.js"

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 30_000

describe("Managed workers in folders without Git", () => {
	let root: string
	let workspace: string
	let storage: string
	let service: ManagedSubagentWorktreeService
	const write = async (relative: string, content: string, directory = workspace) => {
		const target = path.join(directory, relative)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, content)
	}
	const longStoragePath = () => {
		let target = path.join(root, "long storage")
		while (target.length < 218) {
			const size = Math.min(60, 218 - target.length - 1)
			if (size < 1) break
			target = path.join(target, "s".repeat(size))
		}
		return target
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-plain-worker-"))
		workspace = path.join(root, "plain folder")
		storage = path.join(root, "extension storage")
		await fs.mkdir(workspace)
		service = new ManagedSubagentWorktreeService()
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	}, TIMEOUT_MS)

	it(
		"launches an isolated worker from an empty plain folder without initializing its source",
		async () => {
			const scope = await service.validateScope(workspace, ["."], { allowWorkspaceRoot: true })
			const worker = await service.create(storage, "plain-worker", scope)
			expect(worker.workspacePath).not.toBe(workspace)
			await write("answer.txt", "worker answer\n", worker.workspacePath)
			await expect(fs.access(path.join(workspace, "answer.txt"))).rejects.toMatchObject({ code: "ENOENT" })
			const captured = await service.capture(storage, worker.artifact.id)
			expect(captured.status).toBe("pending_review")
			expect(captured.changes.map((change) => change.path)).toEqual(["answer.txt"])
			await expect(service.apply(storage, worker.artifact.id)).resolves.toEqual({ status: "applied" })
			expect(await fs.readFile(path.join(workspace, "answer.txt"), "utf8")).toBe("worker answer\n")
			await expect(fs.access(path.join(workspace, ".git"))).rejects.toMatchObject({ code: "ENOENT" })
		},
		TIMEOUT_MS,
	)

	it(
		"keeps concurrent worker proposals isolated and detects an intervening source edit",
		async () => {
			await write("notes.txt", "original\n")
			const scope = await service.validateScope(workspace, ["notes.txt"])
			const [first, second] = await Promise.all([
				service.create(storage, "first", scope),
				service.create(storage, "second", scope),
			])
			await write("notes.txt", "first proposal\n", first.workspacePath)
			await write("notes.txt", "second proposal\n", second.workspacePath)
			await Promise.all([
				service.capture(storage, first.artifact.id),
				service.capture(storage, second.artifact.id),
			])
			expect(await fs.readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("original\n")
			await expect(service.apply(storage, first.artifact.id)).resolves.toEqual({ status: "applied" })
			await expect(service.apply(storage, second.artifact.id)).resolves.toEqual({
				status: "conflicted",
				conflictPaths: ["notes.txt"],
			})
			await expect(service.discard(storage, second.artifact.id)).resolves.toMatchObject({ status: "discarded" })
			expect(await fs.readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("first proposal\n")
		},
		TIMEOUT_MS,
	)

	it(
		"recovers a cancelled worker's partial proposal after reload and leaves its source intact",
		async () => {
			await write("notes.txt", "original\n")
			const worker = await service.create(
				storage,
				"interrupted",
				await service.validateScope(workspace, ["notes.txt"]),
			)
			await write("notes.txt", "recoverable partial\n", worker.workspacePath)
			const recovered = await new ManagedSubagentWorktreeService().recoverOrphans(storage)
			expect(recovered).toHaveLength(1)
			expect(recovered[0]).toMatchObject({ taskId: "interrupted", status: "pending_review", partial: true })
			expect(recovered[0]!.worktreePath).toBeUndefined()
			expect(await fs.readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("original\n")
			await expect(service.apply(storage, worker.artifact.id)).resolves.toEqual({ status: "applied" })
			expect(await fs.readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("recoverable partial\n")
			await expect(fs.access(path.join(workspace, ".git"))).rejects.toMatchObject({ code: "ENOENT" })
		},
		TIMEOUT_MS,
	)

	it(
		"keeps ignore rules and quarantines out-of-scope edits",
		async () => {
			await write(".gitignore", "ignored/\n")
			await write("ignored/private.txt", "keep ignored\n")
			await write("allowed.txt", "original\n")
			await write("outside.txt", "keep source\n")
			const worker = await service.create(
				storage,
				"scope-test",
				await service.validateScope(workspace, ["allowed.txt"]),
			)
			await expect(fs.access(path.join(worker.workspacePath, "ignored", "private.txt"))).rejects.toMatchObject({
				code: "ENOENT",
			})
			await write("outside.txt", "forbidden proposal\n", worker.workspacePath)
			await expect(service.capture(storage, worker.artifact.id)).resolves.toMatchObject({
				status: "scope_violation",
			})
			await expect(service.apply(storage, worker.artifact.id)).rejects.toThrow("not available to apply")
			expect(await fs.readFile(path.join(workspace, "outside.txt"), "utf8")).toBe("keep source\n")
			expect(await fs.readFile(path.join(workspace, "ignored", "private.txt"), "utf8")).toBe("keep ignored\n")
		},
		TIMEOUT_MS,
	)

	it("retains physical scope and exact-file validation for plain folders", async () => {
		for (const scope of [["."], ["../outside"], [path.join(root, "outside")], ["*.txt"], [".git/config"]]) {
			await expect(service.validateScope(workspace, scope)).rejects.toThrow(/traversal|relative|globs|\.git/)
		}
		const scope = await service.validateScope(workspace, ["missing.txt"])
		expect(scope.fileWriteScope).toEqual(["missing.txt"])
		const outside = path.join(root, "outside")
		await fs.mkdir(outside)
		await fs.symlink(outside, path.join(workspace, "escaped"), process.platform === "win32" ? "junction" : "dir")
		await expect(service.validateScope(workspace, ["escaped/secret.txt"])).rejects.toThrow("symlink outside")
	})

	it("does not turn malformed Git metadata or Git execution errors into a plain-folder fallback", async () => {
		await write(".git", "invalid repository marker\n")
		await expect(service.validateScope(workspace, ["notes.txt"])).rejects.toThrow("Invalid Git worktree marker")
		await fs.unlink(path.join(workspace, ".git"))
		await execFileAsync("git", ["init"], { cwd: workspace, windowsHide: true })
		const gitFailure = new Error("Git metadata unreadable")
		const owner = service as unknown as { git: (cwd: string, args: string[]) => Promise<string> }
		vi.spyOn(owner, "git").mockRejectedValueOnce(gitFailure)
		await expect(service.validateScope(workspace, ["notes.txt"])).rejects.toBe(gitFailure)
	})

	it("retains rejection of bare repositories and damaged bare metadata", async () => {
		await execFileAsync("git", ["init", "--bare", workspace], { cwd: root, windowsHide: true })
		await expect(service.validateScope(workspace, ["notes.txt"])).rejects.toThrow()
		await fs.unlink(path.join(workspace, "HEAD"))
		await expect(service.validateScope(workspace, ["notes.txt"])).rejects.toThrow()
		await expect(fs.access(path.join(workspace, ".git"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it(
		"rejects a substituted private Git directory before applying a saved artifact",
		async () => {
			const worker = await service.create(
				storage,
				"ownership",
				await service.validateScope(workspace, ["notes.txt"]),
			)
			await write("notes.txt", "proposal\n", worker.workspacePath)
			const captured = await service.capture(storage, worker.artifact.id)
			const metadata = path.join(storage, "subagent-change-sets", captured.id, "metadata.json")
			await fs.writeFile(metadata, JSON.stringify({ ...captured, privateGitDir: path.join(root, "foreign.git") }))
			await expect(service.apply(storage, captured.id)).rejects.toThrow("outside its owned artifact")
			await fs.writeFile(metadata, JSON.stringify(captured))
			await service.deleteArtifact(storage, captured.id)
			await expect(fs.access(path.join(workspace, ".git"))).rejects.toMatchObject({ code: "ENOENT" })
		},
		TIMEOUT_MS,
	)

	it.skipIf(process.platform !== "win32")(
		"supports long private metadata paths without persisting temporary junctions",
		async () => {
			const longStorage = longStoragePath()
			await write("notes.txt", "original\n")
			const worker = await service.create(
				longStorage,
				"long-private",
				await service.validateScope(workspace, ["notes.txt"]),
			)
			try {
				await write("notes.txt", "long path proposal\n", worker.workspacePath)
				const recovered = await new ManagedSubagentWorktreeService().recoverOrphans(longStorage)
				expect(recovered).toHaveLength(1)
				const captured = recovered[0]!
				expect(captured).toMatchObject({ status: "pending_review", partial: true })
				expect(captured.worktreePath).toBeUndefined()
				const receiptPath = path.join(path.dirname(captured.privateGitDir!), "owner.json")
				const receipt = await fs.readFile(receiptPath, "utf8")
				await fs.writeFile(receiptPath, JSON.stringify({ ...JSON.parse(receipt), artifactDirectory: root }))
				await expect(service.deleteArtifact(longStorage, captured.id)).rejects.toThrow("owner receipt")
				await expect(fs.access(captured.privateGitDir!)).resolves.toBeUndefined()
				await fs.writeFile(receiptPath, receipt)
				const metadataPath = path.join(longStorage, "subagent-change-sets", captured.id, "metadata.json")
				await fs.writeFile(
					metadataPath,
					JSON.stringify({ ...captured, privateGitOwner: { ...captured.privateGitOwner, ino: "0" } }),
				)
				await expect(service.load(longStorage, captured.id)).rejects.toThrow("ownership changed")
				await fs.writeFile(metadataPath, JSON.stringify(captured))
				await expect(service.apply(longStorage, captured.id)).resolves.toEqual({ status: "applied" })
				expect(await fs.readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("long path proposal\n")
				const reloaded = await new ManagedSubagentWorktreeService().load(longStorage, captured.id)
				expect(reloaded.privateGitDir).toBe(
					path.join(os.homedir(), ".alpha", "worker-git", captured.id, "repository.git"),
				)
				expect(reloaded.privateGitOwner).toBeDefined()
				const ownerRoot = path.dirname(reloaded.privateGitDir!)
				expect(ownerRoot).toBe(path.join(os.homedir(), ".alpha", "worker-git", captured.id))
				await fs.rm(ownerRoot, { recursive: true, force: true })
				await expect(service.load(longStorage, captured.id)).resolves.toMatchObject({ status: "applied" })
			} finally {
				await service.deleteArtifact(longStorage, worker.artifact.id)
			}
			await expect(fs.access(path.join(workspace, ".git"))).rejects.toMatchObject({ code: "ENOENT" })
		},
		TIMEOUT_MS,
	)

	it(
		"deletes no-op task artifacts without touching unknown records or other tasks",
		async () => {
			const scope = await service.validateScope(workspace, ["notes.txt"])
			const worker = await service.create(storage, "no-op", scope)
			const other = await service.create(storage, "other-task", scope)
			const captured = await service.capture(storage, worker.artifact.id)
			expect(captured).toMatchObject({ status: "discarded", changes: [] })
			const unknown = path.join(storage, "subagent-change-sets", "unknown")
			await fs.mkdir(unknown)
			await fs.writeFile(path.join(unknown, "metadata.json"), JSON.stringify({ id: "unknown", taskId: "no-op" }))
			await service.deleteArtifactsForTasks(storage, ["no-op"])
			await expect(
				fs.access(path.join(storage, "subagent-change-sets", worker.artifact.id)),
			).rejects.toMatchObject({ code: "ENOENT" })
			await expect(service.load(storage, other.artifact.id)).resolves.toMatchObject({ taskId: "other-task" })
			await expect(fs.access(path.join(unknown, "metadata.json"))).resolves.toBeUndefined()
			await service.deleteArtifactsForTasks(storage, ["other-task"])
		},
		TIMEOUT_MS,
	)

	it.each([false, ...(process.platform === "win32" ? [true] : [])])(
		"retains a private database for nested worktrees and captured proposals until task deletion (short bucket=%s)",
		async (shortBucket) => {
			const longStorage = shortBucket ? longStoragePath() : storage
			await write("notes.txt", "original\n")
			const outer = await service.create(
				longStorage,
				"outer",
				await service.validateScope(workspace, ["notes.txt"]),
			)
			const nested = await service.create(
				longStorage,
				"nested",
				await service.validateScope(outer.workspacePath, ["notes.txt"]),
			)
			try {
				await write("notes.txt", "nested proposal\n", nested.workspacePath)
				const parent = await service.capture(longStorage, outer.artifact.id)
				expect(parent.status).toBe("discarded")
				await expect(service.deleteArtifact(longStorage, parent.id)).rejects.toThrow("registered worktrees")
				const child = await service.capture(longStorage, nested.artifact.id, true)
				expect(child.status).toBe("pending_review")
				expect(await fs.realpath(child.sourceGitCommonDir!)).toBe(
					await fs.realpath(outer.artifact.privateGitDir!),
				)
				await expect(service.deleteArtifact(longStorage, parent.id)).rejects.toThrow(
					"retained by another proposal",
				)
				await expect(fs.access(outer.artifact.privateGitDir!)).resolves.toBeUndefined()
				await service.deleteArtifactsForTasks(longStorage, ["outer", "nested"])
				await expect(fs.access(path.dirname(outer.artifact.privateGitDir!))).rejects.toMatchObject({
					code: "ENOENT",
				})
				expect(await fs.readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("original\n")
			} finally {
				await service.deleteArtifactsForTasks(longStorage, ["outer", "nested"])
			}
		},
		TIMEOUT_MS,
	)
})
