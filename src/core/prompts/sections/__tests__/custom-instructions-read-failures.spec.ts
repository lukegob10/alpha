import fs from "fs/promises"
import * as os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { homeDirectoryState } = vi.hoisted(() => ({ homeDirectoryState: { value: "" } }))
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return { ...actual, homedir: () => homeDirectoryState.value }
})

import { addCustomInstructionParts, loadApplicableAgentInstructionSources } from "../custom-instructions"

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
})
