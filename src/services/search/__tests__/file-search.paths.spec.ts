import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { clearRipgrepPathCache } from "../../ripgrep"
import { searchWorkspaceFiles } from "../file-search"

describe("searchWorkspaceFiles path contract", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-file-search-"))
		await fs.mkdir(path.join(tempDir, "src"))
		await fs.writeFile(path.join(tempDir, "src", "index.ts"), "export const value = 1\n")
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
		clearRipgrepPathCache()
	})

	it("returns POSIX relative paths for an empty picker query on Windows", async () => {
		const results = await searchWorkspaceFiles("", tempDir, 20)

		if (process.platform === "win32") {
			expect(results.map((result) => result.path)).toContain("src/index.ts")
			expect(results.every((result) => !result.path.includes("\\"))).toBe(true)
		} else {
			expect(results.map((result) => result.path)).toContain("src/index.ts")
		}
	})
})
