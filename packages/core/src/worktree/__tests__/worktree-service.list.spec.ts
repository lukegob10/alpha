import { WorktreeService } from "../worktree-service.js"

const { runGit } = vi.hoisted(() => ({ runGit: vi.fn() }))

vi.mock("util", () => ({ promisify: () => runGit }))

describe("WorktreeService.listWorktrees", () => {
	beforeEach(() => runGit.mockReset())

	it("surfaces listing failures when the caller presents errors", async () => {
		const failure = new Error("Git listing failed")
		runGit.mockRejectedValueOnce(failure)

		await expect(new WorktreeService().listWorktrees("/workspace", { throwOnError: true })).rejects.toBe(failure)
	})

	it("preserves the fallback for existing callers", async () => {
		runGit.mockRejectedValueOnce(new Error("Git unavailable"))

		await expect(new WorktreeService().listWorktrees("/workspace")).resolves.toEqual([])
	})

	it("returns registered worktrees when error reporting is enabled", async () => {
		runGit.mockResolvedValueOnce({
			stdout: "worktree /workspace\nHEAD abc123\nbranch refs/heads/main\n\n",
		})

		await expect(new WorktreeService().listWorktrees("/workspace", { throwOnError: true })).resolves.toEqual([
			expect.objectContaining({ path: "/workspace", branch: "main", isCurrent: true }),
		])
	})
})
