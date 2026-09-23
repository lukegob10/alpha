import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"

import { listFiles } from "../list-files"
import { getBinPath } from "../../ripgrep"

vi.mock("../../ripgrep", () => ({
	getBinPath: vi.fn(),
	executeWithRipgrepFallback: (binaryPath: string, execute: (binaryPath: string) => Promise<unknown>) =>
		execute(binaryPath),
	createRipgrepProcessError: (error: Error) => new Error(`ripgrep process error: ${error.message}`),
}))

// Exercise real process/pipe and filesystem behavior; only binary discovery is replaced.
const binary = spawnSync("rg", ["--version"], { encoding: "utf8", windowsHide: true })
const unavailable = (binary.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
if (!unavailable && (binary.error || binary.status !== 0)) {
	throw binary.error ?? new Error(`Unable to execute ripgrep: ${binary.stderr}`)
}

describe("real ripgrep listing parity", () => {
	it.skipIf(unavailable).each(["workspace", "tmp/workspace", "temp/workspace"])(
		"preserves recursive file discovery and nested ignore rules under %s without listing directories",
		async (relativeWorkspace) => {
			vi.mocked(getBinPath).mockResolvedValue("rg")
			const tempBase = await fs.realpath(os.tmpdir())
			const fixtureRoot = await fs.mkdtemp(path.join(tempBase, "alpha-rg-discovery-"))
			const workspaceRoot = path.join(fixtureRoot, relativeWorkspace)
			try {
				await fs.mkdir(workspaceRoot, { recursive: true })
				for (const directory of [".git", "src", "generated", ".hidden", "node_modules"]) {
					await fs.mkdir(path.join(workspaceRoot, directory))
				}
				await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "generated/\n*.rootignored\n")
				await fs.writeFile(path.join(workspaceRoot, "src", ".gitignore"), "*.ts\n!keep.ts\n")
				for (const file of [
					"root.ts",
					"src/keep.ts",
					"src/drop.ts",
					"src/readme.md",
					"generated/ignored.ts",
					".hidden/hidden.ts",
					"node_modules/dep.ts",
					"ordinary.rootignored",
				]) {
					await fs.writeFile(path.join(workspaceRoot, file), "discovery fixture")
				}

				const legacy = await listFiles(workspaceRoot, true, 1000)
				const filesOnly = await listFiles(workspaceRoot, true, 1000, undefined, { includeDirectories: false })
				expect(filesOnly).toEqual([legacy[0].filter((entry) => !entry.endsWith("/")), false])
				const names = filesOnly[0].map((entry) => path.relative(workspaceRoot, entry).replaceAll(path.sep, "/"))
				expect(names).toEqual(expect.arrayContaining(["root.ts", "src/keep.ts", "src/readme.md"]))
				for (const ignored of [
					"src/drop.ts",
					"generated/ignored.ts",
					".hidden/hidden.ts",
					"node_modules/dep.ts",
					"ordinary.rootignored",
				]) {
					expect(names).not.toContain(ignored)
				}
			} finally {
				expect(path.dirname(path.resolve(fixtureRoot))).toBe(tempBase)
				expect(path.basename(fixtureRoot)).toMatch(/^alpha-rg-discovery-/)
				await fs.rm(fixtureRoot, { recursive: true, force: true })
			}
		},
	)

	it.skipIf(unavailable)(
		"preserves ordinary, hidden, and ignored entries with root and nested ignore files",
		async () => {
			vi.mocked(getBinPath).mockResolvedValue("rg")
			const tempBase = await fs.realpath(os.tmpdir())
			const workspaceRoot = await fs.mkdtemp(path.join(tempBase, "alpha-rg-parity-"))
			try {
				const target = path.join(workspaceRoot, "listed")
				await fs.mkdir(path.join(workspaceRoot, ".git"))
				await fs.mkdir(target)
				await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "root-filtered/\n*.rootignored\n")
				await fs.writeFile(path.join(target, ".gitignore"), "nested-filtered/\n*.nestedignored\n")
				for (const directory of ["ordinary-dir", ".hidden-dir", "root-filtered", "nested-filtered"]) {
					await fs.mkdir(path.join(target, directory))
					await fs.writeFile(path.join(target, directory, "deep.txt"), "not a top-level entry")
				}
				const fileNames = ["ordinary.txt", ".hidden.txt", "root-only.rootignored", "nested-only.nestedignored"]
				for (const name of fileNames) await fs.writeFile(path.join(target, name), "listing fixture")

				const legacy = await listFiles(target, false, 200)
				const strict = await listFiles(target, false, 200, undefined, {
					followSymlinks: false,
					rejectOnError: true,
					workspaceRoot,
				})

				expect(strict).toEqual(legacy)
				expect(strict[1]).toBe(false)
				const names = strict[0].map(
					(entry) =>
						path.relative(target, entry).replaceAll(path.sep, "/") + (entry.endsWith("/") ? "/" : ""),
				)
				// Existing -g * preserves top-level file names even when Git ignores them.
				expect(names).toEqual(
					expect.arrayContaining([...fileNames, ".gitignore", "ordinary-dir/", ".hidden-dir/"]),
				)
				expect(names).not.toContain("root-filtered/")
				expect(names).not.toContain("nested-filtered/")
				expect(names.some((entry) => entry.endsWith("deep.txt"))).toBe(false)
				console.log(
					"NOR-26 real listing parity",
					binary.stdout.split(/\r?\n/)[0],
					`${strict[0].length} equal entries`,
				)
			} finally {
				expect(path.dirname(path.resolve(workspaceRoot))).toBe(tempBase)
				expect(path.basename(workspaceRoot)).toMatch(/^alpha-rg-parity-/)
				await fs.rm(workspaceRoot, { recursive: true, force: true })
			}
		},
	)
})
