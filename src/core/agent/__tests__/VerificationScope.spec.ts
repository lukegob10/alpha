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
	captureVerificationDependencies,
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
			).resolves.toMatchObject({ scopePath: path.join(root, "src"), kind: "test" })
		}
		await expect(captureVerificationContent(alias, [path.join(alias, "src/source.ts")])).resolves.toEqual({
			"src/source.ts": fingerprintContent("export const value = 1"),
		})
		await expect(
			captureVerificationDependencies(alias, [path.join(alias, "src/source.ts")]),
		).resolves.toMatchObject({ "src/package.json": "missing", "package.json": "missing" })
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
		["generate_image", "path"],
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
		["vitest run", "test"],
		["pnpm exec vitest run --maxWorkers=2", "test"],
		["vitest run --maxWorkers 2", "test"],
		["jest --ci --runInBand", "test"],
		["tsc --noEmit", "types"],
		["eslint . --ext=ts --max-warnings=0", "lint"],
		["prettier --check .", "format"],
		["pytest -q", "test"],
		["python -m pytest .", "test"],
		["go test ./...", "test"],
		["go vet ./...", "lint"],
		["cargo test --workspace", "test"],
		["cargo check --workspace", "types"],
	] as const)("admits the whole-scope shape %s", async (command, kind) => {
		const result = await resolve(command)
		expect(result).toMatchObject({ scopePath: root, kind })
		expect(result?.commandDigest).toMatch(/^[a-f0-9]{64}$/)
		expect(result?.repositoryFiles["package.json"]).toBe("missing")
	})

	it.each([
		"echo passed",
		"git --no-pager status",
		"vitest run unrelated.spec.ts",
		"vitest run --passWithNoTests",
		"vitest run --help",
		"vitest run --version",
		"vitest list",
		"vitest run --testNamePattern=unrelated",
		"vitest run --maxWorkers=0",
		"vitest run --maxWorkers=2 unrelated.spec.ts",
		"jest --listTests",
		"jest --passWithNoTests",
		"tsc --noEmit unrelated.ts",
		"tsc --noEmit --showConfig",
		"eslint unrelated.ts",
		"eslint . --fix",
		"pytest --collect-only",
		"pytest -k unrelated",
		"go test ./unrelated",
		"go test ./... -run NoTests",
		"cargo test --workspace --no-run",
		"cargo test --workspace unrelated",
		"pnpm exec vitest run && echo passed",
		"pnpm dlx vitest run",
		"pnpm --filter unrelated test",
		"pnpm exec vitest run\nvitest run",
		"pnpm exec vitest 'run",
	])("does not turn %s into verifier evidence", async (command) => {
		expect(await resolve(command)).toBeUndefined()
	})

	it("resolves actual package scripts, nearest package cwd, and repository requirement versions", async () => {
		const manifest = JSON.stringify({ scripts: { test: "vitest run", "check-types": "tsc --noEmit" } })
		await write("package.json", JSON.stringify({ scripts: { test: "echo no" } }))
		await write("package space/package.json", manifest)
		await fs.mkdir(path.join(root, "package space", "nested"))
		const first = await resolve('pnpm --dir "package space/nested" test --maxWorkers=2')
		expect(first?.scopePath).toBe(path.join(root, "package space"))
		expect(first?.repositoryFiles["package space/package.json"]).toBe(fingerprintContent(manifest))
		expect(first?.repositoryFiles["package.json"]).toBeDefined()
		expect(await resolve('pnpm --dir "package space" test unrelated.spec.ts')).toBeUndefined()
		expect(await resolve("pnpm test")).toBeUndefined()
		expect(await resolve('pnpm --dir "package space" run check-types')).toMatchObject({ kind: "types" })
		await write("package space/package.json", JSON.stringify({ scripts: { test: "vitest run" }, name: "changed" }))
		const next = await resolve('pnpm --dir "package space/nested" test --maxWorkers=2')
		expect(next?.repositoryDigest).not.toBe(first?.repositoryDigest)
		await write("package space/vitest.config.ts", "export default {}")
		expect((await resolve('pnpm --dir "package space" test'))?.repositoryDigest).not.toBe(next?.repositoryDigest)
	})

	it("rejects malformed, oversized, or escaping package manifests without claiming evidence", async () => {
		await write("package.json", "invalid")
		await expect(resolve("pnpm test")).rejects.toThrow()
		await write("package.json", " ".repeat(256 * 1_024 + 1))
		await expect(resolve("pnpm test")).rejects.toThrow("bounded regular file")
		await expect(resolve("pnpm --dir ../outside test")).rejects.toThrow("outside")
	})

	it("admits exact changed test/lint targets without guessing a source-to-test relationship", async () => {
		await write("src/example.spec.ts", "test('example', () => {})")
		await write("src/other.spec.ts", "test('other', () => {})")
		await write("src/example.ts", "export const example = 1")
		await write("eslint.config.mjs", 'export default [{"files":["**/*.ts"],"rules":{"semi":"error"}}]')
		expect(
			await resolve("vitest run src/example.spec.ts --maxWorkers=2", root, ["src/example.spec.ts"]),
		).toMatchObject({ kind: "test" })
		expect(
			await resolve("vitest run src/example.spec.ts", root, ["src/example.spec.ts", "src/other.spec.ts"]),
		).toBeUndefined()
		expect(
			await resolve("vitest run src/example.spec.ts src/other.spec.ts", root, [
				"src/example.spec.ts",
				"src/other.spec.ts",
			]),
		).toMatchObject({ kind: "test" })
		expect(await resolve("vitest run src/example.spec.ts", root, ["src/example.ts"])).toBeUndefined()
		expect(await resolve("vitest run src/example.ts", root, ["src/example.ts"])).toBeUndefined()
		expect(await resolve("eslint src/example.ts", root, ["src/example.ts"])).toMatchObject({ kind: "lint" })
		expect(await resolve("jest --runTestsByPath src/example.spec.ts", root, ["src/example.spec.ts"])).toMatchObject(
			{ kind: "test" },
		)
		await fs.unlink(path.join(root, "src/example.spec.ts"))
		expect(await resolve("vitest run src/example.spec.ts", root, ["src/example.spec.ts"])).toBeUndefined()
	})

	it("binds tsc to its actual configured files and supports the extension's bounded include shape", async () => {
		await write("src/broken.ts", "const broken: string = 1")
		await write("unrelated.ts", "export const okay = 1")
		await write("tsconfig.json", JSON.stringify({ files: ["unrelated.ts"] }))
		expect(await resolve("tsc --noEmit", root, ["src/broken.ts"])).toBeUndefined()
		expect(await resolve("tsc --noEmit", root, ["unrelated.ts"])).toMatchObject({ kind: "types" })
		await write(
			"src/tsconfig.json",
			JSON.stringify({ compilerOptions: { skipLibCheck: true }, include: ["."], exclude: ["node_modules"] }),
		)
		const accepted = await resolve("tsc --noEmit", path.join(root, "src"), ["src/broken.ts"])
		expect(accepted).toMatchObject({ kind: "types", scopePath: path.join(root, "src") })
		expect(accepted?.repositoryFiles["src/tsconfig.json"]).toMatch(/^[a-f0-9]{64}$/)
		expect(await resolve("tsc --noEmit", path.join(root, "src"), ["src/contracts.d.ts"])).toBeUndefined()
		expect(await resolve("tsc --noEmit", path.join(root, "src"), ["src/README.md"])).toBeUndefined()
		expect(await resolve("tsc --noEmit", path.join(root, "src"), ["src/tsconfig.json"])).toMatchObject({
			kind: "types",
		})
	})

	it.each([
		{ include: ["unrelated/**/*.ts"] },
		{ include: ["src/**/*.ts"], exclude: ["src/broken.ts"] },
		{ include: ["src/**/*.ts"], exclude: ["src"] },
		{ compilerOptions: { noCheck: true }, include: ["src"] },
		{ extends: "./base.json", include: ["src"] },
		{ references: [{ path: "./src" }], files: [] },
		{ include: ["src/{broken,other}.ts"] },
	])("does not credit unknown or excluding TS configuration %j", async (config) => {
		await write("tsconfig.json", JSON.stringify(config))
		expect(await resolve("tsc --noEmit", root, ["src/broken.ts"])).toBeUndefined()
	})

	it("supports simple TypeScript globs without treating excluded or hidden files as inputs", async () => {
		await write("tsconfig.json", JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/ignored/**/*"] }))
		expect(await resolve("tsc --noEmit", root, ["src/nested/source.ts"])).toMatchObject({ kind: "types" })
		expect(await resolve("tsc --noEmit", root, ["src/ignored/source.ts"])).toBeUndefined()
		expect(await resolve("tsc --noEmit", root, ["src/.hidden/source.ts"])).toBeUndefined()
		expect(await resolve("tsc --noEmit", root, ["src/not-typescript.mtsx"])).toBeUndefined()
	})

	it("rejects nested module/package and known test-runner exclusions", async () => {
		await write("go.mod", "module example.invalid/root\n")
		await write("nested/go.mod", "module example.invalid/nested\n")
		expect(await resolve("go test ./...", root, ["nested/broken.go"])).toBeUndefined()
		expect(await resolve("go test ./...", path.join(root, "nested"), ["nested/broken.go"])).toMatchObject({
			kind: "test",
		})
		await write("nested/package.json", JSON.stringify({ scripts: { test: "vitest run" } }))
		expect(await resolve("vitest run", root, ["nested/source.ts"])).toBeUndefined()
		expect(await resolve("pnpm --dir nested test", root, ["nested/source.ts"])).toMatchObject({ kind: "test" })
		await write("vitest.config.ts", "export default { test: { exclude: ['src/excluded.spec.ts'] } }")
		expect(await resolve("vitest run", root, ["src/excluded.spec.ts"])).toBeUndefined()
	})

	it.each([
		'import settings from "./other-config"; export default settings',
		"export default { ...settings }",
		'export default { ["te" + "st"]: {} }',
		"export default () => ({ test: {} })",
		'import { defineConfig } from "vitest/config"; export default defineConfig({})',
	])("does not infer test coverage from dynamic configuration %s", async (config) => {
		await write("vitest.config.ts", config)
		await write("src/example.spec.ts", "test('example', () => {})")
		expect(await resolve("vitest run", root, ["src/source.ts"])).toBeUndefined()
		expect(await resolve("vitest run", path.join(root, "src"), ["src/source.ts"])).toBeUndefined()
		expect(await resolve("vitest run src/example.spec.ts", root, ["src/example.spec.ts"])).toBeUndefined()
	})

	it("accepts only harmless literal test settings and checks Jest's package configuration", async () => {
		await write("vitest.config.mjs", 'export default {"test":{"globals":true,"watch":false,"testTimeout":20000}};')
		expect(await resolve("vitest run", root, ["src/source.ts"])).toMatchObject({ kind: "test" })
		await write("jest.config.cjs", 'module.exports = {"verbose":true};')
		expect(await resolve("jest --ci", root, ["src/source.ts"])).toMatchObject({ kind: "test" })
		await write("package.json", JSON.stringify({ jest: { testMatch: ["**/unrelated.spec.ts"] } }))
		expect(await resolve("jest --ci", root, ["src/source.ts"])).toBeUndefined()
	})

	it("requires ESLint file types, matching literal rules, and supported ignores", async () => {
		await write("src/example.ts", "export const example = 1")
		await write("src/example.js", "export const example = 1")
		await write("README.md", "# Notes")
		await write("eslint.config.mjs", 'export default [{"rules":{"semi":"error"}}]')
		expect(await resolve("eslint .", root, ["src/example.js"])).toMatchObject({ kind: "lint" })
		expect(await resolve("eslint .", root, ["README.md"])).toBeUndefined()
		expect(await resolve("eslint README.md", root, ["README.md"])).toBeUndefined()
		expect(await resolve("eslint .", root, ["src/example.ts"])).toBeUndefined()
		expect(await resolve("eslint . --ext=ts", root, ["src/example.ts"])).toMatchObject({ kind: "lint" })
		await write(
			"eslint.config.mjs",
			'export default [{"files":["src/**/*.ts"],"rules":{"semi":"error"}},{"ignores":["src/ignored/**"]}]',
		)
		expect(await resolve("eslint .", root, ["src/example.ts"])).toMatchObject({ kind: "lint" })
		expect(await resolve("eslint .", root, ["other/example.ts"])).toBeUndefined()
		expect(await resolve("eslint .", root, ["src/ignored/example.ts"])).toBeUndefined()
		await write("eslint.config.mjs", 'export default [{"rules":{"semi":"off"}}]')
		expect(await resolve("eslint .", root, ["src/example.js"])).toBeUndefined()
		await write("eslint.config.mjs", 'import rules from "./shared.js"; export default rules')
		expect(await resolve("eslint .", root, ["src/example.js"])).toBeUndefined()
	})

	it.each([
		["vitest run", "src/foreign.py"],
		["jest --ci", "src/foreign.go"],
		["pytest", "src/foreign.ts"],
		["go test ./...", "src/foreign.rs"],
		["go vet ./...", "src/foreign.ts"],
		["cargo test --workspace", "src/foreign.go"],
		["cargo check --workspace", "src/foreign.py"],
	])("does not let %s cover prose, binaries, or another language", async (command, foreign) => {
		expect(await resolve(command, root, ["README.md"])).toBeUndefined()
		expect(await resolve(command, root, ["image.png"])).toBeUndefined()
		expect(await resolve(command, root, [foreign])).toBeUndefined()
	})

	it("keeps explicit supported source/config types and Markdown formatting eligible", async () => {
		expect(await resolve("vitest run", root, ["source.ts", "package.json"])).toMatchObject({ kind: "test" })
		expect(await resolve("pytest", root, ["source.py", "pytest.ini"])).toMatchObject({ kind: "test" })
		expect(await resolve("go test ./...", root, ["source.go", "go.mod"])).toMatchObject({ kind: "test" })
		expect(await resolve("cargo check --workspace", root, ["source.rs", "Cargo.toml"])).toMatchObject({
			kind: "types",
		})
		expect(await resolve("prettier --check .", root, ["README.md"])).toMatchObject({ kind: "format" })
		await write("README.md", "# Notes")
		expect(await resolve("prettier --check README.md", root, ["README.md"])).toMatchObject({ kind: "format" })
		expect(await resolve("prettier --check .", root, ["image.png"])).toBeUndefined()
		expect(await resolve("prettier --check .", root, ["program.exe"])).toBeUndefined()
	})

	it("captures requirement dependencies across changed packages without promoting source paths", async () => {
		await write("one/package.json", JSON.stringify({ scripts: { test: "vitest run" } }))
		await write("two/tsconfig.json", JSON.stringify({ include: ["."] }))
		const dependencies = await captureVerificationDependencies(root, ["one/source.ts", "two/source.ts"])
		expect(dependencies["one/package.json"]).toMatch(/^[a-f0-9]{64}$/)
		expect(dependencies["two/tsconfig.json"]).toMatch(/^[a-f0-9]{64}$/)
		expect(dependencies["package.json"]).toBe("missing")
		expect(dependencies["one/source.ts"]).toBeUndefined()
		expect(dependencies["two/source.ts"]).toBeUndefined()
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
