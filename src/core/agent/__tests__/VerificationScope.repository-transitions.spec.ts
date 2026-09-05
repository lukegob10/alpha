import { execFile } from "child_process"
import fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { promisify } from "util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { fingerprintContent } from "../../tools/contentVersion"
import { captureWorkspaceMutationState, compareWorkspaceMutationState } from "../VerificationScope"

const execFileAsync = promisify(execFile)

describe("workspace verification across repository transitions", () => {
	let temporaryRoot: string
	let root: string

	beforeEach(async () => {
		temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-repository-transition-")))
		root = path.join(temporaryRoot, "workspace")
		await fs.mkdir(root)
	})

	afterEach(async () => {
		await fs.rm(temporaryRoot, { recursive: true, force: true })
	})

	const git = (args: string[], cwd = root) =>
		execFileAsync(
			"git",
			[
				"-c",
				"core.autocrlf=false",
				"-c",
				`core.hooksPath=${path.join(temporaryRoot, "no-hooks")}`,
				"-c",
				"commit.gpgsign=false",
				"-c",
				"user.name=Verification Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				...args,
			],
			{ cwd, windowsHide: true },
		)
	const write = async (file: string, content: string | Buffer) => {
		const absolute = path.join(root, file)
		await fs.mkdir(path.dirname(absolute), { recursive: true })
		await fs.writeFile(absolute, content)
	}
	const commit = async () => {
		await git(["add", "-A"])
		await git(["commit", "--quiet", "-m", "fixture"])
	}

	it("does not report unchanged git init -b main as a workspace mutation", async () => {
		await fs.writeFile(path.join(root, "source.ts"), "export const source = 1\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "-b", "main"])
		const after = await captureWorkspaceMutationState(root)

		expect(before.kind).toBe("files")
		expect(after.kind).toBe("git")
		expect(await compareWorkspaceMutationState(root, before, after)).toEqual({ changedPaths: [], files: {} })
	})

	it.each([["init"], ["init", "--initial-branch=main"], ["-C", ".", "init", "--quiet"]])(
		"compares content for equivalent repository initialization %j",
		async (...args) => {
			await write("source.ts", "original\n")
			const before = await captureWorkspaceMutationState(root)
			await git(args)
			expect(
				await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
			).toEqual({
				changedPaths: [],
				files: {},
			})
		},
	)

	it("keeps the bounded file observation scope when an empty workspace becomes a repository", async () => {
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--quiet"])
		const after = await captureWorkspaceMutationState(root, before)
		expect(after.kind).toBe("files")
		expect(after.files).toEqual({})
		expect(await compareWorkspaceMutationState(root, before, after)).toEqual({ changedPaths: [], files: {} })
	})

	it.each([false, true])("observes init with additions, edits, and deletions (commit: %s)", async (committed) => {
		await write("edited.ts", "original\n")
		await write("deleted.ts", "original\n")
		await write("unchanged.ts", "original\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "-b", "main"])
		await write("edited.ts", "updated\n")
		await write("added.ts", "new\n")
		await fs.unlink(path.join(root, "deleted.ts"))
		if (committed) await commit()

		expect(
			await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).toEqual({
			changedPaths: ["added.ts", "deleted.ts", "edited.ts"],
			files: {
				"added.ts": fingerprintContent("new\n"),
				"deleted.ts": "missing",
				"edited.ts": fingerprintContent("updated\n"),
			},
		})
	})

	it("does not treat unchanged initialization and initial commit as content changes", async () => {
		await write("source.ts", "original\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--quiet"])
		await commit()
		expect(
			await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).toEqual({
			changedPaths: [],
			files: {},
		})
	})

	it("preserves historical unknown-scope debt across reload after a later proven init no-op", async () => {
		const { AgentControlStore, InMemoryAgentControlPersistence } = await import("../AgentControlStore")
		const persistence = new InMemoryAgentControlPersistence()
		const store = new AgentControlStore(persistence)
		await store.initialize()
		await store.ensureRoot({ taskId: "root-1", objective: "Verify workspace changes", status: "running" })
		await store.reservePrimaryMutation("root-1", "root-1", root, "old-command")
		await store.recordPrimaryMutation({
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			workspacePath: root,
			fileVersions: { __unobserved_command_scope__: "old-execution" },
			scopeUnresolved: true,
			reservationToken: "old-command",
		})
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		await reloaded.reservePrimaryMutation("root-1", "root-1", root, "initialization-command")
		await write("source.ts", "original\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "-b", "main"])
		expect(
			await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).toEqual({
			changedPaths: [],
			files: {},
		})
		await reloaded.releasePrimaryMutation("root-1", "root-1", "initialization-command")
		const finalStore = new AgentControlStore(persistence)
		await finalStore.initialize()
		expect(finalStore.getVerificationObligations()).toMatchObject([
			{
				changedFiles: ["__unobserved_command_scope__"],
				scopeUnresolved: true,
				mutationReservations: [],
				status: "pending",
			},
		])
		expect(finalStore.getParentCompletionDecision("root-1").allowed).toBe(false)
	})

	it("observes files hidden by Git ignore rules during initialization", async () => {
		await write(".gitignore", "ignored/\n")
		await write("ignored/edited.ts", "original\n")
		await write("ignored/deleted.ts", "original\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--quiet"])
		await write("ignored/edited.ts", "updated\n")
		await write("ignored/added.ts", "new\n")
		await fs.unlink(path.join(root, "ignored/deleted.ts"))
		await commit()

		expect(
			await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).toEqual({
			changedPaths: ["ignored/added.ts", "ignored/deleted.ts", "ignored/edited.ts"],
			files: {
				"ignored/added.ts": fingerprintContent("new\n"),
				"ignored/deleted.ts": "missing",
				"ignored/edited.ts": fingerprintContent("updated\n"),
			},
		})
	})

	it("preserves verification when dirty bytes and deletions are committed unchanged", async () => {
		await git(["init", "--quiet"])
		await write("edited.ts", "original\n")
		await write("deleted.ts", "original\n")
		await commit()
		await write("edited.ts", "updated\n")
		await fs.unlink(path.join(root, "deleted.ts"))
		const before = await captureWorkspaceMutationState(root)
		await commit()
		expect(
			await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).toEqual({
			changedPaths: [],
			files: {},
		})
	})

	it("observes edits made and committed after a clean Git baseline", async () => {
		await git(["init", "--quiet"])
		await write("source.ts", "original\n")
		await commit()
		const before = await captureWorkspaceMutationState(root)
		await write("source.ts", "updated\n")
		await commit()
		expect(
			await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).toEqual({
			changedPaths: ["source.ts"],
			files: { "source.ts": fingerprintContent("updated\n") },
		})
	})

	it.each(["new untracked file", "same-HEAD dirty-file edit"])(
		"rejects a Git observation made stale by a later %s",
		async (change) => {
			await git(["init", "--quiet"])
			await write("source.ts", "original\n")
			await commit()
			await write("source.ts", "observed edit\n")
			const before = await captureWorkspaceMutationState(root)
			const after = await captureWorkspaceMutationState(root, before)
			if (change === "new untracked file") await write("added.ts", "unobserved addition\n")
			else await write("source.ts", "unobserved edit\n")
			expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(after.head)
			await expect(compareWorkspaceMutationState(root, before, after)).rejects.toThrow()
		},
	)

	it("observes reset restoring dirty bytes and deleted files to a clean Git tree", async () => {
		await git(["init", "--quiet"])
		await write("edited.ts", "original\n")
		await write("deleted.ts", "original\n")
		await commit()
		await write("edited.ts", "dirty edit\n")
		await fs.unlink(path.join(root, "deleted.ts"))
		const before = await captureWorkspaceMutationState(root)
		await git(["reset", "--hard", "HEAD"])
		const after = await captureWorkspaceMutationState(root, before)
		expect(after.head).toBe(before.head)
		expect(after.files).toEqual({})
		expect(await compareWorkspaceMutationState(root, before, after)).toEqual({
			changedPaths: ["deleted.ts", "edited.ts"],
			files: {
				"deleted.ts": fingerprintContent("original\n"),
				"edited.ts": fingerprintContent("original\n"),
			},
		})
	})

	it("compares initialization with an external Git directory and .git file", async () => {
		await write("source.ts", "original\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--separate-git-dir", path.join(temporaryRoot, "metadata")])
		expect((await fs.lstat(path.join(root, ".git"))).isFile()).toBe(true)
		expect(
			await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).toEqual({
			changedPaths: [],
			files: {},
		})
	})

	it("does not report a supported Git metadata relocation as a content change", async () => {
		await git(["init", "--quiet"])
		await write("source.ts", "original\n")
		await commit()
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--separate-git-dir", path.join(temporaryRoot, "metadata")])
		expect((await fs.lstat(path.join(root, ".git"))).isFile()).toBe(true)
		expect(
			await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).toEqual({
			changedPaths: [],
			files: {},
		})
	})

	it("preserves content observation inside a linked Git worktree", async () => {
		await git(["init", "--quiet"])
		await write("source.ts", "original\n")
		await commit()
		const worktree = path.join(temporaryRoot, "linked-worktree")
		await git(["worktree", "add", "--detach", worktree])
		const before = await captureWorkspaceMutationState(worktree)
		await git(["commit", "--allow-empty", "-m", "metadata only"], worktree)
		expect(
			await compareWorkspaceMutationState(
				worktree,
				before,
				await captureWorkspaceMutationState(worktree, before),
			),
		).toEqual({ changedPaths: [], files: {} })
	})

	it("keeps Git removal unknown when the baseline lacks clean working-tree bytes", async () => {
		await git(["init", "--quiet"])
		await write("source.ts", "original\n")
		await commit()
		const before = await captureWorkspaceMutationState(root)
		await fs.rename(path.join(root, ".git"), path.join(temporaryRoot, "metadata"))
		const after = await captureWorkspaceMutationState(root)
		expect(after.kind).toBe("files")
		await expect(compareWorkspaceMutationState(root, before, after)).rejects.toThrow()
	})

	it.each(["edit", "add", "delete"])("rejects an initialization result made stale by a later %s", async (change) => {
		await write(".gitignore", "ignored/\n")
		await write("ignored/source.ts", "original\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--quiet"])
		const after = await captureWorkspaceMutationState(root, before)
		if (change === "edit") await write("ignored/source.ts", "updated\n")
		if (change === "add") await write("ignored/added.ts", "new\n")
		if (change === "delete") await fs.unlink(path.join(root, "ignored/source.ts"))
		await expect(compareWorkspaceMutationState(root, before, after)).rejects.toThrow()
	})

	it("rejects comparison against a different workspace with identical bytes", async () => {
		await write("source.ts", "original\n")
		const before = await captureWorkspaceMutationState(root)
		const other = path.join(temporaryRoot, "other")
		await fs.mkdir(other)
		await fs.writeFile(path.join(other, "source.ts"), "original\n")
		await git(["init", "--quiet"], other)
		await expect(
			compareWorkspaceMutationState(other, before, await captureWorkspaceMutationState(other)),
		).rejects.toThrow()
		await expect(captureWorkspaceMutationState(other, before)).rejects.toThrow()
	})

	it("rejects a workspace directory replaced at the same path", async () => {
		await write("source.ts", "original\n")
		const before = await captureWorkspaceMutationState(root)
		await fs.rename(root, path.join(temporaryRoot, "previous-workspace"))
		await fs.mkdir(root)
		await write("source.ts", "original\n")
		await git(["init", "--quiet"])
		await expect(async () =>
			compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).rejects.toThrow()
	})

	it("rejects a workspace junction retargeted between observations", async () => {
		await write("source.ts", "original\n")
		const alias = path.join(temporaryRoot, "alias")
		await fs.symlink(root, alias, "junction")
		const before = await captureWorkspaceMutationState(alias)
		const other = path.join(temporaryRoot, "other")
		await fs.mkdir(other)
		await fs.writeFile(path.join(other, "source.ts"), "original\n")
		await git(["init", "--quiet"], other)
		await fs.unlink(alias)
		await fs.symlink(other, alias, "junction")
		await expect(
			compareWorkspaceMutationState(alias, before, await captureWorkspaceMutationState(alias)),
		).rejects.toThrow()
		await expect(captureWorkspaceMutationState(alias, before)).rejects.toThrow()
	})

	it("accepts a stable workspace junction alias across initialization", async () => {
		await write("source.ts", "original\n")
		const alias = path.join(temporaryRoot, "alias")
		await fs.symlink(root, alias, "junction")
		const before = await captureWorkspaceMutationState(alias)
		await git(["init", "--quiet"], alias)
		expect(
			await compareWorkspaceMutationState(alias, before, await captureWorkspaceMutationState(alias, before)),
		).toEqual({ changedPaths: [], files: {} })
	})

	it("rejects initialization that adds a symlink even when Git ignores it", async () => {
		await write(".gitignore", "escape\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--quiet"])
		await fs.symlink(temporaryRoot, path.join(root, "escape"), "junction")
		await expect(async () =>
			compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).rejects.toThrow()
	})

	it.each(["count", "bytes", "depth"])("rejects an initialized tree beyond the %s bound", async (bound) => {
		await write(".gitignore", "ignored/\n")
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--quiet"])
		if (bound === "count") {
			for (let index = 0; index < 257; index++) await write(`ignored/${index}.ts`, "")
		} else if (bound === "bytes") {
			await write("ignored/large.ts", Buffer.alloc(4 * 1_024 * 1_024 + 1))
		} else {
			await write(`${"ignored/".repeat(34)}source.ts`, "")
		}
		await expect(async () =>
			compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root, before)),
		).rejects.toThrow()
	})
})
