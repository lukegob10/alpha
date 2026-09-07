import { execFile } from "child_process"
import fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { promisify } from "util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ToolUse } from "../../../shared/tools"
import { fingerprintContent } from "../../tools/contentVersion"
import {
	captureGitMutationState,
	captureVerificationContent,
	captureWorkspaceMutationState,
	compareGitMutationState,
	compareWorkspaceMutationState,
	extractMutationPaths,
	resolveCommandVerification,
} from "../VerificationScope"

const execFileAsync = promisify(execFile)

describe("verification scope observations", () => {
	let root: string
	let outside: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-verification-")))
		outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-verification-outside-")))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	})

	const write = async (file: string, content: string | Buffer) => {
		const absolute = path.join(root, file)
		await fs.mkdir(path.dirname(absolute), { recursive: true })
		await fs.writeFile(absolute, content)
	}
	const resolve = (command: string, cwd = root, changedFiles?: readonly string[]) =>
		resolveCommandVerification({ workspaceRoot: root, cwd, command, changedFiles })
	const git = (args: string[]) =>
		execFileAsync(
			"git",
			[
				"-c",
				"core.autocrlf=false",
				"-c",
				`core.hooksPath=${path.join(root, ".no-hooks")}`,
				"-c",
				"commit.gpgsign=false",
				"-c",
				"user.name=Verification Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				...args,
			],
			{ cwd: root, windowsHide: true },
		)

	it("observes content, missing/deleted paths, aliases, binary bytes, and prototype-like file names", async () => {
		await write("nested/file.ts", "one")
		await write("image.png", Buffer.from([0xff]))
		await write("__proto__", "ordinary file")
		const first = await captureVerificationContent(root, [
			"nested/file.ts",
			"image.png",
			"__proto__",
			"new/file.ts",
		])
		expect(first["nested/file.ts"]).toBe(fingerprintContent("one"))
		expect(first["new/file.ts"]).toBe("missing")
		expect(Object.keys(first)).toContain("__proto__")
		await write("image.png", Buffer.from([0xfe]))
		await fs.unlink(path.join(root, "nested/file.ts"))
		const second = await captureVerificationContent(root, ["nested/file.ts", "image.png"])
		expect(second["nested/file.ts"]).toBe("missing")
		expect(second["image.png"]).not.toBe(first["image.png"])
		expect(await captureVerificationContent(root, ["sub/../image.png"])).toEqual({
			"image.png": second["image.png"],
		})
	})

	it("rejects lexical and realpath escapes, including a missing file below a junction", async () => {
		await fs.writeFile(path.join(outside, "file.ts"), "private")
		await fs.symlink(outside, path.join(root, "escape"), "junction")
		await expect(captureVerificationContent(root, [path.join(outside, "file.ts")])).rejects.toThrow("outside")
		await expect(captureVerificationContent(root, ["escape/file.ts"])).rejects.toThrow("outside")
		await expect(captureVerificationContent(root, ["escape/missing.ts"])).rejects.toThrow("outside")
		await expect(resolve("vitest run", path.join(root, "escape"))).rejects.toThrow("outside")
	})

	it("resolves workspace junction aliases without changing content keys or admitted command scope", async () => {
		await write("src/source.ts", "export const value = 1")
		const alias = path.join(outside, "workspace-alias")
		await fs.symlink(root, alias, "junction")
		for (const cwd of [path.join(alias, "src"), path.join(root, "src")]) {
			await expect(
				resolveCommandVerification({
					workspaceRoot: alias,
					cwd,
					command: "vitest run",
					changedFiles: ["src/source.ts"],
				}),
			).resolves.toMatchObject({
				scopePath: root,
				assurance: "process",
				matchedFiles: ["src/source.ts"],
			})
		}
		await expect(captureVerificationContent(alias, [path.join(alias, "src/source.ts")])).resolves.toEqual({
			"src/source.ts": fingerprintContent("export const value = 1"),
		})
	})

	it("still rejects traversal and outward junctions through a workspace alias", async () => {
		const alias = path.join(outside, "workspace-alias")
		await fs.symlink(root, alias, "junction")
		await fs.symlink(outside, path.join(root, "escape"), "junction")
		await expect(
			resolveCommandVerification({ workspaceRoot: alias, cwd: "..", command: "vitest run" }),
		).rejects.toThrow("outside")
		await expect(
			resolveCommandVerification({
				workspaceRoot: alias,
				cwd: path.join(alias, "escape"),
				command: "vitest run",
			}),
		).rejects.toThrow("outside")
		await expect(captureVerificationContent(alias, [path.join(alias, "escape/missing.ts")])).rejects.toThrow(
			"outside",
		)
	})

	it.skipIf(process.platform !== "win32")(
		"admits the actual Windows temporary-directory short alias",
		async (context) => {
			const alias = path.join(tmpdir(), path.basename(root))
			if (alias === root) context.skip("This host does not expose a short temporary-directory alias")
			expect(await fs.realpath(alias)).toBe(root)
			await expect(
				resolveCommandVerification({ workspaceRoot: alias, cwd: alias, command: "vitest run" }),
			).resolves.toMatchObject({ scopePath: root })
		},
	)

	it("does not treat directories, excessive files, or oversized content as an empty observation", async () => {
		await write("large.ts", "")
		await fs.truncate(path.join(root, "large.ts"), 4 * 1_024 * 1_024 + 1)
		await expect(captureVerificationContent(root, ["large.ts"])).rejects.toThrow("bounded regular file")
		await expect(captureVerificationContent(root, ["."])).rejects.toThrow("bounded regular file")
		await expect(
			captureVerificationContent(
				root,
				Array.from({ length: 257 }, (_, index) => `${index}.ts`),
			),
		).rejects.toThrow("count exceeds")
	})

	it("rejects a content race at the final pathname check instead of returning the old version", async () => {
		await write("source.ts", "before")
		const originalStat = fs.stat.bind(fs)
		vi.spyOn(fs, "stat").mockImplementationOnce(async () => {
			await write("source.ts", "changed during observation")
			return originalStat(path.join(root, "source.ts"))
		})
		await expect(captureVerificationContent(root, ["source.ts"])).rejects.toThrow("changed while")
	})

	it("enforces the aggregate byte bound across individually bounded files", async () => {
		const files = ["one.ts", "two.ts", "three.ts", "four.ts", "five.ts"]
		for (const file of files) {
			await write(file, "")
			await fs.truncate(path.join(root, file), 4 * 1_024 * 1_024)
		}
		await expect(captureVerificationContent(root, files)).rejects.toThrow("bounded regular file")
	})

	it.each([
		["write_to_file", "path"],
		["apply_diff", "path"],
		["edit", "file_path"],
		["edit_file", "file_path"],
		["search_replace", "file_path"],
		["search_and_replace", "file_path"],
	] as const)("captures the %s mutation path from native and legacy arguments", (name, parameter) => {
		const block: ToolUse = { type: "tool_use", name, params: { [parameter]: "legacy.ts" }, partial: false }
		expect(extractMutationPaths(block)).toEqual(["legacy.ts"])
		expect(extractMutationPaths({ ...block, nativeArgs: { [parameter]: "native.ts" } } as ToolUse)).toEqual([
			"native.ts",
		])
	})

	it.each(["image.png", "image.JPG", "image.jpeg"])(
		"captures an explicit image destination %s without appending a suffix",
		(imagePath) => {
			const block: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: { path: imagePath },
				partial: false,
			}
			expect(extractMutationPaths(block)).toEqual([imagePath])
			expect(extractMutationPaths({ ...block, nativeArgs: { prompt: "fixture", path: imagePath } })).toEqual([
				imagePath,
			])
		},
	)

	it("extracts every patch source/destination and fails closed for malformed mutations", () => {
		const block: ToolUse<"apply_patch"> = {
			type: "tool_use",
			name: "apply_patch",
			params: {},
			partial: false,
			nativeArgs: {
				patch: "*** Begin Patch\n*** Delete File: deleted.ts\n*** Add File: added.ts\n+new\n*** Update File: before.ts\n*** Move to: after.ts\n@@\n-old\n+new\n*** End Patch",
			},
		}
		expect(extractMutationPaths(block)).toEqual(["added.ts", "after.ts", "before.ts", "deleted.ts"])
		expect(() => extractMutationPaths({ ...block, nativeArgs: { patch: "bad" } })).toThrow()
		expect(() => extractMutationPaths({ ...block, name: "write_to_file", nativeArgs: undefined })).toThrow(
			"missing",
		)
		expect(extractMutationPaths({ ...block, name: "read_file", nativeArgs: undefined })).toBeUndefined()
	})

	it.each([
		"vitest run",
		"tox -e py",
		"hatch test",
		"pnpm run ci:custom",
		"pytest --collect-only",
		"echo diagnostic",
		"pnpm exec vitest run && echo passed",
	] as const)("captures process evidence for arbitrary approved commands: %s", async (command) => {
		const result = await resolve(command)

		expect(result).toMatchObject({
			scopePath: root,
			assurance: "process",
			repositoryFiles: {},
		})
		expect(result?.matchedFiles).toBeUndefined()
		expect(result?.commandDigest).toBe(fingerprintContent(JSON.stringify({ command, cwd: root })))
		expect(result?.repositoryDigest).toBe(fingerprintContent("{}"))
	})

	it("binds evidence to the canonical workspace and explicit changed paths", async () => {
		await write("src/source.py", "answer = 42")
		await write("sibling/related.py", "answer = 43")

		const result = await resolve("hatch test && custom-check", path.join(root, "src"), [
			"src/source.py",
			"sibling/related.py",
		])

		expect(result).toMatchObject({
			scopePath: root,
			assurance: "process",
			matchedFiles: ["sibling/related.py", "src/source.py"],
		})
		expect(result?.repositoryFiles).toEqual({
			"sibling/related.py": fingerprintContent("answer = 43"),
			"src/source.py": fingerprintContent("answer = 42"),
		})
	})

	it("refreshes command and associated-content identities independently", async () => {
		await write("src/source.py", "before")
		const first = await resolve("tox -e py", root, ["src/source.py"])
		await fs.mkdir(path.join(root, "tools"), { recursive: true })
		const differentCwd = await resolve("tox -e py", path.join(root, "tools"), ["src/source.py"])

		await write("src/source.py", "after")
		const second = await resolve("tox -e py", root, ["src/source.py"])
		const differentCommand = await resolve("hatch test", root, ["src/source.py"])

		expect(second?.commandDigest).toBe(first?.commandDigest)
		expect(differentCwd?.commandDigest).not.toBe(first?.commandDigest)
		expect(second?.repositoryDigest).not.toBe(first?.repositoryDigest)
		expect(differentCommand?.commandDigest).not.toBe(first?.commandDigest)
		expect(differentCommand?.repositoryDigest).toBe(second?.repositoryDigest)
	})

	it("rejects invalid commands and paths without issuing process assurance", async () => {
		expect(await resolve("")).toBeUndefined()
		expect(await resolve("x\0y")).toBeUndefined()
		expect(await resolve("x".repeat(4_097))).toBeUndefined()
		await expect(resolve("tox -e py", path.join(outside, "missing"))).rejects.toThrow("outside")
		await expect(resolve("tox -e py", root, [path.join(outside, "secret.py")])).rejects.toThrow("outside")
	})

	it("accepts a contained cwd beside the associated changed paths", async () => {
		await fs.mkdir(path.join(root, "src"), { recursive: true })
		await fs.mkdir(path.join(root, "tools"), { recursive: true })
		await write("src/source.ts", "export const source = true")
		const result = await resolve("custom-ci --check", path.join(root, "tools"), ["src/source.ts"])

		expect(result).toMatchObject({
			scopePath: root,
			matchedFiles: ["src/source.ts"],
			assurance: "process",
		})
	})

	it("compares real Git-visible edits, creations, deletions, and files becoming clean", async () => {
		await git(["init", "--quiet"])
		await write("tracked.ts", "original\n")
		await git(["add", "tracked.ts"])
		await git(["commit", "--quiet", "-m", "fixture"])
		const clean = await captureGitMutationState(root)
		expect(clean.files).toEqual({})
		await write("tracked.ts", "changed\n")
		await write("new.ts", "new\n")
		const changed = await captureGitMutationState(root)
		expect((await compareGitMutationState(root, clean, changed)).changedPaths).toEqual(["new.ts", "tracked.ts"])
		await git(["restore", "tracked.ts"])
		await fs.unlink(path.join(root, "new.ts"))
		const restored = await captureGitMutationState(root)
		expect(await compareGitMutationState(root, changed, restored)).toEqual({
			changedPaths: ["new.ts", "tracked.ts"],
			files: { "new.ts": "missing", "tracked.ts": fingerprintContent("original\n") },
		})
		await fs.unlink(path.join(root, "tracked.ts"))
		expect((await captureGitMutationState(root)).files).toEqual({ "tracked.ts": "missing" })
	})

	it("does not call staging or the initial commit a content change", async () => {
		await expect(captureGitMutationState(root)).rejects.toThrow()
		await git(["init", "--quiet"])
		await write("file.ts", "created\n")
		const before = await captureGitMutationState(root)
		expect(before.head).toBeNull()
		await git(["add", "file.ts"])
		const staged = await captureGitMutationState(root)
		expect(await compareGitMutationState(root, before, staged)).toEqual({ changedPaths: [], files: {} })
		await git(["commit", "--quiet", "-m", "fixture"])
		expect(await compareGitMutationState(root, staged, await captureGitMutationState(root))).toEqual({
			changedPaths: [],
			files: {},
		})
	})

	it("preserves current verification when committing already-observed edits and deletions", async () => {
		await git(["init", "--quiet"])
		await write("edited.ts", "original\n")
		await write("deleted.ts", "original\n")
		await git(["add", "."])
		await git(["commit", "--quiet", "-m", "baseline"])
		await write("edited.ts", "updated\n")
		await fs.unlink(path.join(root, "deleted.ts"))
		const before = await captureGitMutationState(root)
		await git(["add", "-A"])
		await git(["commit", "--quiet", "-m", "observed changes"])

		expect(await compareGitMutationState(root, before, await captureGitMutationState(root))).toEqual({
			changedPaths: [],
			files: {},
		})
	})

	it("observes edits, additions, and deletions made and committed within one command", async () => {
		await git(["init", "--quiet"])
		await write("edited.ts", "original\n")
		await write("deleted.ts", "original\n")
		await write("unchanged.ts", "original\n")
		await git(["add", "."])
		await git(["commit", "--quiet", "-m", "baseline"])
		const before = await captureGitMutationState(root)
		await write("edited.ts", "updated\n")
		await write("added.ts", "new\n")
		await fs.unlink(path.join(root, "deleted.ts"))
		await git(["add", "-A"])
		await git(["commit", "--quiet", "-m", "new changes"])
		const after = await captureGitMutationState(root)
		expect(after.files).toEqual({})

		expect(await compareGitMutationState(root, before, after)).toEqual({
			changedPaths: ["added.ts", "deleted.ts", "edited.ts"],
			files: {
				"added.ts": fingerprintContent("new\n"),
				"deleted.ts": "missing",
				"edited.ts": fingerprintContent("updated\n"),
			},
		})
	})

	it("rejects stale HEAD snapshots and committed changes beyond the observation bound", async () => {
		await git(["init", "--quiet"])
		await write("file.ts", "original\n")
		await git(["add", "."])
		await git(["commit", "--quiet", "-m", "baseline"])
		const before = await captureGitMutationState(root)
		await write("file.ts", "updated\n")
		await git(["commit", "--quiet", "-am", "update"])
		const after = await captureGitMutationState(root)
		await git(["commit", "--quiet", "--allow-empty", "-m", "later commit"])
		await expect(compareGitMutationState(root, before, after)).rejects.toThrow("HEAD changed while comparing")

		for (let index = 0; index < 257; index++) await write(`added-${index}.ts`, "new\n")
		await git(["add", "."])
		await git(["commit", "--quiet", "-m", "large change"])
		await expect(compareGitMutationState(root, before, await captureGitMutationState(root))).rejects.toThrow(
			"path count exceeds the bound",
		)
	})

	it("observes tracked mutations hidden by assume-unchanged or skip-worktree flags", async () => {
		await git(["init", "--quiet"])
		await write("assumed.ts", "original\n")
		await write("skipped.ts", "original\n")
		await git(["add", "."])
		await git(["commit", "--quiet", "-m", "fixture"])
		const before = await captureGitMutationState(root)
		await git(["update-index", "--assume-unchanged", "assumed.ts"])
		await git(["update-index", "--skip-worktree", "skipped.ts"])
		await write("assumed.ts", "changed assumed\n")
		await write("skipped.ts", "changed skipped\n")
		expect((await git(["status", "--porcelain"])).stdout).toBe("")
		const after = await captureGitMutationState(root)
		expect(await compareGitMutationState(root, before, after)).toEqual({
			changedPaths: ["assumed.ts", "skipped.ts"],
			files: {
				"assumed.ts": fingerprintContent("changed assumed\n"),
				"skipped.ts": fingerprintContent("changed skipped\n"),
			},
		})
		expect(await compareGitMutationState(root, after, await captureGitMutationState(root))).toEqual({
			changedPaths: [],
			files: {},
		})
	})

	it("observes a completed shell mutation in a bounded non-Git workspace without counting read-only commands", async () => {
		await write("source.ts", "original")
		await write("node_modules/ignored.js", "dependency")
		await write(".build/relevant.ts", "generated source")
		const before = await captureWorkspaceMutationState(root)
		expect(before.kind).toBe("files")
		expect(before.files["node_modules/ignored.js"]).toBeUndefined()
		expect(before.files[".build/relevant.ts"]).toBe(fingerprintContent("generated source"))
		await execFileAsync(process.execPath, ["-e", "require('fs').readFileSync('source.ts')"], {
			cwd: root,
			windowsHide: true,
		})
		expect(await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root))).toEqual({
			changedPaths: [],
			files: {},
		})
		await execFileAsync(
			process.execPath,
			["-e", "require('fs').unlinkSync('source.ts');require('fs').writeFileSync('new.ts', 'created')"],
			{ cwd: root, windowsHide: true },
		)
		expect(await compareWorkspaceMutationState(root, before, await captureWorkspaceMutationState(root))).toEqual({
			changedPaths: ["new.ts", "source.ts"],
			files: { "new.ts": fingerprintContent("created"), "source.ts": "missing" },
		})
	})

	it("refuses unbounded non-Git trees and symlinks while accepting content-preserving initialization", async () => {
		await fs.symlink(outside, path.join(root, "escape"), "junction")
		await expect(captureWorkspaceMutationState(root)).rejects.toThrow("symlinks")
		await fs.unlink(path.join(root, "escape"))
		const before = await captureWorkspaceMutationState(root)
		await git(["init", "--quiet"])
		const after = await captureWorkspaceMutationState(root)
		expect(after.kind).toBe("git")
		expect(await compareWorkspaceMutationState(root, before, after)).toEqual({ changedPaths: [], files: {} })
		for (let index = 0; index < 257; index++) await fs.writeFile(path.join(outside, `${index}.ts`), "")
		await expect(captureWorkspaceMutationState(outside)).rejects.toThrow("file bound")
	})
})
