import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import mutableFs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"

import { applyPatchPlan, getPatchFailureReceipt, type PatchEdit, type PatchPlan } from "../patchPlan"

const MAX_REPLACEMENT_BYTES = 256 * 1024

test("exclusive publication preserves a concurrent target and returns its recoverable original", async (context) => {
	const root = await fs.realpath(await makeRoot())
	context.after(() => removeRoot(root))
	await writeText(root, "src/race.ts", "original")
	const target = path.join(root, "src/race.ts")
	const originalLink = mutableFs.link
	let inserted = false
	context.mock.method(mutableFs, "link", async (source: string, destination: string) => {
		if (destination === target && !inserted) {
			inserted = true
			await fs.writeFile(target, "external change", { flag: "wx" })
		}
		return originalLink(source, destination)
	})
	await assert.rejects(
		applyPatchPlan(root, ["src/race.ts"], {
			id: "collision",
			edits: [makeEdit("src/race.ts", "original", "replacement")],
		}),
		(asyncError) => {
			const receipt = getPatchFailureReceipt(asyncError)
			assert.equal(receipt?.files.length, 0)
			assert.equal(receipt?.recoveryBackups?.length, 1)
			return true
		},
	)
	assert.equal(await fs.readFile(target, "utf8"), "external change")
})

test("cancellation after publication retains a partial receipt and does not mutate later files", async (context) => {
	const root = await fs.realpath(await makeRoot())
	context.after(() => removeRoot(root))
	await writeText(root, "src/first.ts", "first")
	await writeText(root, "src/second.ts", "second")
	const abort = new AbortController()
	const originalLink = mutableFs.link
	context.mock.method(mutableFs, "link", async (source: string, destination: string) => {
		await originalLink(source, destination)
		if (destination === path.join(root, "src/first.ts")) abort.abort()
	})
	await assert.rejects(
		applyPatchPlan(
			root,
			["src/first.ts", "src/second.ts"],
			{
				id: "partial",
				edits: [makeEdit("src/first.ts", "first", "changed"), makeEdit("src/second.ts", "second", "changed")],
			},
			abort.signal,
		),
		(error) => {
			const receipt = getPatchFailureReceipt(error)
			assert.equal(receipt?.files.length, 1)
			assert.equal(receipt?.files[0]?.path, "src/first.ts")
			assert.equal(receipt?.recoveryBackups?.length, 1)
			return true
		},
	)
	assert.equal(await fs.readFile(path.join(root, "src/second.ts"), "utf8"), "second")
})

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}

function makeEdit(relativePath: string, before: string, replacement: string): PatchEdit {
	return { path: relativePath, expectedSha256: sha256(before), replacement }
}

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-nor43-patch-"))
	await fs.mkdir(path.join(root, "src"), { recursive: true })
	await fs.mkdir(path.join(root, "webview-ui", "src"), { recursive: true })
	await fs.mkdir(path.join(root, "apps", "vscode-e2e", "src"), { recursive: true })
	return root
}

async function writeText(root: string, relativePath: string, contents: string): Promise<void> {
	const filePath = path.join(root, ...relativePath.split("/"))
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, contents, { encoding: "utf8", flag: "wx" })
}

async function removeRoot(root: string): Promise<void> {
	await fs.rm(root, { recursive: true, force: true })
}

test("applies an explicitly allowed normalized source plan and returns hashes", async () => {
	const root = await makeRoot()
	try {
		const firstBefore = "export const first = 1\n"
		const secondBefore = "export const second = 2\n"
		await writeText(root, "src/first.ts", firstBefore)
		await writeText(root, "webview-ui/src/second.tsx", secondBefore)

		const firstReplacement = "export const first = 10\n"
		const secondReplacement = "export const second = 20\n"
		const plan: PatchPlan = {
			id: "NOR-43-success",
			edits: [
				makeEdit("src/first.ts", firstBefore, firstReplacement),
				makeEdit("webview-ui\\src\\second.tsx", secondBefore, secondReplacement),
			],
		}

		const receipt = await applyPatchPlan(root, ["src\\first.ts", "webview-ui/src/second.tsx"], plan)
		assert.deepEqual(
			{ planId: receipt.planId, files: receipt.files },
			{
				planId: plan.id,
				files: [
					{ path: "src/first.ts", beforeSha256: sha256(firstBefore), afterSha256: sha256(firstReplacement) },
					{
						path: "webview-ui/src/second.tsx",
						beforeSha256: sha256(secondBefore),
						afterSha256: sha256(secondReplacement),
					},
				],
			},
		)
		assert.equal(await fs.readFile(path.join(root, "src/first.ts"), "utf8"), firstReplacement)
		assert.equal(receipt.recoveryBackups?.length, 2)
		assert.equal(await fs.readFile(path.join(root, receipt.recoveryBackups![0]!.backupPath), "utf8"), firstBefore)
		assert.equal(await fs.readFile(path.join(root, "webview-ui/src/second.tsx"), "utf8"), secondReplacement)
	} finally {
		await removeRoot(root)
	}
})

test("validates every hash before writing and preserves a later externally changed file", async () => {
	const root = await makeRoot()
	try {
		const firstBefore = "export const first = 1\n"
		const secondBefore = "export const second = 2\n"
		const externalSecond = "export const second = 999\n"
		await writeText(root, "src/first.ts", firstBefore)
		await writeText(root, "src/second.ts", secondBefore)
		await fs.writeFile(path.join(root, "src/second.ts"), externalSecond, "utf8")

		const plan: PatchPlan = {
			id: "NOR-43-stale",
			edits: [
				makeEdit("src/first.ts", firstBefore, "export const first = 10\n"),
				makeEdit("src/second.ts", secondBefore, "export const second = 20\n"),
			],
		}

		await assert.rejects(applyPatchPlan(root, ["src/first.ts", "src/second.ts"], plan), /hash mismatch/)
		assert.equal(await fs.readFile(path.join(root, "src/first.ts"), "utf8"), firstBefore)
		assert.equal(await fs.readFile(path.join(root, "src/second.ts"), "utf8"), externalSecond)
	} finally {
		await removeRoot(root)
	}
})

test("rejects traversal, absolute, duplicate, protected, and generated paths", async () => {
	const root = await makeRoot()
	try {
		const candidates = [
			"../src/file.ts",
			"src/../file.ts",
			"src\\..\\file.ts",
			path.join(root, "src", "file.ts"),
			"apps/cli/src/file.ts",
			"packages/vscode-shim/src/file.ts",
			"src/dist/file.ts",
			"src/AGENTS.md",
			"src/.gitignore",
			"src/.alphaignore",
			"src/pnpm-lock.yaml",
			"src/package.json",
		]

		for (const [index, candidate] of candidates.entries()) {
			const plan: PatchPlan = {
				id: `NOR-43-path-${index}`,
				edits: [{ path: candidate, expectedSha256: "0".repeat(64), replacement: "x" }],
			}
			await assert.rejects(applyPatchPlan(root, [candidate], plan))
		}

		const valid = makeEdit("src/file.ts", "before\n", "after\n")
		await writeText(root, "src/file.ts", "before\n")
		await assert.rejects(
			applyPatchPlan(root, ["src/file.ts", "src\\file.ts"], { id: "NOR-43-duplicate", edits: [valid] }),
			/duplicate/,
		)
	} finally {
		await removeRoot(root)
	}
})

test("rejects symlink and reparse-point escapes without touching the outside file", async () => {
	const root = await makeRoot()
	const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-nor43-outside-"))
	const linkPath = path.join(root, "src", "linked")
	try {
		const outsideFile = path.join(outsideRoot, "outside.ts")
		const outsideBefore = "export const outside = true\n"
		await fs.writeFile(outsideFile, outsideBefore, "utf8")
		await fs.symlink(outsideRoot, linkPath, process.platform === "win32" ? "junction" : "dir")

		const plan: PatchPlan = {
			id: "NOR-43-symlink",
			edits: [makeEdit("src/linked/outside.ts", outsideBefore, "export const outside = false\n")],
		}
		await assert.rejects(applyPatchPlan(root, ["src/linked/outside.ts"], plan), /symlink|reparse|outside/i)
		assert.equal(await fs.readFile(outsideFile, "utf8"), outsideBefore)
	} finally {
		await fs.rm(linkPath, { recursive: true, force: true }).catch(() => undefined)
		await removeRoot(root)
		await removeRoot(outsideRoot)
	}
})

test("rejects binary targets and replacement payloads over the bounded size", async () => {
	const root = await makeRoot()
	try {
		const binaryPath = path.join(root, "src", "binary.ts")
		const binary = Buffer.from([0, 1, 2, 3])
		await fs.writeFile(binaryPath, binary, { flag: "wx" })
		await assert.rejects(
			applyPatchPlan(root, ["src/binary.ts"], {
				id: "NOR-43-binary",
				edits: [{ path: "src/binary.ts", expectedSha256: sha256(binary), replacement: "text" }],
			}),
			/UTF-8 text/,
		)
		assert.deepEqual(await fs.readFile(binaryPath), binary)

		const before = "export const bounded = true\n"
		await writeText(root, "src/bounded.ts", before)
		const oversized = "x".repeat(MAX_REPLACEMENT_BYTES + 1)
		await assert.rejects(
			applyPatchPlan(root, ["src/bounded.ts"], {
				id: "NOR-43-size",
				edits: [makeEdit("src/bounded.ts", before, oversized)],
			}),
			/replacements exceed/,
		)
		assert.equal(await fs.readFile(path.join(root, "src/bounded.ts"), "utf8"), before)
	} finally {
		await removeRoot(root)
	}
})
