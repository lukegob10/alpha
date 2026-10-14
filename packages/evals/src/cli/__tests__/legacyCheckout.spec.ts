import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execa } from "execa"
import { expect, it, vi } from "vitest"
import type { Run } from "../../db/index"
import { resetEvalsRepo, commitEvalsRepoChanges } from "../utils"

it("rejects reset and commit inside a shared repository before mutations", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "evals-checkout-"))
	try {
		vi.stubEnv("ALPHA_EVALS_REPO_PATH", "")
		await execa("git", ["init", root])
		const cwd = path.join(root, "evals")
		await fs.mkdir(cwd)
		await fs.writeFile(path.join(cwd, "keep.txt"), "untracked user content")
		const run = { id: 1 } as Run
		await expect(resetEvalsRepo({ run, cwd })).rejects.toThrow("dedicated repository root")
		await expect(commitEvalsRepoChanges({ run, cwd })).rejects.toThrow("dedicated repository root")
		expect(await fs.readFile(path.join(cwd, "keep.txt"), "utf8")).toBe("untracked user content")
	} finally {
		vi.unstubAllEnvs()
		await fs.rm(root, { recursive: true, force: true })
	}
})
