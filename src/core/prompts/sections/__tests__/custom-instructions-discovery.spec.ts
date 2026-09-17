import fs from "fs/promises"
import os from "os"
import path from "path"

vi.mock("../../../../services/search/file-search", () => ({ executeRipgrep: vi.fn() }))
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	const homedir = vi.fn(actual.homedir)
	return { ...actual, homedir, default: { ...actual, homedir } }
})

import { executeRipgrep } from "../../../../services/search/file-search"
import { addCustomInstructions, loadRuleFiles } from "../custom-instructions"

describe("custom instruction assembly discovery", () => {
	let fixture: string
	let cwd: string
	let home: string

	async function write(relative: string, content: string) {
		const target = path.join(fixture, relative)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, content)
	}

	const assemble = (enableSubfolderRules = true, useAgentRules = true) =>
		addCustomInstructions("mode guidance", "global guidance", cwd, "code", {
			settings: { enableSubfolderRules, useAgentRules, todoListEnabled: true, newTaskRequireTodos: false },
		})

	beforeEach(async () => {
		fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-instruction-discovery-")))
		cwd = path.join(fixture, "workspace")
		home = path.join(fixture, "home")
		await fs.mkdir(cwd, { recursive: true })
		await fs.mkdir(home, { recursive: true })
		vi.mocked(os.homedir).mockReturnValue(home)
		vi.mocked(executeRipgrep).mockReset()
		vi.mocked(executeRipgrep).mockResolvedValue([
			{ path: "z/.roo/rules/rule.md", type: "file" },
			{ path: "a/.roo/rules/rule.md", type: "file" },
		])
		for (const [directory, label] of [
			["home", "global"],
			["workspace", "project"],
			["workspace/a", "a"],
			["workspace/z", "z"],
		]) {
			await write(`${directory}/.alpha/rules-code/rule.md`, `${label} mode`)
			await write(`${directory}/.alpha/rules/rule.md`, `${label} generic`)
			await write(`${directory}/.roo/rules-code/rule.md`, `${label} legacy mode`)
			await write(`${directory}/.roo/rules/rule.md`, `${label} legacy generic`)
		}
		await write("workspace/AGENTS.md", "root agent")
		await write("workspace/AGENTS.local.md", "root personal")
		await write("workspace/a/AGENT.md", "a agent")
		await write("workspace/z/AGENTS.local.md", "z personal")
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(fixture, { recursive: true, force: true })
	})

	function normalized(text: string) {
		return text.replaceAll("\\", "/")
	}

	it("preserves the complete ordered prompt while discovering once per assembly", async () => {
		const prompt = await assemble()
		expect(normalized(prompt)).toMatchSnapshot()
		expect(executeRipgrep).toHaveBeenCalledTimes(1)
	})

	it("performs fresh discovery and reads on the next assembly", async () => {
		const first = await assemble()
		await write("workspace/a/AGENT.md", "updated a agent")
		await write("workspace/new/AGENTS.md", "new agent")
		vi.mocked(executeRipgrep).mockResolvedValue([{ path: "new/.roo/rules/rule.md", type: "file" }])
		const second = await assemble()
		expect(first).toContain("a agent")
		expect(second).toContain("new agent")
		expect(second).not.toContain("a agent")
		await write("workspace/new/AGENTS.md", "updated new agent")
		expect(await assemble()).toContain("updated new agent")
		expect(executeRipgrep).toHaveBeenCalledTimes(3)
	})

	it("does no recursive discovery when disabled", async () => {
		expect(normalized(await assemble(false))).toMatchSnapshot()
		expect(executeRipgrep).not.toHaveBeenCalled()
	})

	it("retains root rules after discovery failure and retries discovery on the next assembly", async () => {
		vi.mocked(executeRipgrep).mockRejectedValueOnce(new Error("Discovery unavailable"))
		const first = await assemble()
		expect(first).toContain("root agent")
		expect(first).toContain("project generic")
		expect(first).not.toContain("a agent")
		expect(await assemble()).toContain("a agent")
		expect(executeRipgrep).toHaveBeenCalledTimes(2)
	})

	it("preserves legacy fallback and disabled agent rules", async () => {
		for (const directory of [home, cwd, path.join(cwd, "a"), path.join(cwd, "z")]) {
			await fs.rm(path.join(directory, ".alpha"), { recursive: true })
		}
		expect(normalized(await assemble(true, false))).toMatchSnapshot()
		expect(executeRipgrep).toHaveBeenCalledTimes(1)
	})

	it("uses supplied agent sources while retaining ordinary rule discovery", async () => {
		const prompt = await addCustomInstructions("", "", cwd, "code", {
			settings: {
				enableSubfolderRules: true,
				useAgentRules: true,
				todoListEnabled: true,
				newTaskRequireTodos: false,
			},
			agentInstructionSources: [{ kind: "agents", ref: path.join(cwd, "AGENTS.md"), text: "frozen agent" }],
		})
		expect(prompt).toContain("frozen agent")
		expect(prompt).not.toContain("root agent")
		expect(executeRipgrep).toHaveBeenCalledTimes(1)
	})

	it("keeps standalone generic-rule calls fresh", async () => {
		expect(await loadRuleFiles(cwd, true)).toContain("project generic")
		await write("workspace/.alpha/rules/rule.md", "changed generic")
		expect(await loadRuleFiles(cwd, true)).toContain("changed generic")
		expect(executeRipgrep).toHaveBeenCalledTimes(2)
	})

	it("shares discovery without requiring a mode or live agent sources", async () => {
		const prompt = await addCustomInstructions("", "", cwd, "", {
			settings: {
				enableSubfolderRules: true,
				useAgentRules: true,
				todoListEnabled: true,
				newTaskRequireTodos: false,
			},
			agentInstructionSources: [],
		})
		expect(prompt).toContain("a generic")
		expect(prompt).not.toContain("a mode")
		expect(prompt).not.toContain("root agent")
		expect(executeRipgrep).toHaveBeenCalledTimes(1)
	})
})
