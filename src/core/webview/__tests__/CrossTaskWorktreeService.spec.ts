import { execFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "util"

import { describe, expect, it } from "vitest"

import { CrossTaskWorktreeService } from "../CrossTaskWorktreeService"

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true })
	return String(stdout).trim()
}

describe("CrossTaskWorktreeService", () => {
	it("starts at the repository HEAD, restores a nested workspace path, and removes its worktree cleanly", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-cross-task-worktree-"))
		const repository = path.join(root, "repository")
		const sourceWorkspace = path.join(repository, "packages", "editor")
		const globalStorage = path.join(root, "global-storage")
		await fs.mkdir(sourceWorkspace, { recursive: true })
		await fs.mkdir(globalStorage, { recursive: true })
		await fs.writeFile(path.join(sourceWorkspace, "tracked.txt"), "committed snapshot\n")
		await git(repository, ["init"])
		await git(repository, ["config", "user.name", "Alpha Test"])
		await git(repository, ["config", "user.email", "alpha-test@example.invalid"])
		await git(repository, ["add", "."])
		await git(repository, ["commit", "-m", "initial fixture"])
		await fs.writeFile(path.join(sourceWorkspace, "uncommitted.txt"), "must stay in the source checkout\n")

		const service = new CrossTaskWorktreeService()
		let worktree: Awaited<ReturnType<typeof service.create>> | undefined
		try {
			worktree = await service.create(globalStorage, "task-1", sourceWorkspace)
			expect(worktree.workspaceRelativePath).toBe("packages/editor")
			expect(
				(await fs.readFile(path.join(worktree.workspacePath, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"),
			).toBe("committed snapshot\n")
			await expect(fs.stat(path.join(worktree.workspacePath, "uncommitted.txt"))).rejects.toMatchObject({
				code: "ENOENT",
			})
			await expect(service.resolve(globalStorage, "task-1", worktree.workspaceRelativePath)).resolves.toBe(
				worktree.workspacePath,
			)
			await expect(service.resolve(globalStorage, "task-1", "../outside")).rejects.toThrow("path is invalid")
		} finally {
			await worktree?.cleanup()
		}
		const worktreePath = path.join(globalStorage, "cross-task-worktrees", "task-1")
		await expect(fs.stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await git(repository, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)
		await fs.rm(root, { recursive: true, force: true })
	})
})
