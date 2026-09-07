import * as assert from "node:assert/strict"
import { afterEach, beforeEach, mock, test } from "node:test"
import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { performance } from "node:perf_hooks"

import { auditRetainedStorage } from "./retainedStorageBudget"

let root: string

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-retained-storage-budget-")))
})

afterEach(async () => {
	mock.restoreAll()
	await fs.rm(root, { recursive: true, force: true })
})

function options(
	storagePath: string,
	assertOwned: (candidate: string) => Promise<void> = async () => {},
): Parameters<typeof auditRetainedStorage>[0] {
	return {
		roots: [{ path: storagePath, label: "storage" }],
		assertOwned,
	}
}

test("counts raw retained files, dotfiles, directories, and generated logs without reading contents", async () => {
	const storage = path.join(root, "storage")
	await fs.mkdir(path.join(storage, ".generated", "logs"), { recursive: true })
	const secret = "do-not-read-this-auth-secret"
	const raw = path.join(storage, "raw.auth.db")
	const hidden = path.join(storage, ".generated", "logs", ".renderer.log")
	await fs.writeFile(raw, secret)
	await fs.writeFile(hidden, "generated log")
	const beforeRaw = await fs.readFile(raw)
	const beforeHidden = await fs.readFile(hidden)

	const result = await auditRetainedStorage({
		...options(storage),
		limits: { maxBytes: 1_024, maxEntries: 10, maxDepth: 4 },
	})

	assert.deepEqual(result, {
		status: "within_budget",
		complete: true,
		bytes: Buffer.byteLength(secret) + Buffer.byteLength("generated log"),
		entries: 4,
		roots: 1,
	})
	assert.deepEqual(await fs.readFile(raw), beforeRaw)
	assert.deepEqual(await fs.readFile(hidden), beforeHidden)
})

test("returns a lower-bound entry-limit result before inspecting further entries", async () => {
	const storage = path.join(root, "storage")
	await fs.mkdir(storage)
	await fs.writeFile(path.join(storage, "first"), "1")
	await fs.writeFile(path.join(storage, "second"), "2")

	const result = await auditRetainedStorage({ ...options(storage), limits: { maxEntries: 1 } })

	assert.equal(result.status, "over_budget")
	assert.equal(result.complete, false)
	assert.equal(result.reason, "entry_limit")
	assert.equal(result.entries, 1)
	assert.ok(result.bytes <= 1)
})

test("deduplicates canonical aliases and overlapping roots", async () => {
	const storage = path.join(root, "storage")
	const nested = path.join(storage, "nested")
	await fs.mkdir(nested, { recursive: true })
	await fs.writeFile(path.join(storage, "root.log"), "root")
	await fs.writeFile(path.join(nested, "child.log"), "child")

	const owned: string[] = []
	const result = await auditRetainedStorage({
		roots: [
			{ path: path.join(storage, ".", "nested", ".."), label: "outer-alias" },
			{ path: nested, label: "nested" },
			{ path: storage, label: "outer" },
		],
		assertOwned: async (candidate) => {
			owned.push(candidate)
		},
		limits: { maxBytes: 1_024, maxEntries: 10 },
	})

	assert.equal(result.status, "within_budget")
	assert.equal(result.complete, true)
	assert.equal(result.roots, 1)
	assert.equal(result.entries, 3)
	assert.equal(result.bytes, 9)
	assert.equal(owned.length, 3)
	assert.ok(owned.every((candidate) => candidate === storage || candidate === nested))
})

test("fails closed on a symlink instead of skipping it", async (t) => {
	const storage = path.join(root, "storage")
	const outside = path.join(root, "outside")
	await fs.mkdir(storage)
	await fs.mkdir(outside)
	await fs.writeFile(path.join(outside, "secret.log"), "outside")
	try {
		await fs.symlink(outside, path.join(storage, "linked"), process.platform === "win32" ? "junction" : "dir")
	} catch (error) {
		t.skip(`symlink creation unavailable: ${String(error)}`)
		return
	}

	const result = await auditRetainedStorage(options(storage))

	assert.deepEqual(result, {
		status: "unknown",
		complete: false,
		bytes: 0,
		entries: 1,
		roots: 1,
		reason: "symlink",
	})
	assert.equal(await fs.readFile(path.join(outside, "secret.log"), "utf8"), "outside")
})

test("fails closed on normal missing roots and only allows explicitly validated missing roots", async () => {
	const parent = path.join(root, "parent")
	await fs.mkdir(parent)
	const missing = path.join(parent, "not-created")
	let called = 0

	const rejected = await auditRetainedStorage({
		...options(missing, async () => {
			called++
		}),
	})
	assert.equal(rejected.status, "unknown")
	assert.equal(rejected.reason, "unreadable")
	assert.equal(called, 0)

	const resolvedPaths: string[] = []
	const allowed = await auditRetainedStorage({
		roots: [{ path: missing, label: "optional", allowMissing: true }],
		assertOwned: async (candidate) => {
			resolvedPaths.push(candidate)
		},
	})
	assert.deepEqual(allowed, {
		status: "within_budget",
		complete: true,
		bytes: 0,
		entries: 0,
		roots: 1,
	})
	assert.deepEqual(resolvedPaths, [missing])
})

test("fails closed when a file changes during the streamed audit", async () => {
	const storage = path.join(root, "storage")
	const file = path.join(storage, "state.json")
	await fs.mkdir(storage)
	await fs.writeFile(file, "state")

	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	const lstat = underlying.lstat
	let fileLstatCalls = 0
	mock.method(underlying, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		const result = await lstat(...args)
		if (path.resolve(String(args[0])) === file) {
			fileLstatCalls++
			if (fileLstatCalls === 3) {
				await fs.writeFile(file, "changed-state")
				return lstat(...args)
			}
		}
		return result
	})

	const result = await auditRetainedStorage(options(storage))

	assert.equal(fileLstatCalls, 3)
	assert.equal(result.status, "unknown")
	assert.equal(result.complete, false)
	assert.equal(result.reason, "changed")
	assert.equal(result.entries, 1)
})

test("returns aborted before scanning when the signal is already aborted", async () => {
	const storage = path.join(root, "storage")
	await fs.mkdir(storage)
	await fs.writeFile(path.join(storage, "state.json"), "state")
	const controller = new AbortController()
	controller.abort()

	const result = await auditRetainedStorage({ ...options(storage), signal: controller.signal })

	assert.deepEqual(result, {
		status: "unknown",
		complete: false,
		bytes: 0,
		entries: 0,
		roots: 0,
		reason: "aborted",
	})
})

test("rejects invalid limits before making filesystem calls", async () => {
	const storage = path.join(root, "storage")
	await fs.mkdir(storage)
	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	let calls = 0
	const realLstat = underlying.lstat
	const realOpendir = underlying.opendir
	mock.method(underlying, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		calls++
		return realLstat(...args)
	})
	mock.method(underlying, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
		calls++
		return realOpendir(...args)
	})

	await assert.rejects(
		auditRetainedStorage({ ...options(storage), limits: { maxBytes: 0 } }),
		/Invalid retained storage limit: maxBytes/,
	)
	await assert.rejects(
		auditRetainedStorage({ ...options(storage), limits: { maxEntries: 1_000_001 } }),
		/Invalid retained storage limit: maxEntries/,
	)
	await assert.rejects(
		auditRetainedStorage({ ...options(storage), limits: { maxDepth: 33 } }),
		/Invalid retained storage limit: maxDepth/,
	)
	assert.equal(calls, 0)
})

test("a byte threshold blocks admission without reading or deleting any raw file contents", async () => {
	const storage = path.join(root, "storage")
	await fs.mkdir(storage)
	const raw = path.join(storage, "auth.db")
	await fs.writeFile(raw, "PRIVATE".repeat(1_000))
	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	mock.method(underlying, "readFile", async () => {
		assert.fail("Storage admission must not read contents")
	})
	const result = await auditRetainedStorage({ ...options(storage), limits: { maxBytes: 100 } })
	assert.equal(result.status, "over_budget")
	assert.equal(result.reason, "byte_limit")
	assert.equal(result.complete, false)
	assert.equal(result.bytes, 7_000)
	mock.restoreAll()
	assert.equal(await fs.readFile(raw, "utf8"), "PRIVATE".repeat(1_000))
})

test("rejects an existing root replaced between ownership validation and scanning", async () => {
	const storage = path.join(root, "storage")
	await fs.mkdir(storage)
	await fs.writeFile(path.join(storage, "retained.log"), "keep")
	const backup = path.join(root, "retained-original")
	const result = await auditRetainedStorage(
		options(storage, async () => {
			await fs.rename(storage, backup)
			await fs.mkdir(storage)
		}),
	)
	assert.equal(result.status, "unknown")
	assert.equal(result.reason, "changed")
	assert.equal(await fs.readFile(path.join(backup, "retained.log"), "utf8"), "keep")
})

test("an explicitly missing root cannot silently become populated while another root is scanned", async () => {
	const existing = path.join(root, "existing")
	const missing = path.join(root, "missing")
	await fs.mkdir(existing)
	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	const opendir = underlying.opendir
	mock.method(underlying, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
		await fs.mkdir(missing)
		await fs.writeFile(path.join(missing, "late.log"), "keep")
		return opendir(...args)
	})
	const result = await auditRetainedStorage({
		roots: [
			{ path: existing, label: "existing" },
			{ path: missing, label: "missing", allowMissing: true },
		],
		assertOwned: async () => {},
	})
	assert.equal(result.status, "unknown")
	assert.equal(result.reason, "changed")
	assert.equal(await fs.readFile(path.join(missing, "late.log"), "utf8"), "keep")
})

test("empty or unbounded root lists cannot bypass the admission check", async () => {
	await assert.rejects(auditRetainedStorage({ roots: [], assertOwned: async () => {} }))
	await assert.rejects(
		auditRetainedStorage({
			roots: Array.from({ length: 17 }, () => ({ path: root, label: "root" })),
			assertOwned: async () => {},
		}),
	)
})

test("healthy retained storage can finish beyond ten seconds without weakening byte or entry limits", async () => {
	const storage = path.join(root, "storage")
	await fs.mkdir(storage)
	await fs.writeFile(path.join(storage, "retained.log"), "keep")
	let monotonicTime = 0
	mock.method(performance, "now", () => monotonicTime)
	const result = await auditRetainedStorage({
		...options(storage, async () => {
			monotonicTime = 20_000
		}),
		limits: { maxBytes: 4, maxEntries: 1 },
	})
	assert.equal(result.status, "within_budget")
	assert.equal(result.complete, true)
	assert.equal(result.bytes, 4)
	assert.equal(result.entries, 1)
})

test("permission failures stay unreadable, distinct from scan timeouts", async () => {
	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	mock.method(underlying, "lstat", async () => {
		throw Object.assign(new Error("denied"), { code: "EACCES" })
	})
	const result = await auditRetainedStorage(options(root))
	assert.equal(result.status, "unknown")
	assert.equal(result.reason, "unreadable")
})

test("the scan deadline uses monotonic time and reports timeout rather than unreadable data", async () => {
	const storage = path.join(root, "storage")
	await fs.mkdir(storage)
	let monotonicTime = 1_000
	let wallTime = 100_000
	let wallReads = 0
	mock.method(performance, "now", () => monotonicTime)
	mock.method(Date, "now", () => {
		wallReads++
		wallTime -= 60_000
		return wallTime
	})
	const result = await auditRetainedStorage(
		options(storage, async () => {
			monotonicTime += 30_001
		}),
	)
	assert.equal(result.status, "unknown")
	assert.equal(result.reason, "timeout")
	assert.equal(result.complete, false)
	assert.equal(wallReads, 0)
})
