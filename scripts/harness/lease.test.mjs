import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { acquireBuildLease } from "./lease.mjs"

test("a second build or host cannot replace binaries in use; release permits next lane", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "alpha-build-lease-"))
	try {
		const release = await acquireBuildLease(root, "host")
		await assert.rejects(acquireBuildLease(root, "unit"), /Another build\/host lane owns/)
		await release()
		const next = await acquireBuildLease(root, "unit")
		await next()
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
