import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ execa: vi.fn() }))

vi.mock("execa", () => ({ execa: mocks.execa }))

import { commitEvalsRepoChanges, resetEvalsRepo } from "../utils"

afterEach(() => {
	mocks.execa.mockReset()
	vi.unstubAllEnvs()
})

it("never resolves a nested eval directory to its parent Git repository", async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "eval-parent-repo-"))
	const nested = path.join(parent, "evals")
	fs.mkdirSync(path.join(parent, ".git"))
	fs.mkdirSync(nested)

	try {
		const run = { id: "safety-test" } as never
		await resetEvalsRepo({ run, cwd: nested })
		await commitEvalsRepoChanges({ run, cwd: nested })
		expect(mocks.execa).not.toHaveBeenCalled()
	} finally {
		fs.rmSync(parent, { recursive: true, force: true })
	}
})
