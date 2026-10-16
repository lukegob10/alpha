import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AlphaProvider } from "../../../core/webview/AlphaProvider"

const { fixture } = vi.hoisted(() => ({
	fixture: {
		home: "",
		globalMarkers: undefined as string[] | undefined,
		workspaceMarkers: undefined as string[] | undefined,
	},
}))
vi.mock("os", async (original) => ({
	...(await original<typeof import("os")>()),
	homedir: () => fixture.home,
}))
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		})),
		getConfiguration: () => ({
			get: (key: string, fallback: unknown) =>
				key === "projectRootMarkers"
					? (fixture.workspaceMarkers ?? fixture.globalMarkers ?? fallback)
					: fallback,
			inspect: (key: string) =>
				key === "projectRootMarkers"
					? {
							defaultValue: [".git"],
							globalValue: fixture.globalMarkers,
							workspaceValue: fixture.workspaceMarkers,
							workspaceFolderValue: fixture.workspaceMarkers,
						}
					: { defaultValue: [] },
		}),
	},
	RelativePattern: class {
		constructor(
			readonly base: string,
			readonly pattern: string,
		) {}
	},
}))
vi.mock("ai-sdk-provider-poe/code", () => ({
	POE_DEFAULT_BASE_URL: "https://api.poe.com/v1",
	poeDefaultModelId: "poe-default-model",
	getPoeDefaultModelInfo: vi.fn(() => ({})),
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { SkillsManager } from "../SkillsManager"

describe("WS07 public configured skill discovery", () => {
	let directory: string
	let temporaryParent: string
	let repository: string
	let configuredRoot: string
	let cwd: string
	let manager: SkillsManager
	let provider: AlphaProvider

	async function writeSkill(root: string, name: string): Promise<string> {
		const skillDirectory = path.join(root, ".agents", "skills", name)
		await fs.mkdir(skillDirectory, { recursive: true })
		const skillPath = path.join(skillDirectory, "SKILL.md")
		await fs.writeFile(
			skillPath,
			`---\nname: ${name}\ndescription: Review ${name}\n---\nInstructions for ${name}\n`,
		)
		return skillPath
	}

	beforeEach(async () => {
		temporaryParent = await fs.realpath(os.tmpdir())
		directory = await fs.realpath(await fs.mkdtemp(path.join(temporaryParent, "alpha-ws07-discovery-")))
		repository = path.join(directory, "repository")
		configuredRoot = path.join(repository, "packages")
		cwd = path.join(configuredRoot, "app")
		fixture.home = path.join(directory, "home")
		fixture.globalMarkers = undefined
		fixture.workspaceMarkers = undefined
		await fs.mkdir(path.join(repository, ".git"), { recursive: true })
		await fs.mkdir(cwd, { recursive: true })
		await fs.mkdir(fixture.home, { recursive: true })
		await fs.writeFile(path.join(configuredRoot, ".alpha-root"), "marker")
		provider = {
			cwd,
			postMessageToWebview: vi.fn(async () => undefined),
			customModesManager: { getCustomModes: vi.fn(async () => []) },
			contextProxy: { extensionUri: { fsPath: path.join(directory, "extension") }, getValue: vi.fn(() => []) },
		} as unknown as AlphaProvider
		manager = new SkillsManager(provider, cwd)
	})

	afterEach(async () => {
		await manager.dispose()
		fixture.home = ""
		fixture.globalMarkers = undefined
		fixture.workspaceMarkers = undefined
		const target = path.resolve(directory)
		if (path.dirname(target) !== temporaryParent || !path.basename(target).startsWith("alpha-ws07-discovery-")) {
			throw new Error("WS07 discovery cleanup escaped its owned temporary directory")
		}
		await fs.rm(target, { recursive: true, force: true })
	})

	it("keeps default direct portable discovery as the baseline control", async () => {
		const skillPath = await writeSkill(cwd, "direct-review")
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "direct-review", path: skillPath }),
		])
	})

	it("captures a user custom-root marker through the ordinary two-argument manager constructor", async () => {
		await writeSkill(repository, "outside-root")
		const insidePath = await writeSkill(configuredRoot, "inside-root")
		fixture.globalMarkers = [".alpha-root"]
		await manager.dispose()
		manager = new SkillsManager(provider, cwd)
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "inside-root", path: insidePath }),
		])
	})

	it("keeps an explicit user no-parent boundary from being broadened by workspace settings", async () => {
		await writeSkill(configuredRoot, "ancestor-review")
		const localPath = await writeSkill(cwd, "local-review")
		fixture.globalMarkers = []
		fixture.workspaceMarkers = [".git"]
		await manager.dispose()
		manager = new SkillsManager(provider, cwd)
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "local-review", path: localPath }),
		])
	})

	it("keeps constructor-captured global markers stable across later user settings edits", async () => {
		await writeSkill(repository, "outside-root")
		const insidePath = await writeSkill(configuredRoot, "inside-root")
		const markers = [".alpha-root"]
		fixture.globalMarkers = markers
		await manager.dispose()
		manager = new SkillsManager(provider, cwd)
		markers[0] = ".git"
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "inside-root", path: insidePath }),
		])
	})

	it("retains an admitted no-parent boundary despite global settings and caller edits", async () => {
		await writeSkill(configuredRoot, "ancestor-review")
		const localPath = await writeSkill(cwd, "local-review")
		fixture.globalMarkers = [".git"]
		const markers: string[] = []
		await manager.dispose()
		manager = new SkillsManager(provider, cwd, { projectInstructionDiscovery: { projectRootMarkers: markers } })
		markers.push(".git")
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "local-review", path: localPath }),
		])
	})
})
