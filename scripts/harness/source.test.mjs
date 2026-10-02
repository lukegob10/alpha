import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { collectSource, comparableSource } from "./source.mjs"

test("content provenance detects edits with unchanged dirty status and excludes ignored artifacts", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-source-evidence-"))
	try {
		const git = (...args) => {
			const result = spawnSync("git", ["-c", "core.hooksPath=", ...args], {
				cwd: directory,
				encoding: "utf8",
				windowsHide: true,
			})
			assert.equal(result.status, 0, result.stderr)
		}
		git("init")
		await writeFile(path.join(directory, "pnpm-lock.yaml"), "lock")
		await writeFile(path.join(directory, ".gitignore"), "artifacts/\n")
		await writeFile(path.join(directory, "source.ts"), "original")
		git("add", ".")
		git("-c", "user.name=Evidence test", "-c", "user.email=evidence@example.invalid", "commit", "-m", "fixture")
		const baseline = await collectSource(directory)
		await writeFile(path.join(directory, "source.ts"), "first edit")
		const first = await collectSource(directory)
		await writeFile(path.join(directory, "source.ts"), "second edit")
		const second = await collectSource(directory)
		assert.equal(first.dirty, second.dirty)
		assert.equal(comparableSource(first, second), false)
		assert.equal(comparableSource(baseline, first), false)
		await mkdir(path.join(directory, "artifacts"))
		await writeFile(path.join(directory, "artifacts", "receipt.json"), "generated")
		assert.equal(comparableSource(second, await collectSource(directory)), true)
		await writeFile(path.join(directory, "new-test.ts"), "new regression")
		assert.equal(comparableSource(second, await collectSource(directory)), false)
		assert.equal(comparableSource({}, {}), false)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
