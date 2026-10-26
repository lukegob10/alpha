import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"
import { execFile } from "child_process"
import { promisify } from "util"

import { WorktreeService } from "../worktree-service.js"
import { createWorktreeGitEnvironment } from "../git-environment.js"

const execFileAsync = promisify(execFile)

describe("WorktreeService", () => {
	describe("checkoutBranch", { timeout: 30_000 }, () => {
		let repository: string
		const git = async (...args: string[]) =>
			(
				await execFileAsync("git", args, {
					cwd: repository,
					env: createWorktreeGitEnvironment(),
					windowsHide: true,
				})
			).stdout.trim()

		beforeEach(async () => {
			repository = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worktree-checkout-"))
			await git("init", "--template=")
			await fs.writeFile(path.join(repository, "tracked.txt"), "committed\n")
			await git("add", "tracked.txt")
			await git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@local.invalid",
				"commit",
				"--no-gpg-sign",
				"-m",
				"initial",
			)
			await fs.writeFile(path.join(repository, "tracked.txt"), "user changes\n")
		})

		afterEach(async () => {
			const relative = path.relative(os.tmpdir(), repository)
			expect(relative.startsWith("alpha-worktree-checkout-") && !relative.includes(path.sep)).toBe(true)
			await fs.rm(repository, { recursive: true, force: true })
		})

		it("rejects paths, options and commits without discarding user edits", async () => {
			const service = new WorktreeService()
			const branch = await git("branch", "--show-current")
			for (const input of [".", "tracked.txt", "--force", "-f", "--detach", "HEAD", "HEAD~0", ""]) {
				expect((await service.checkoutBranch(repository, input)).success, input).toBe(false)
				expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8"), input).toBe("user changes\n")
				expect(await git("branch", "--show-current"), input).toBe(branch)
			}
		})

		it("switches an existing branch even when its name is also a tracked path", async () => {
			await git("branch", "tracked.txt")

			expect((await new WorktreeService().checkoutBranch(repository, "tracked.txt")).success).toBe(true)
			expect(await git("branch", "--show-current")).toBe("tracked.txt")
			expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("user changes\n")
		})
	})
})
