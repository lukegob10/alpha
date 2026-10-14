import fs from "fs/promises"
import * as os from "os"
import path from "path"

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

describe("project instruction discovery", () => {
	let fixtureRoot: string
	let projectCwd: string
	let homeDirectory: string

	beforeEach(async () => {
		fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-project-instructions-")))
		projectCwd = path.join(fixtureRoot, "packages", "app")
		homeDirectory = path.join(fixtureRoot, "home")
		await fs.mkdir(path.join(fixtureRoot, ".git"), { recursive: true })
		await fs.mkdir(projectCwd, { recursive: true })
		await fs.mkdir(homeDirectory, { recursive: true })

		homeDirectoryState.value = homeDirectory

		await fs.writeFile(path.join(fixtureRoot, "AGENTS.md"), "Stale repository guidance")
		await fs.writeFile(path.join(fixtureRoot, "AGENTS.override.md"), "Repository override guidance")
		await fs.writeFile(path.join(projectCwd, "AGENTS.md"), "Workspace guidance")
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		homeDirectoryState.value = ""
		await fs.rm(fixtureRoot, { recursive: true, force: true })
	})

	it("loads root-to-cwd instructions with same-directory override precedence in the rendered prompt", async () => {
		const sources = await loadApplicableAgentInstructionSources(projectCwd)
		expect(sources).toEqual([
			{
				kind: "agents",
				ref: path.join(fixtureRoot, "AGENTS.override.md"),
				text: "Repository override guidance",
			},
			{
				kind: "agents",
				ref: path.join(projectCwd, "AGENTS.md"),
				text: "Workspace guidance",
			},
		])

		const parts = await addCustomInstructionParts("Mode guidance", "Alpha global guidance", projectCwd, "code")
		const prompt = renderCustomInstructionParts(parts)
		const agentRules = parts.find(({ origin }) => origin === "agent-rules")

		expect(agentRules).toMatchObject({ role: "user", origin: "agent-rules" })
		expect(agentRules?.content).toContain("Repository override guidance")
		expect(agentRules?.content).toContain("Workspace guidance")
		expect(agentRules?.content).not.toContain("Stale repository guidance")
		expect(prompt).toContain("Global Instructions:\nAlpha global guidance")
		expect(prompt).toContain("Mode-specific Instructions:\nMode guidance")
		expect(prompt).toContain("Repository override guidance")
		expect(prompt).toContain("Workspace guidance")
		expect(prompt).not.toContain("Stale repository guidance")
		expect(prompt.indexOf("Global Instructions:")).toBeLessThan(prompt.indexOf("Mode-specific Instructions:"))
		expect(prompt.indexOf("Mode-specific Instructions:")).toBeLessThan(
			prompt.indexOf("Repository override guidance"),
		)
	})

	it("caps root-to-cwd AGENTS files at 32 KiB while preserving UTF-8 and Alpha local rules", async () => {
		const maxBytes = 32 * 1024
		const rootText = "R".repeat(maxBytes - 3)
		const nestedDirectory = path.join(projectCwd, "src")
		const nestedRules = path.join(nestedDirectory, "AGENTS.md")
		const localText = "Alpha personal guidance"
		const alphaSubfolderDirectory = path.join(nestedDirectory, "custom")
		const alphaSubfolderRules = path.join(alphaSubfolderDirectory, "AGENTS.md")
		const alphaSubfolderText = "C".repeat(maxBytes + 10)
		await fs.mkdir(nestedDirectory, { recursive: true })
		await fs.mkdir(path.join(alphaSubfolderDirectory, ".roo"), { recursive: true })
		await fs.writeFile(path.join(alphaSubfolderDirectory, ".roo", "rules.md"), "existing Alpha rules marker")
		await fs.writeFile(path.join(fixtureRoot, "AGENTS.override.md"), rootText)
		await fs.writeFile(path.join(fixtureRoot, "AGENTS.local.md"), localText)
		await fs.writeFile(path.join(projectCwd, "AGENTS.md"), "a😀b")
		await fs.writeFile(nestedRules, "This file is beyond the project instruction budget")
		await fs.writeFile(alphaSubfolderRules, alphaSubfolderText)

		const readFileSpy = vi.spyOn(fs, "readFile")
		const sources = await loadApplicableAgentInstructionSources(nestedDirectory, true)

		expect(sources).toEqual([
			{ kind: "agents", ref: path.join(fixtureRoot, "AGENTS.override.md"), text: rootText },
			{ kind: "agents", ref: path.join(fixtureRoot, "AGENTS.local.md"), text: localText },
			{ kind: "agents", ref: path.join(projectCwd, "AGENTS.md"), text: "a" },
			{ kind: "agents", ref: alphaSubfolderRules, text: alphaSubfolderText },
		])
		expect(
			readFileSpy.mock.calls.some(([filePath]) => {
				const readPath = filePath.toString()
				return path.basename(readPath) === "AGENTS.md" && path.basename(path.dirname(readPath)) === "src"
			}),
		).toBe(false)

		const parts = await addCustomInstructionParts(
			"Mode guidance",
			"Alpha global guidance",
			nestedDirectory,
			"code",
			{
				agentInstructionSources: sources,
			},
		)
		const prompt = renderCustomInstructionParts(parts)
		const agentRules = parts.find(({ origin }) => origin === "agent-rules")

		expect(agentRules?.content).toContain("Alpha personal guidance")
		expect(agentRules?.content).toContain(alphaSubfolderText)
		expect(agentRules?.content).toContain("\na")
		expect(agentRules?.content).not.toContain("�")
		expect(agentRules?.content).not.toContain("😀")
		expect(prompt).toContain("Alpha global guidance")
		expect(prompt).toContain("Mode guidance")
		expect(prompt).not.toContain("This file is beyond the project instruction budget")
	})

	it("keeps an empty override authoritative without spending the deeper instruction budget", async () => {
		await fs.writeFile(path.join(fixtureRoot, "AGENTS.override.md"), " ".repeat(32 * 1024))
		const expectedSources = [
			{ kind: "agents", ref: path.join(projectCwd, "AGENTS.md"), text: "Workspace guidance" },
		]

		expect(await loadApplicableAgentInstructionSources(projectCwd)).toEqual(expectedSources)
		const parts = await addCustomInstructionParts("", "", projectCwd, "code")
		expect(parts.find(({ origin }) => origin === "agent-rules")?.content).toBe(
			"# Agent Rules Standard (AGENTS.md):\nWorkspace guidance",
		)
	})

	it.each([false, true])(
		"ignores special-file candidates (symlink: %s) before reading and selects the regular fallback",
		async (isSymbolicLink) => {
			const overridePath = path.join(fixtureRoot, "AGENTS.override.md")
			const originalLstat = fs.lstat.bind(fs)
			vi.spyOn(fs, "lstat").mockImplementation(async (filePath) => {
				const stats = await originalLstat(filePath)
				if (path.resolve(filePath.toString()) === path.resolve(overridePath)) {
					stats.isFile = () => false
					stats.isSymbolicLink = () => isSymbolicLink
				}
				return stats
			})
			const originalStat = fs.stat.bind(fs)
			vi.spyOn(fs, "stat").mockImplementation(async (filePath) => {
				const stats = await originalStat(filePath)
				if (path.resolve(filePath.toString()) === path.resolve(overridePath)) stats.isFile = () => false
				return stats
			})
			const readFileSpy = vi.spyOn(fs, "readFile")

			expect(await loadApplicableAgentInstructionSources(projectCwd)).toEqual([
				{ kind: "agents", ref: path.join(fixtureRoot, "AGENTS.md"), text: "Stale repository guidance" },
				{ kind: "agents", ref: path.join(projectCwd, "AGENTS.md"), text: "Workspace guidance" },
			])
			expect(
				readFileSpy.mock.calls.some(([filePath]) => path.resolve(filePath.toString()) === overridePath),
			).toBe(false)
		},
	)

	it("retains a captured nested override after file changes and honors an empty captured source list", async () => {
		const nestedOverridePath = path.join(projectCwd, "AGENTS.override.md")
		await fs.writeFile(nestedOverridePath, "Nested override captured before launch")
		const sources = await loadApplicableAgentInstructionSources(projectCwd)
		expect(sources.at(-1)).toEqual({
			kind: "agents",
			ref: nestedOverridePath,
			text: "Nested override captured before launch",
		})
		await fs.writeFile(nestedOverridePath, "Mutable nested override")
		await fs.writeFile(path.join(projectCwd, "AGENTS.local.md"), "New personal guidance")
		const readFileSpy = vi.spyOn(fs, "readFile")

		const capturedParts = await addCustomInstructionParts("", "", projectCwd, "code", {
			agentInstructionSources: sources,
		})
		const emptyParts = await addCustomInstructionParts("", "", projectCwd, "code", {
			agentInstructionSources: [],
		})

		expect(capturedParts.find(({ origin }) => origin === "agent-rules")?.content).toContain(
			"Nested override captured before launch",
		)
		expect(renderCustomInstructionParts(capturedParts)).not.toContain("Mutable nested override")
		expect(renderCustomInstructionParts(capturedParts)).not.toContain("New personal guidance")
		expect(emptyParts.some(({ origin }) => origin === "agent-rules")).toBe(false)
		expect(
			readFileSpy.mock.calls.some(([filePath]) => path.basename(filePath.toString()).startsWith("AGENT")),
		).toBe(false)
	})
})
