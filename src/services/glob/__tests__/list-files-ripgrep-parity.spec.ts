import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"

import { listFiles } from "../list-files"
import { getBinPath } from "../../ripgrep"

vi.mock("../../ripgrep", () => ({ getBinPath: vi.fn() }))

// Exercise real process/pipe and filesystem behavior; only binary discovery is replaced.
const binary = spawnSync("rg", ["--version"], { encoding: "utf8", windowsHide: true })
const unavailable = (binary.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
if (!unavailable && (binary.error || binary.status !== 0)) {
	throw binary.error ?? new Error(`Unable to execute ripgrep: ${binary.stderr}`)
}

describe("real ripgrep strict nonrecursive parity", () => {
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
