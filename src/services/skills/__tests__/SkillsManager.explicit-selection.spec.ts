import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AlphaProvider } from "../../../core/webview/AlphaProvider"

const { fixture } = vi.hoisted(() => ({ fixture: { home: "" } }))
vi.mock("os", async (original) => ({
	...(await original<typeof import("os")>()),
	homedir: () => fixture.home,
}))
vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }) },
}))
vi.mock("ai-sdk-provider-poe/code", () => ({
	POE_DEFAULT_BASE_URL: "https://api.poe.com/v1",
	poeDefaultModelId: "poe-default-model",
	getPoeDefaultModelInfo: vi.fn(() => ({})),
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { SkillsManager } from "../SkillsManager"

describe("explicit skill identity selection", () => {
	let directory: string
	let cwd: string
	let extension: string
	let manager: SkillsManager
	let disabled: string[]

	async function writeSkill(root: string, name: string, modes?: string[]): Promise<string> {
		const skillDirectory = path.join(root, name)
		await fs.mkdir(skillDirectory, { recursive: true })
		const skillPath = path.join(skillDirectory, "SKILL.md")
		await fs.writeFile(
			skillPath,
			`---\nname: ${name}\ndescription: Review changes\n${modes ? `modeSlugs: [${modes.join(", ")}]\n` : ""}metadata:\n  optional-host-field: true\n---\nInstructions from ${root}\n`,
		)
		return skillPath
	}

	beforeEach(async () => {
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-explicit-skills-")))
		fixture.home = path.join(directory, "home")
		cwd = path.join(directory, "repository")
		extension = path.join(directory, "extension")
		disabled = []
		await fs.mkdir(path.join(cwd, ".git"), { recursive: true })
		await fs.mkdir(fixture.home)
		const provider = {
			cwd,
			customModesManager: { getCustomModes: vi.fn(async () => []) },
			contextProxy: {
				extensionUri: { fsPath: extension },
				getValue: () => disabled,
			},
		}
		manager = new SkillsManager(provider as unknown as AlphaProvider, cwd)
	})

	afterEach(async () => {
		await manager.dispose()
		fixture.home = ""
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("preserves ordinary overrides and selects a qualified source or exact discovered path", async () => {
		const global = await writeSkill(path.join(fixture.home, ".agents", "skills"), "review")
		const project = await writeSkill(path.join(cwd, ".agents", "skills"), "review")
		await manager.discoverSkills()
		expect(await manager.getExplicitSkillContent("review", "code")).toMatchObject({ path: project })
		expect(await manager.getExplicitSkillContent("global:review", "code")).toMatchObject({ path: global })
		expect(await manager.getExplicitSkillContent(global, "code")).toMatchObject({ path: global })
		expect(await manager.getExplicitSkillContent("missing:review", "code")).toBeNull()
		expect(await manager.getExplicitSkillContent(path.join(directory, "unknown", "SKILL.md"), "code")).toBeNull()
	})

	it("does not bypass disabled identities or mode restrictions with qualified or exact selection", async () => {
		const builtin = await writeSkill(path.join(extension, "assets", "skills"), "review")
		const restricted = await writeSkill(path.join(cwd, ".agents", "skills"), "plan-review", ["architect"])
		await manager.discoverSkills()
		disabled = ["review"]
		await expect(manager.getExplicitSkillContent("builtin:review", "code")).rejects.toThrow("explicit_disabled")
		await expect(manager.getExplicitSkillContent("review", "code")).rejects.toThrow("explicit_disabled")
		await expect(manager.getExplicitSkillContent(builtin, "code")).rejects.toThrow("explicit_disabled")
		await expect(manager.getExplicitSkillContent(restricted, "code")).rejects.toThrow("explicit_mode_unavailable")
		await expect(manager.getExplicitSkillContent("project:plan-review", "code")).rejects.toThrow(
			"explicit_mode_unavailable",
		)
		expect(await manager.getExplicitSkillContent(restricted, "architect")).toMatchObject({ path: restricted })
		// The pre-existing frozen-child lookup deliberately retains its captured identity semantics.
		expect(await manager.getSkillContentByPath("review", builtin)).toMatchObject({ path: builtin })
	})

	it("preserves mode-specific precedence while allowing exact selection of the generic identity", async () => {
		const generic = await writeSkill(path.join(cwd, ".alpha", "skills"), "review")
		const specific = await writeSkill(path.join(cwd, ".alpha", "skills-code"), "review")
		await manager.discoverSkills()
		expect(await manager.getExplicitSkillContent("review", "code")).toMatchObject({ path: specific })
		expect(await manager.getExplicitSkillContent("project:review", "code")).toMatchObject({ path: specific })
		expect(await manager.getExplicitSkillContent("review", "architect")).toMatchObject({ path: generic })
		expect(await manager.getExplicitSkillContent(generic, "code")).toMatchObject({ path: generic })
	})

	it("loads explicit-only skills lazily without requiring optional ecosystem metadata", async () => {
		const selected = await writeSkill(path.join(cwd, ".agents", "skills"), "review")
		await fs.mkdir(path.join(path.dirname(selected), "agents"))
		await fs.writeFile(
			path.join(path.dirname(selected), "agents", "openai.yaml"),
			"interface:\n  display_name: Review\npolicy:\n  allow_implicit_invocation: false\n",
		)
		await manager.discoverSkills()
		expect(manager.getImplicitSkillsForMode("code")).toEqual([])
		expect(manager.getSkillsMetadata()[0]).not.toHaveProperty("instructions")
		expect(await manager.getExplicitSkillContent("project:review", "code")).toMatchObject({
			path: selected,
			allowImplicitInvocation: false,
			instructions: expect.stringContaining("Instructions from"),
		})
	})

	it("rejects equally specific qualified identities instead of guessing between overlapping modes", async () => {
		await writeSkill(path.join(cwd, ".alpha", "skills-code"), "review", ["code", "architect"])
		const exact = await writeSkill(path.join(cwd, ".alpha", "skills-architect"), "review", ["architect", "code"])
		await manager.discoverSkills()
		await expect(manager.getExplicitSkillContent("project:review", "code")).rejects.toThrow("explicit_ambiguous")
		await expect(manager.getExplicitSkillContent("review", "code")).rejects.toThrow("explicit_ambiguous")
		expect(await manager.getExplicitSkillContent(exact, "code")).toMatchObject({ path: exact })
	})
})
