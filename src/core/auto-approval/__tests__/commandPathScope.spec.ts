import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { assessCommandPaths } from "../commandPathScope"

describe("command path preflight", () => {
	let fixture: string
	let root: string
	let outside: string
	beforeEach(async () => {
		fixture = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-paths-"))
		root = path.join(fixture, "project")
		outside = path.join(fixture, "other project")
		await fs.mkdir(root)
		await fs.mkdir(outside)
	})
	afterEach(async () => {
		vi.unstubAllEnvs()
		await fs.rm(fixture, { recursive: true, force: true })
	})
	const assess = (command: string) => assessCommandPaths(command, root, [root])

	it.each([
		"pnpm test",
		"pnpm install",
		"npm run build",
		"node script.js",
		"python task.py",
		"git status",
		"git add . && git commit -m 'update'",
		"curl https://example.com",
		"echo hello",
		"echo '>'",
		"node -e \"console.log('hello')\"",
		"echo '${value@P}'",
		"echo hi 2>&1",
		"echo hi > NUL",
		"echo hi > /dev/null",
		"Set-Content -LiteralPath local.txt -Value '../other project/data'",
		"mkdir build",
		"rm -rf build",
		"cp '../other project/input.txt' local.txt",
		"git -C . status",
		"echo hi>local.txt",
		"echo hi>>local.txt",
		"cd . && pnpm test",
		"Get-Content '../other project/data'",
		"node -e \"require('fs').writeFileSync('../opaque.txt', 'x')\"",
	])("retains global command approval for %s", (command) => {
		expect(assess(command)).toMatchObject({ outsidePaths: [], unresolvedWrite: false })
	})
	it.each([
		"echo changed > '../other project/file.txt'",
		"echo changed>>'../other project/file.txt'",
		"Remove-Item -LiteralPath '../other project/file.txt' -Force",
		"rm -rf '../other project/file.txt'",
		"Set-Content -Path '../other project/file.txt' -Value changed",
		"Add-Content '../other project/file.txt' changed",
		"echo hi | Out-File '../other project/file.txt'",
		"cp local.txt '../other project/file.txt'",
		"Copy-Item -Path local.txt -Destination '../other project/file.txt'",
		"mv '../other project/file.txt' local.txt",
		"Move-Item local.txt '../other project/file.txt'",
		"touch '../other project/file.txt'",
		"mkdir '../other project/new'",
		"tee '../other project/file.txt'",
		"curl https://example.com -o '../other project/file.txt'",
		"build --output='../other project/file.txt'",
		"git diff --output='../other project/file.txt'",
		"cd '../other project' && pnpm test",
		"Set-Location '../other project'; Remove-Item file.txt",
		"pnpm --dir '../other project' build",
		"git -C '../other project' reset --hard",
		"git clone https://example.com/repo '../other project/repo'",
		"git worktree add -b feature '../other project/tree'",
		"git --git-dir='../other project/git' commit -m update",
		"git -C '../other project' push origin status",
		"echo $(rm '../other project/file.txt')",
		"sh -c \"rm '../other project/file.txt'\"",
		"pwsh -Command \"Remove-Item '../other project/file.txt'\"",
	])("flags a detected outside destination in %s", (command) => {
		const result = assess(command)
		expect(result.outsidePaths.length).toBeGreaterThan(0)
		expect(result.outsidePaths.every((target) => target === outside || target.startsWith(outside + path.sep))).toBe(
			true,
		)
	})
	it("uses the command cwd without expanding its write grant", () => {
		expect(assessCommandPaths("pnpm build", outside, [root]).outsidePaths).toEqual([outside])
		expect(assessCommandPaths("git status", outside, [root]).outsidePaths).toEqual([])
	})
	it("keeps an explicitly granted second root and preserves command-local cwd changes", () => {
		expect(assessCommandPaths("pnpm build", outside, [root, outside]).outsidePaths).toEqual([])
		expect(assess("git -C '../other project' status; touch local.txt").outsidePaths).toEqual([])
	})
	it("resolves junctions and new paths under their nearest existing ancestor", async () => {
		await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
		expect(assess("echo changed > linked/new/file.txt").outsidePaths).toEqual([
			path.join(root, "linked/new/file.txt"),
		])
	})
	it("resolves environment paths and reviews unresolved write destinations", () => {
		vi.stubEnv("ALPHA_PATH_TEST", outside)
		vi.stubEnv("ALPHA_UNKNOWN_TEST", undefined)
		for (const variable of ["$env:ALPHA_PATH_TEST", "${ALPHA_PATH_TEST}", "%ALPHA_PATH_TEST%"])
			expect(assess(`rm '${variable}/file.txt'`).outsidePaths).toEqual([path.join(outside, "file.txt")])
		expect(assess("Remove-Item $ALPHA_UNKNOWN_TEST").unresolvedWrite).toBe(true)
		expect(assess("echo hi > $(get-output-path)").unresolvedWrite).toBe(true)
	})
	it("checks PowerShell encoded shell commands without running them", () => {
		const encoded = Buffer.from("Remove-Item '../other project/file.txt'", "utf16le").toString("base64")
		expect(assess(`pwsh -EncodedCommand ${encoded}`).outsidePaths).toEqual([path.join(outside, "file.txt")])
	})
	it("distinguishes an adjacent root name and handles absolute quoted paths", () => {
		const sibling = `${root}-other`
		expect(assess(`Remove-Item -LiteralPath '${sibling}/file.txt'`).outsidePaths).toEqual([
			path.join(sibling, "file.txt"),
		])
	})
})
