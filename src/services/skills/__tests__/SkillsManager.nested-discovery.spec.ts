import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AlphaProvider } from "../../../core/webview/AlphaProvider"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, readdir: vi.fn(actual.readdir) }
})

const { fixtureState, watchers, createWatcher } = vi.hoisted(() => {
	const watchers: Array<{
		pattern: { base: string; pattern: string }
		onDidChange: import("vitest").Mock
		onDidCreate: import("vitest").Mock
		onDidDelete: import("vitest").Mock
		dispose: import("vitest").Mock
	}> = []
	return {
		fixtureState: { home: "" },
		watchers,
		createWatcher: vi.fn((pattern: { base: string; pattern: string }) => {
			const watcher = {
				pattern,
				onDidChange: vi.fn(),
				onDidCreate: vi.fn(),
				onDidDelete: vi.fn(),
				dispose: vi.fn(),
			}
			watchers.push(watcher)
			return watcher
		}),
	}
})

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return { ...actual, homedir: () => fixtureState.home }
})
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: createWatcher,
		getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }),
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

describe("bounded nested portable skill discovery", () => {
	let directory: string
	let cwd: string
	let manager: SkillsManager
	let provider: {
		cwd: string
		postMessageToWebview: import("vitest").Mock
		customModesManager: { getCustomModes: import("vitest").Mock }
		contextProxy: { extensionUri: { fsPath: string }; getValue: import("vitest").Mock }
	}

	async function writeSkill(root: string, relativeDirectory: string, body = "Skill instructions"): Promise<string> {
		const skillDirectory = path.join(root, relativeDirectory)
		const name = path.basename(skillDirectory)
		await fs.mkdir(skillDirectory, { recursive: true })
		const skillPath = path.join(skillDirectory, "SKILL.md")
		await fs.writeFile(skillPath, `---\nname: ${name}\ndescription: Review ${name}\n---\n${body}\n`)
		return skillPath
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		watchers.length = 0
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-nested-skills-")))
		fixtureState.home = path.join(directory, "home")
		cwd = path.join(directory, "repository", "app")
		await fs.mkdir(fixtureState.home, { recursive: true })
		await fs.mkdir(cwd, { recursive: true })
		await fs.mkdir(path.join(directory, "repository", ".git"), { recursive: true })
		provider = {
			cwd,
			postMessageToWebview: vi.fn(async () => undefined),
			customModesManager: { getCustomModes: vi.fn(async () => []) },
			contextProxy: {
				extensionUri: { fsPath: path.join(directory, "extension") },
				getValue: vi.fn(() => []),
			},
		}
		manager = new SkillsManager(provider as unknown as AlphaProvider, cwd)
	})

	afterEach(async () => {
		await manager.dispose()
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir)
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		fixtureState.home = ""
		await actual.rm(directory, { recursive: true, force: true })
	})

	it("discovers nested global and project portable packs and resolves their exact paths", async () => {
		const globalPath = await writeSkill(
			path.join(fixtureState.home, ".agents", "skills"),
			"team/global-review",
			"Global instructions",
		)
		const projectPath = await writeSkill(
			path.join(cwd, ".agents", "skills"),
			"team/reviews/project-review",
			"Project instructions",
		)
		await manager.discoverSkills()

		expect(manager.getSkillsForMode("code")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "global-review", source: "global", path: globalPath }),
				expect.objectContaining({ name: "project-review", source: "project", path: projectPath }),
			]),
		)
		expect(await manager.getSkillContent("project-review", "code")).toMatchObject({
			path: projectPath,
			instructions: "Project instructions",
		})
		expect(await manager.getSkillContentByPath("global-review", globalPath)).toMatchObject({
			instructions: "Global instructions",
		})
	})

	it("skips hidden directories and limits recursion to six levels including SKILL.md", async () => {
		const root = path.join(cwd, ".agents", "skills")
		const visible = await writeSkill(root, "one/two/three/four/visible-review")
		await writeSkill(root, "one/two/three/four/five/too-deep")
		await writeSkill(root, ".hidden/team/hidden-review")
		await manager.discoverSkills()

		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "visible-review", path: visible }),
		])
	})

	it("follows visible directory aliases once and terminates a symlink cycle", async () => {
		const root = path.join(cwd, ".agents", "skills")
		const target = await writeSkill(root, "team/cycle-review")
		await fs.symlink(
			path.join(root, "team"),
			path.join(root, "team", "loop"),
			process.platform === "win32" ? "junction" : "dir",
		)
		const readDirectories = vi.mocked(fs.readdir)
		await manager.discoverSkills()

		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "cycle-review", path: target }),
		])
		expect(readDirectories.mock.calls.length).toBeLessThan(20)
	})

	it("makes same-name nested selection deterministic while retaining exact captured identities", async () => {
		const root = path.join(cwd, ".agents", "skills")
		const later = await writeSkill(root, "zeta/shared-review", "Zeta instructions")
		const earlier = await writeSkill(root, "alpha/shared-review", "Alpha instructions")
		await manager.discoverSkills()

		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "shared-review", path: later }),
		])
		expect(await manager.getSkillContentByPath("shared-review", earlier)).toMatchObject({
			instructions: "Alpha instructions",
		})
		expect(await manager.getSkillContentByPath("shared-review", later)).toMatchObject({
			instructions: "Zeta instructions",
		})
		expect(() => manager.findSkillByNameAndSource("shared-review", "project")).toThrow()
	})

	it("preserves an explicit-only nested project override instead of exposing a global fallback", async () => {
		await writeSkill(path.join(fixtureState.home, ".agents", "skills"), "team/shared-review", "Global instructions")
		const projectPath = await writeSkill(
			path.join(cwd, ".agents", "skills"),
			"team/shared-review",
			"Project instructions",
		)
		await fs.mkdir(path.join(path.dirname(projectPath), "agents"))
		await fs.writeFile(
			path.join(path.dirname(projectPath), "agents", "openai.yaml"),
			"policy:\n  allow_implicit_invocation: false\n",
		)
		await manager.discoverSkills()

		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({
				name: "shared-review",
				source: "project",
				path: projectPath,
				allowImplicitInvocation: false,
			}),
		])
		expect(manager.getImplicitSkillsForMode("code")).toEqual([])
		expect(await manager.getSkillContent("shared-review", "code")).toMatchObject({
			instructions: "Project instructions",
		})
	})

	it("uses the same configured no-parent boundary as project documents", async () => {
		await writeSkill(path.join(path.dirname(cwd), ".agents", "skills"), "team/ancestor-review")
		const localPath = await writeSkill(path.join(cwd, ".agents", "skills"), "team/local-review")
		await manager.dispose()
		manager = new SkillsManager(provider as unknown as AlphaProvider, cwd, {
			projectInstructionDiscovery: { projectRootMarkers: [] },
		})
		await manager.discoverSkills()

		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "local-review", path: localPath }),
		])
	})

	it("refreshes when a nested skill is created after watcher initialization and disposes watchers", async () => {
		vi.stubEnv("NODE_ENV", "production")
		await manager.initialize()
		expect(manager.getSkillsForMode("code")).toEqual([])
		const skillPath = await writeSkill(path.join(cwd, ".agents", "skills"), "late/team/late-review")
		const watcher = watchers.find(
			({ pattern }) => pattern.base === cwd && pattern.pattern === ".agents/{skills,skills-*}/**/SKILL.md",
		)
		expect(watcher).toBeDefined()
		await watcher!.onDidCreate.mock.calls[0][0]({ fsPath: skillPath })

		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ name: "late-review", path: skillPath }),
		])
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(expect.objectContaining({ type: "skills" }))
		await manager.dispose()
		for (const registered of watchers) expect(registered.dispose).toHaveBeenCalledOnce()
	})
})
