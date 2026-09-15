import fs from "fs/promises"
import os from "os"
import path from "path"

import { getTrustedCommandExploration } from "../CommandExploration"

describe("trusted command exploration", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-exploration-"))
		await fs.mkdir(path.join(workspace, "src", "nested"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	async function observe(command: string, overrides: Record<string, unknown> = {}) {
		return getTrustedCommandExploration({
			command,
			workspaceRoot: workspace,
			cwd: workspace,
			executionStatus: "succeeded",
			exitCode: 0,
			...overrides,
		})
	}

	it("canonicalizes equivalent ripgrep file inspections without using output", async () => {
		const short = await observe('rg --files -g "*.ts" ./src')
		const long = await observe("RG.EXE --glob '*.ts' --files src")

		expect(short).toEqual(long)
		expect(short).toEqual({
			scope: path.normalize(await fs.realpath(workspace)),
			semanticFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		})
	})

	it("recognizes content searches and ignores cosmetic output options", async () => {
		const short = await observe('rg -nF -g "*.ts" "tool call" ./src')
		const long = await observe('rg --fixed-strings --glob="*.ts" --regexp="tool call" --color never src')

		expect(short).toBeDefined()
		expect(short).toEqual(long)
		expect(await observe('rg -F -g "*.ts" "another symbol" src')).not.toEqual(short)
		expect(await observe('rg -F -g "*.ts" "tool call" src/nested')).not.toEqual(short)
	})

	it("retains search semantics and canonicalizes explicit patterns", async () => {
		expect(await observe("rg -e alpha -e beta src")).toEqual(await observe("rg --regexp=beta -ealpha ./src"))
		const regular = await observe('rg "alpha|beta" src')
		expect(regular).toBeDefined()
		for (const option of ["-F", "-i", "-w", "-v", "-C 4", "--max-count=2"]) {
			const changed = await observe(`rg ${option} "alpha|beta" src`)
			expect(changed).toBeDefined()
			expect(changed).not.toEqual(regular)
		}
		expect(await observe('rg -- "-needle" src')).toEqual(await observe('rg -e "-needle" src'))
	})

	it("preserves ordered glob overrides instead of conflating different search scopes", async () => {
		const excluded = await observe('rg -g "*.ts" -g "!*.ts" alpha src')
		const included = await observe('rg -g "!*.ts" -g "*.ts" alpha src')
		expect(excluded).toBeDefined()
		expect(included).toBeDefined()
		expect(excluded).not.toEqual(included)
	})

	it("produces distinct stable identities for forty distinct supported inspections", async () => {
		const observations = await Promise.all(
			Array.from({ length: 40 }, (_, index) => observe(`rg --files --glob "file-${index}.ts"`)),
		)

		expect(observations.every(Boolean)).toBe(true)
		expect(new Set(observations.map((item) => item?.semanticFingerprint)).size).toBe(40)
	})

	it("canonicalizes supported git inspection spelling variants", async () => {
		const short = await observe("git status -s")
		const long = await observe("GIT.EXE --no-pager status --short")

		expect(short).toBeDefined()
		expect(short).toEqual(long)
	})

	it.each(["show", "diff", "ls-tree"])("retains distinct %s review targets", async (subcommand) => {
		const observations = await Promise.all(
			Array.from({ length: 40 }, (_, index) => observe(`git ${subcommand} HEAD -- src/file-${index}.ts`)),
		)
		expect(observations.every(Boolean)).toBe(true)
		expect(new Set(observations.map((item) => item?.semanticFingerprint)).size).toBe(40)
	})

	it("retains revisions in Plan-compatible show inspections", async () => {
		const first = await observe("git --no-pager show --no-ext-diff --no-textconv main:src/a.ts")
		const second = await observe("git --no-pager show --no-ext-diff --no-textconv feature:src/a.ts")
		expect(first).toBeDefined()
		expect(second).toBeDefined()
		expect(second).not.toEqual(first)
	})

	it("recognizes ordinary ancestor revisions without treating formatting as new work", async () => {
		const first = await observe("git show --format=first HEAD~2 -- ./src/a.ts")
		const second = await observe(
			"git --no-pager show --format=second --no-ext-diff --no-textconv HEAD~2 -- src/a.ts",
		)
		expect(first).toBeDefined()
		expect(second).toEqual(first)
		expect(await observe("git show --format=first HEAD~1 -- src/a.ts")).not.toEqual(first)
	})

	it("resolves Git -C against the captured cwd without splitting the workspace scope", async () => {
		const explicit = await observe("git -C src ls-files")
		const captured = await observe("git ls-files", { cwd: path.join(workspace, "src") })
		expect(explicit).toBeDefined()
		expect(explicit).toEqual(captured)
		expect(await observe("git ls-files")).not.toEqual(explicit)
		expect(await observe("git -C .. ls-files")).toBeUndefined()
	})

	it("uses the workspace root for equivalent parent-target inspections from a nested cwd", async () => {
		const rootInspection = await observe("rg --files src")
		const nestedInspection = await observe("rg --files ..", { cwd: path.join(workspace, "src", "nested") })

		expect(nestedInspection).toEqual(rootInspection)
		expect(nestedInspection?.scope).toBe(path.normalize(await fs.realpath(workspace)))
	})

	it("treats distinct path queries as exploration even when they can return no matches", async () => {
		const first = await observe("git --no-pager status --short nonexistent-1")
		const second = await observe("git --no-pager status --short nonexistent-2")

		expect(first).toBeDefined()
		expect(second).toBeDefined()
		expect(second).not.toEqual(first)
	})

	it.each([
		["running", 0],
		["failed", 0],
		["succeeded", 1],
	] as const)("withholds observations for %s commands with exit %s", async (executionStatus, exitCode) => {
		expect(await observe("rg --files", { executionStatus, exitCode })).toBeUndefined()
	})

	it.each([
		"echo 2026-09-04T22:14:53Z",
		"rg --pre processor pattern src",
		"rg --hostname-bin processor pattern src",
		"rg --search-zip pattern src",
		"rg --follow pattern src",
		"rg -f patterns.txt src",
		"rg alpha ../outside",
		"rg alpha src | head -10",
		"rg alpha src; rg beta src",
		"rg --unknown-option alpha src",
		"rg --files --pre processor",
		"rg --files --follow",
		"rg --files ../outside",
		"rg --files src; echo changed",
		"git reset --hard",
		"git -c alias.inspect=status inspect",
		"git show --output=result.txt HEAD",
		"git show --ext-diff HEAD",
		"git show HEAD; echo changed",
	])("withholds progress metadata from unsupported or unsafe command %s", async (command) => {
		expect(await observe(command)).toBeUndefined()
	})

	it("requires the canonical command cwd to remain inside the workspace", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-outside-"))
		try {
			expect(await observe("rg --files", { cwd: outside })).toBeUndefined()
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	})
})
