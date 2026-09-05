import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isAllowed } from "../src/paths.js"

test("canonical path guard enforces workspace boundaries including symlinks", async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-scope-paths-"))
	try {
		const root = path.join(temp, "project")
		const outside = path.join(temp, "project-secret")
		await fs.mkdir(root)
		await fs.mkdir(outside)
		await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir")
		assert.equal(await isAllowed(root, root), true)
		assert.equal(await isAllowed(root, outside), false)
		assert.equal(await isAllowed(root, path.join(root, "..", "project-secret")), false)
		assert.equal(await isAllowed(root, path.join(root, "escape")), false)
	} finally {
		await fs.rm(temp, { recursive: true, force: true })
	}
})
