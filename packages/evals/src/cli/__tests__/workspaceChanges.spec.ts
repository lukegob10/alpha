import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ExecaHarnessProcessRunner } from "../../orchestration/index"
import { captureWorkspaceBaseline, collectChangedPaths } from "../workspaceChanges"

const runner = new ExecaHarnessProcessRunner()
let root: string

async function git(...args: string[]) {
	const result = await runner.run({ command: "git", args, cwd: root, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 })
	if (result.exitCode !== 0 || result.timedOut) throw new Error(`Git fixture failed: ${result.stderr}`)
	return result.stdout
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-grader-changes-"))
	await git("init", "--initial-branch=main")
	await git("config", "user.name", "Alpha Test")
	await git("config", "user.email", "alpha-test@invalid.local")
	await fs.mkdir(path.join(root, "workspace"))
	await fs.writeFile(path.join(root, "workspace", "original.txt"), "baseline\n")
	await fs.writeFile(path.join(root, ".gitignore"), "generated/\n")
	await git("add", ".")
	await git("commit", "-m", "fixture", "--no-gpg-sign")
})

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

describe("workspace change evidence", () => {
	it("retains committed rename endpoints, ignored files, and workspace-relative paths", async () => {
		const workspace = path.join(root, "workspace")
		const baseline = await captureWorkspaceBaseline(workspace, runner)
		await git("mv", "workspace/original.txt", "workspace/é renamed.txt")
		await git("commit", "-m", "agent commit", "--no-gpg-sign")
		await fs.mkdir(path.join(workspace, "generated"))
		await fs.writeFile(path.join(workspace, "generated", "hidden.js"), "forbidden")
		await fs.writeFile(path.join(root, "unrelated.txt"), "outside workspace")
		expect(await collectChangedPaths(workspace, runner, baseline)).toEqual([
			"generated/hidden.js",
			"original.txt",
			"é renamed.txt",
		])
	})

	it("detects a staged change even when the working file was restored to its baseline bytes", async () => {
		const baseline = await captureWorkspaceBaseline(root, runner)
		await fs.writeFile(path.join(root, "workspace", "original.txt"), "staged change\n")
		await git("add", "workspace/original.txt")
		await fs.writeFile(path.join(root, "workspace", "original.txt"), "baseline\n")
		expect(await collectChangedPaths(root, runner, baseline)).toEqual(["workspace/original.txt"])
	})

	it.each([
		{ flags: ["--skip-worktree"] },
		{ flags: ["--assume-unchanged"] },
		{ flags: ["--skip-worktree", "--assume-unchanged"] },
	])("rejects tracked mutations hidden by Git index flags: %j", async ({ flags }) => {
		const workspace = path.join(root, "workspace")
		const baseline = await captureWorkspaceBaseline(workspace, runner)
		for (const flag of flags) await git("update-index", flag, "--", "workspace/original.txt")
		await fs.writeFile(path.join(workspace, "original.txt"), "hidden mutation\n")
		const indexBefore = await fs.readFile(path.join(root, ".git", "index"))
		await expect(collectChangedPaths(workspace, runner, baseline)).rejects.toThrow(/suppressed by index flags/)
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(indexBefore)
	})

	it("detects ordinary tracked edits without rejecting unrelated index flags outside the workspace", async () => {
		const workspace = path.join(root, "workspace")
		const baseline = await captureWorkspaceBaseline(workspace, runner)
		await git("update-index", "--skip-worktree", "--", ".gitignore")
		await fs.writeFile(path.join(workspace, "original.txt"), "ordinary mutation\n")
		expect(await collectChangedPaths(workspace, runner, baseline)).toEqual(["original.txt"])
	})

	it.each(["H original.txt", "H \0", "X original.txt\0", "H original.txt\0\0"])(
		"rejects incomplete or malformed tagged index evidence: %j",
		async (stdout) => {
			const baseline = await captureWorkspaceBaseline(root, runner)
			const malformedRunner = {
				run: async (spec: Parameters<typeof runner.run>[0]) =>
					spec.args?.[0] === "ls-files" && spec.args.includes("-v")
						? { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }
						: runner.run(spec),
			}
			await expect(collectChangedPaths(root, malformedRunner, baseline)).rejects.toThrow(
				/(Incomplete|Invalid) workspace index evidence/,
			)
		},
	)

	it("fails closed when the captured baseline is no longer available", async () => {
		await expect(collectChangedPaths(root, runner, "0".repeat(40))).rejects.toThrow(/complete Git diff evidence/)
	})
})
