import fs from "fs/promises"
import * as os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { homeDirectoryState } = vi.hoisted(() => ({ homeDirectoryState: { value: "" } }))
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return { ...actual, homedir: () => homeDirectoryState.value }
})

import { getProjectInstructionDirectoriesForCwd } from "../../../../services/config-paths"
import { addCustomInstructionParts, loadApplicableAgentInstructionSources } from "../custom-instructions"

describe("configured project instruction discovery", () => {
	let fixtureRoot: string
	let repositoryRoot: string
	let configuredRoot: string
	let cwd: string

	beforeEach(async () => {
		fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-configured-instructions-")))
		repositoryRoot = path.join(fixtureRoot, "repository")
		configuredRoot = path.join(repositoryRoot, "packages")
		cwd = path.join(configuredRoot, "app")
		homeDirectoryState.value = path.join(fixtureRoot, "home")
		await fs.mkdir(path.join(repositoryRoot, ".git"), { recursive: true })
		await fs.mkdir(cwd, { recursive: true })
		await fs.mkdir(homeDirectoryState.value, { recursive: true })
		await fs.writeFile(path.join(configuredRoot, ".alpha-root"), "marker")
		await fs.writeFile(path.join(repositoryRoot, "AGENTS.md"), "Outside configured root")
		await fs.writeFile(path.join(configuredRoot, "WORKFLOW.md"), "Configured root guidance")
		await fs.writeFile(path.join(cwd, "AGENTS.md"), "Current directory guidance")
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		homeDirectoryState.value = ""
		await fs.rm(fixtureRoot, { recursive: true, force: true })
	})

	it("uses one custom-marker boundary and root-to-cwd fallback order", async () => {
		const options = { projectRootMarkers: [".alpha-root"], projectDocFallbackFilenames: ["WORKFLOW.md"] }
		expect(await getProjectInstructionDirectoriesForCwd(cwd, options)).toEqual({
			root: configuredRoot,
			directories: [configuredRoot, cwd],
		})
		expect(await loadApplicableAgentInstructionSources(cwd, false, options)).toEqual([
			{ kind: "agents", ref: path.join(configuredRoot, "WORKFLOW.md"), text: "Configured root guidance" },
			{ kind: "agents", ref: path.join(cwd, "AGENTS.md"), text: "Current directory guidance" },
		])
	})

	it("treats an explicit empty marker list as current-directory-only", async () => {
		const options = { projectRootMarkers: [], projectDocFallbackFilenames: ["WORKFLOW.md"] }
		const read = vi.spyOn(fs, "readFile")

		expect(await getProjectInstructionDirectoriesForCwd(cwd, options)).toEqual({ root: cwd, directories: [cwd] })
		expect(await loadApplicableAgentInstructionSources(cwd, false, options)).toEqual([
			{ kind: "agents", ref: path.join(cwd, "AGENTS.md"), text: "Current directory guidance" },
		])
		expect(
			read.mock.calls.some(([file]) => path.resolve(file.toString()) === path.join(repositoryRoot, "AGENTS.md")),
		).toBe(false)
		expect(
			read.mock.calls.some(
				([file]) => path.resolve(file.toString()) === path.join(configuredRoot, "WORKFLOW.md"),
			),
		).toBe(false)
	})

	it("preserves standard and override precedence ahead of configured fallbacks and AGENT compatibility", async () => {
		const options = {
			projectRootMarkers: [".alpha-root"],
			projectDocFallbackFilenames: ["WORKFLOW.md", "GUIDE.md"],
		}
		const override = path.join(configuredRoot, "AGENTS.override.md")
		const standard = path.join(configuredRoot, "AGENTS.md")
		await fs.writeFile(override, "Override guidance")
		await fs.writeFile(standard, "Standard guidance")
		await fs.writeFile(path.join(configuredRoot, "GUIDE.md"), "Later fallback guidance")
		await fs.writeFile(path.join(configuredRoot, "AGENT.md"), "Legacy fallback guidance")
		await fs.writeFile(path.join(configuredRoot, "AGENTS.local.md"), "Alpha local guidance")

		expect((await loadApplicableAgentInstructionSources(cwd, false, options)).map(({ text }) => text)).toEqual([
			"Override guidance",
			"Alpha local guidance",
			"Current directory guidance",
		])
		await fs.unlink(override)
		expect((await loadApplicableAgentInstructionSources(cwd, false, options))[0].text).toBe("Standard guidance")
		await fs.unlink(standard)
		expect((await loadApplicableAgentInstructionSources(cwd, false, options))[0].text).toBe(
			"Configured root guidance",
		)
		await fs.writeFile(override, "  ")
		expect((await loadApplicableAgentInstructionSources(cwd, false, options)).map(({ text }) => text)).toEqual([
			"Alpha local guidance",
			"Current directory guidance",
		])
	})

	it("ignores unsafe fallback paths and duplicate entries before any content read", async () => {
		await fs.writeFile(path.join(repositoryRoot, "SECRET.md"), "Outside secret")
		await fs.mkdir(path.join(configuredRoot, "nested"), { recursive: true })
		await fs.writeFile(path.join(configuredRoot, "nested", "GUIDE.md"), "Nested secret")
		const options = {
			projectRootMarkers: [".alpha-root", "../.git", "C:.git"],
			projectDocFallbackFilenames: [
				"../SECRET.md",
				"..\\SECRET.md",
				"nested/GUIDE.md",
				"C:SECRET.md",
				"\\\\server\\share\\secret.md",
				".",
				"..",
				"",
				"WORKFLOW.md",
				"WORKFLOW.md",
			],
		}
		const read = vi.spyOn(fs, "readFile")
		const sources = await loadApplicableAgentInstructionSources(cwd, false, options)

		expect(sources.map(({ text }) => text)).toEqual(["Configured root guidance", "Current directory guidance"])
		expect(
			read.mock.calls.filter(
				([file]) => path.resolve(file.toString()) === path.join(configuredRoot, "WORKFLOW.md"),
			),
		).toHaveLength(1)
		expect(read.mock.calls.some(([file]) => path.basename(file.toString()) === "SECRET.md")).toBe(false)
		expect(
			read.mock.calls.some(
				([file]) => path.resolve(file.toString()) === path.join(configuredRoot, "nested", "GUIDE.md"),
			),
		).toBe(false)
	})

	it("shares the project byte budget across configured fallback files without breaking UTF-8", async () => {
		const rootText = "R".repeat(32 * 1_024 - 3)
		await fs.writeFile(path.join(configuredRoot, "WORKFLOW.md"), rootText)
		await fs.unlink(path.join(cwd, "AGENTS.md"))
		await fs.writeFile(path.join(cwd, "WORKFLOW.md"), "a😀b")
		await fs.writeFile(path.join(cwd, "AGENTS.local.md"), "Alpha local compatibility")
		const sources = await loadApplicableAgentInstructionSources(cwd, false, {
			projectRootMarkers: [".alpha-root"],
			projectDocFallbackFilenames: ["WORKFLOW.md"],
		})

		expect(sources.map(({ text }) => text)).toEqual([rootText, "a"])
		expect(sources.map(({ text }) => text).join("\n")).not.toContain("�")
	})

	it.each(["AGENTS.local.md", "AGENTS.override.md"])(
		"bounds a large %s within the shared budget",
		async (filename) => {
			await fs.unlink(path.join(cwd, "AGENTS.md"))
			await fs.writeFile(path.join(cwd, filename), "😀".repeat(10_000))
			const sources = await loadApplicableAgentInstructionSources(cwd, false, { projectRootMarkers: [] })

			expect(sources).toEqual([{ kind: "agents", ref: path.join(cwd, filename), text: "😀".repeat(8_192) }])
			expect(Buffer.byteLength(sources[0].text, "utf8")).toBe(32 * 1_024)
		},
	)

	it("keeps override and personal precedence while sharing the remaining ancestor budget", async () => {
		const rootText = "R".repeat(32 * 1_024 - 8)
		await fs.writeFile(path.join(configuredRoot, "AGENTS.override.md"), rootText)
		await fs.writeFile(path.join(configuredRoot, "AGENTS.local.md"), "😀".repeat(10_000))
		const sources = await loadApplicableAgentInstructionSources(cwd, false, {
			projectRootMarkers: [".alpha-root"],
			projectDocFallbackFilenames: ["WORKFLOW.md"],
		})

		expect(sources.map(({ text }) => text)).toEqual([rootText, "😀😀"])
		expect(sources.map(({ ref }) => path.basename(ref))).toEqual(["AGENTS.override.md", "AGENTS.local.md"])
	})

	it("loads AGENTS.local.md once when it is also a configured fallback", async () => {
		await fs.writeFile(path.join(configuredRoot, "AGENTS.local.md"), "One local instruction body")
		const sources = await loadApplicableAgentInstructionSources(cwd, false, {
			projectRootMarkers: [".alpha-root"],
			projectDocFallbackFilenames: ["AGENTS.local.md", "WORKFLOW.md"],
		})

		expect(sources.filter(({ ref }) => ref === path.join(configuredRoot, "AGENTS.local.md"))).toHaveLength(1)
		expect(sources.filter(({ text }) => text === "One local instruction body")).toHaveLength(1)
	})

	it("uses the captured discovery options during full prompt assembly", async () => {
		const parts = await addCustomInstructionParts("", "", cwd, "code", {
			settings: {
				todoListEnabled: false,
				useAgentRules: true,
				newTaskRequireTodos: false,
				projectInstructionDiscovery: {
					projectRootMarkers: [".alpha-root"],
					projectDocFallbackFilenames: ["WORKFLOW.md"],
				},
			},
		})
		const rules = parts.find(({ origin }) => origin === "agent-rules")

		expect(rules).toMatchObject({ role: "user" })
		expect(rules?.content).toContain("Configured root guidance")
		expect(rules?.content).toContain("Current directory guidance")
		expect(rules?.content).not.toContain("Outside configured root")
	})
})
