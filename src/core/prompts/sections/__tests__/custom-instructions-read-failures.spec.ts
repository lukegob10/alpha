import fs from "fs/promises"
import * as os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { homeDirectoryState } = vi.hoisted(() => ({ homeDirectoryState: { value: "" } }))
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return { ...actual, homedir: () => homeDirectoryState.value }
})

import {
	addCustomInstructionParts,
	loadApplicableAgentInstructionSources,
	renderCustomInstructionParts,
} from "../custom-instructions"

describe("agent instruction read failures", () => {
	let fixtureRoot: string
	let cwd: string
	let override: string

	beforeEach(async () => {
		fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-instruction-failures-")))
		cwd = path.join(fixtureRoot, "project")
		homeDirectoryState.value = path.join(fixtureRoot, "home")
		await fs.mkdir(cwd, { recursive: true })
		await fs.mkdir(homeDirectoryState.value)
		override = path.join(cwd, "AGENTS.override.md")
		await fs.writeFile(override, "Preferred guidance")
		await fs.writeFile(path.join(cwd, "AGENTS.md"), "Weaker fallback guidance")
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		homeDirectoryState.value = ""
		await fs.rm(fixtureRoot, { recursive: true, force: true })
	})

	it.each(["lstat", "realpath", "readFile"] as const)(
		"rejects unexpected %s failures without selecting weaker instructions",
		async (operation) => {
			const original = fs[operation].bind(fs)
			vi.spyOn(fs, operation).mockImplementation(async (...args: unknown[]) => {
				if (String(args[0]) === override) {
					throw Object.assign(new Error("sensitive filesystem details"), { code: "EACCES" })
				}
				return Reflect.apply(original, fs, args)
			})
			const read = operation === "readFile" ? vi.mocked(fs.readFile) : vi.spyOn(fs, "readFile")

			for (const load of [
				() => loadApplicableAgentInstructionSources(cwd),
				() => addCustomInstructionParts("", "", cwd, "code"),
			]) {
				await expect(load()).rejects.toThrow(`Unable to load agent instructions from "${override}" (EACCES)`)
				await expect(load()).rejects.not.toThrow("sensitive filesystem details")
			}
			expect(read.mock.calls.some(([file]) => String(file) === path.join(cwd, "AGENTS.md"))).toBe(false)
		},
	)

	it("reports optional local instruction failures consistently during rendering and source capture", async () => {
		const local = path.join(cwd, "AGENTS.local.md")
		await fs.writeFile(local, "Personal guidance")
		const original = fs.readFile.bind(fs)
		vi.spyOn(fs, "readFile").mockImplementation(async (...args: unknown[]) => {
			if (String(args[0]) === local) throw Object.assign(new Error("private details"), { code: "EIO" })
			return Reflect.apply(original, fs, args)
		})

		await expect(loadApplicableAgentInstructionSources(cwd)).rejects.toThrow(`"${local}" (EIO)`)
		await expect(addCustomInstructionParts("", "", cwd, "code")).rejects.toThrow(`"${local}" (EIO)`)
	})

	it("keeps missing and directory candidates optional and reloads the preferred file when restored", async () => {
		await fs.unlink(override)
		await fs.mkdir(override)
		expect((await loadApplicableAgentInstructionSources(cwd)).map(({ text }) => text)).toEqual([
			"Weaker fallback guidance",
		])
		await fs.rmdir(override)
		await fs.writeFile(override, "Restored preferred guidance")
		expect((await loadApplicableAgentInstructionSources(cwd)).map(({ text }) => text)).toEqual([
			"Restored preferred guidance",
		])
	})

	it("replays captured instruction sources without reopening an unreadable override", async () => {
		const sources = await loadApplicableAgentInstructionSources(cwd)
		const original = fs.readFile.bind(fs)
		vi.spyOn(fs, "readFile").mockImplementation(async (...args: unknown[]) => {
			if (String(args[0]) === override) throw Object.assign(new Error("unavailable"), { code: "EIO" })
			return Reflect.apply(original, fs, args)
		})

		const parts = await addCustomInstructionParts("", "", cwd, "code", { agentInstructionSources: sources })
		expect(parts.find(({ origin }) => origin === "agent-rules")?.content).toContain("Preferred guidance")
	})

	describe.each(["rules", "rules-code"])("preferred .alpha/%s instructions", (directoryName) => {
		const failures = (["stat", "realpath", "readdir", "readFile"] as const).flatMap((operation) =>
			(["EACCES", "EIO"] as const).map((code) => ({ operation, code })),
		)

		async function writeRuleSources() {
			const preferredDirectory = path.join(cwd, ".alpha", directoryName)
			const ignoredDirectory = path.join(cwd, ".config-archive", directoryName)
			await fs.mkdir(preferredDirectory, { recursive: true })
			await fs.mkdir(ignoredDirectory, { recursive: true })
			const preferredFile = path.join(preferredDirectory, "preferred.md")
			await fs.writeFile(preferredFile, "Preferred Alpha rules")
			await fs.writeFile(path.join(preferredDirectory, "other.md"), "Other Alpha rules")
			await fs.writeFile(path.join(ignoredDirectory, "legacy.md"), "Ignored directory rules")
			await fs.writeFile(path.join(cwd, `.alpha${directoryName}`), "Flat Alpha fallback rules")
			return { preferredDirectory, preferredFile, ignoredDirectory }
		}

		it.each(failures)(
			"rejects $operation $code without partial rules or weaker fallbacks",
			async ({ operation, code }) => {
				const { preferredDirectory, preferredFile, ignoredDirectory } = await writeRuleSources()
				const failedPath = operation === "readFile" ? preferredFile : preferredDirectory
				const original = fs[operation].bind(fs)
				vi.spyOn(fs, operation).mockImplementation(async (...args: unknown[]) => {
					if (String(args[0]) === failedPath) {
						throw Object.assign(new Error("private filesystem contents"), { code })
					}
					return Reflect.apply(original, fs, args)
				})
				const read = operation === "readFile" ? vi.mocked(fs.readFile) : vi.spyOn(fs, "readFile")

				await expect(addCustomInstructionParts("", "", cwd, "code")).rejects.toThrow(
					`Unable to load rule instructions from "${preferredDirectory}" (${code})`,
				)
				await expect(addCustomInstructionParts("", "", cwd, "code")).rejects.not.toThrow(
					"private filesystem contents",
				)
				expect(read.mock.calls.some(([file]) => String(file).startsWith(ignoredDirectory + path.sep))).toBe(
					false,
				)
				expect(
					read.mock.calls.some(([file]) => String(file) === path.join(cwd, `.alpha${directoryName}`)),
				).toBe(false)
			},
		)

		it("retains missing-directory fallback and reloads preferred instructions on the next assembly", async () => {
			const { preferredDirectory } = await writeRuleSources()
			const original = fs.readdir.bind(fs)
			vi.spyOn(fs, "readdir").mockImplementation(async (...args: unknown[]) => {
				if (String(args[0]) === preferredDirectory) {
					throw Object.assign(new Error("Directory disappeared"), { code: "ENOENT" })
				}
				return Reflect.apply(original, fs, args)
			})

			const missing = renderCustomInstructionParts(await addCustomInstructionParts("", "", cwd, "code"))
			expect(missing).toContain("Flat Alpha fallback rules")
			expect(missing).not.toContain("Preferred Alpha rules")

			vi.restoreAllMocks()
			const restored = renderCustomInstructionParts(await addCustomInstructionParts("", "", cwd, "code"))
			expect(restored).toContain("Preferred Alpha rules")
			expect(restored).not.toContain("Ignored directory rules")
			expect(restored).not.toContain("Flat Alpha fallback rules")
		})

		it.each(["EACCES", "EIO"])("rejects %s while resolving an included rule symlink", async (code) => {
			const { preferredDirectory } = await writeRuleSources()
			const target = path.join(cwd, ".alpha", "shared-rules")
			await fs.mkdir(target)
			await fs.writeFile(path.join(target, "shared.md"), "Shared rule instructions")
			const link = path.join(preferredDirectory, "shared")
			await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir")
			const original = fs.readlink.bind(fs)
			vi.spyOn(fs, "readlink").mockImplementation(async (...args: unknown[]) => {
				if (String(args[0]) === link) throw Object.assign(new Error("private symlink details"), { code })
				return Reflect.apply(original, fs, args)
			})

			await expect(addCustomInstructionParts("", "", cwd, "code")).rejects.toThrow(
				`Unable to load rule instructions from "${preferredDirectory}" (${code})`,
			)
		})
	})

	it("rejects an inaccessible flat Alpha rule file without reading unrelated files", async () => {
		const alphaRules = path.join(cwd, ".alpharules")
		const unrelatedRules = path.join(cwd, ".unrelated-rules")
		await fs.writeFile(alphaRules, "Preferred flat Alpha rules")
		await fs.writeFile(unrelatedRules, "Unrelated rules")
		const original = fs.realpath.bind(fs)
		vi.spyOn(fs, "realpath").mockImplementation(async (...args: unknown[]) => {
			if (String(args[0]) === alphaRules) throw Object.assign(new Error("private details"), { code: "EACCES" })
			return Reflect.apply(original, fs, args)
		})
		const read = vi.spyOn(fs, "readFile")

		await expect(addCustomInstructionParts("", "", cwd, "code")).rejects.toThrow(
			`Unable to load rule instructions from "${alphaRules}" (EACCES)`,
		)
		expect(read.mock.calls.some(([file]) => String(file) === unrelatedRules)).toBe(false)
	})
})
