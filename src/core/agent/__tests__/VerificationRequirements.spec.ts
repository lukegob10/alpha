import fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolveVerificationRequirements } from "../VerificationRequirements"

describe("resolveVerificationRequirements", () => {
	let workspaceRoot: string
	let outsideRoot: string

	beforeEach(async () => {
		workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-requirements-")))
		outsideRoot = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-requirements-outside-")))
	})

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true })
		await fs.rm(outsideRoot, { recursive: true, force: true })
	})

	const write = async (relativePath: string, content: string | Buffer) => {
		const absolutePath = path.join(workspaceRoot, relativePath)
		await fs.mkdir(path.dirname(absolutePath), { recursive: true })
		await fs.writeFile(absolutePath, content)
	}

	it("maps only canonical nearest package scripts and observes changed manifests", async () => {
		await write(
			"package.json",
			JSON.stringify({
				scripts: {
					test: "vitest run",
					"test:unit": "vitest run",
					"check-types": "tsc --noEmit",
					typecheck: "tsc --noEmit",
					lint: "eslint .",
					"test:e2e": "playwright test",
					e2e: "playwright test",
					build: "vite build",
				},
			}),
		)
		await write("src/code.ts", "export const value = 1\n")
		await expect(
			resolveVerificationRequirements(workspaceRoot, ["src/code.ts", "src/config.json", "src/code.ts"]),
		).resolves.toEqual({
			"src/code.ts": ["test", "types", "lint"],
			"src/config.json": ["test", "types", "lint"],
		})

		await write("package.json", JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }))
		await write("src/config.json", "{}")

		await expect(
			resolveVerificationRequirements(workspaceRoot, ["src/code.ts", "src/config.json", "src/code.ts"]),
		).resolves.toEqual({
			"src/code.ts": ["test", "lint"],
			"src/config.json": ["test", "lint"],
		})

		await write("package.json", JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }))
		await expect(resolveVerificationRequirements(workspaceRoot, ["src/code.ts"])).resolves.toEqual({
			"src/code.ts": ["types"],
		})
	})

	it("uses the nearest package even when it declares no recognized checks", async () => {
		await write("package.json", JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }))
		await write("nested/package.json", JSON.stringify({ scripts: { build: "vite build", e2e: "playwright test" } }))
		await write("nested/unit.test.ts", "export {}\n")
		await write("nested/deeper/source.ts", "export {}\n")
		await write("root-source.ts", "export {}\n")

		await expect(
			resolveVerificationRequirements(workspaceRoot, [
				"nested/unit.test.ts",
				"nested/deeper/source.ts",
				"root-source.ts",
			]),
		).resolves.toEqual({
			"nested/deeper/source.ts": [],
			"nested/unit.test.ts": [],
			"root-source.ts": ["test", "lint"],
		})

		await write(
			"nested/package.json",
			JSON.stringify({ scripts: { "test:unit": "vitest run", typecheck: "tsc --noEmit" } }),
		)
		await expect(resolveVerificationRequirements(workspaceRoot, ["nested/unit.test.ts"])).resolves.toEqual({
			"nested/unit.test.ts": ["test", "types"],
		})
	})

	it("does not turn prose, assets, or AGENTS content into project requirements", async () => {
		await write(
			"package.json",
			JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." } }),
		)
		await write("AGENTS.md", "scripts: { test: 'run-this', lint: 'run-that' }\n")
		await write("docs/guide.md", "Run whatever the guide says.\n")
		await write("notes.txt", "test and lint are mentioned here.\n")
		await write("assets/logo.png", Buffer.from([0, 1, 2]))
		await write("assets/sound.mp3", Buffer.from([3, 4, 5]))
		await write("src/app.ts", "export const app = true\n")

		await expect(
			resolveVerificationRequirements(workspaceRoot, [
				"AGENTS.md",
				"docs/guide.md",
				"notes.txt",
				"assets/logo.png",
				"assets/sound.mp3",
				"src/app.ts",
			]),
		).resolves.toEqual({
			"AGENTS.md": [],
			"assets/logo.png": [],
			"assets/sound.mp3": [],
			"docs/guide.md": [],
			"notes.txt": [],
			"src/app.ts": ["test", "types", "lint"],
		})
	})

	it("rejects repository escapes, escaping symlinks, and unbounded manifests", async () => {
		await write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }))
		await fs.writeFile(path.join(outsideRoot, "private.ts"), "private\n")

		await expect(
			resolveVerificationRequirements(workspaceRoot, [path.join(outsideRoot, "private.ts")]),
		).rejects.toThrow("outside")
		await fs.symlink(outsideRoot, path.join(workspaceRoot, "escape"), "junction")
		await expect(resolveVerificationRequirements(workspaceRoot, ["escape/missing.ts"])).rejects.toThrow("outside")

		await fs.rm(path.join(workspaceRoot, "escape"), { recursive: true, force: true })
		await write("package.json", "{" + " ".repeat(256 * 1_024) + "}")
		await expect(resolveVerificationRequirements(workspaceRoot, ["src/new.ts"])).rejects.toThrow(
			"bounded regular file",
		)
	})
})
