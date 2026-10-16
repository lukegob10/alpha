import * as path from "path"
import type { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { getSkillsCatalogSection, getSkillsSection } from "../../../core/prompts/sections/skills"

const { fsMock, mockHomedir, mockDirectoryExists, mockFileExists, mockProjectDirectories, mockWatchers, mockWatcher } =
	vi.hoisted(() => {
		const watchers: Array<{
			pattern: { base: string; pattern: string }
			onDidChange: import("vitest").Mock
			onDidCreate: import("vitest").Mock
			onDidDelete: import("vitest").Mock
			dispose: import("vitest").Mock
		}> = []
		return {
			fsMock: {
				stat: vi.fn(),
				readFile: vi.fn(),
				readdir: vi.fn(),
				realpath: vi.fn(),
				open: vi.fn(),
				mkdir: vi.fn(),
				writeFile: vi.fn(),
			},
			mockHomedir: vi.fn(),
			mockDirectoryExists: vi.fn(),
			mockFileExists: vi.fn(),
			mockProjectDirectories: vi.fn(),
			mockWatchers: watchers,
			mockWatcher: vi.fn((pattern: { base: string; pattern: string }) => {
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

vi.mock("fs/promises", () => ({ ...fsMock, default: fsMock }))
vi.mock("os", () => ({ homedir: mockHomedir }))
vi.mock("vscode", () => ({
	workspace: { createFileSystemWatcher: mockWatcher },
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
vi.mock("../../config-paths", () => ({
	getGlobalAgentsDirectory: () => path.join(mockHomedir(), ".agents"),
	getProjectAgentsDirectoryForCwd: (cwd: string) => path.join(cwd, ".agents"),
	getProjectInstructionDirectoriesForCwd: mockProjectDirectories,
	directoryExists: mockDirectoryExists,
	fileExists: mockFileExists,
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { SkillsManager } from "../SkillsManager"

const HOME_DIR = process.platform === "win32" ? "C:\\Users\\policy-test" : "/home/policy-test"
const PROJECT_DIR = process.platform === "win32" ? "C:\\policy-test\\project" : "/policy-test/project"
const EXTENSION_DIR = path.join(PROJECT_DIR, "installed-extension")
const globalSkills = path.join(HOME_DIR, ".agents", "skills")
const projectSkills = path.join(PROJECT_DIR, ".agents", "skills")
const builtinSkills = path.join(EXTENSION_DIR, "assets", "skills")
const policyText = (value: boolean) => `policy:\n  allow_implicit_invocation: ${value}\n`

describe("portable skill invocation policy", () => {
	let files: Map<string, string>
	let manager: SkillsManager
	let disabledBuiltinSkills: string[]
	let provider: {
		cwd: string
		postMessageToWebview: import("vitest").Mock
		customModesManager: { getCustomModes: import("vitest").Mock }
		contextProxy: {
			extensionUri: { fsPath: string }
			getValue: import("vitest").Mock
		}
	}
	let handles: Array<{
		stat: import("vitest").Mock
		read: import("vitest").Mock
		close: import("vitest").Mock
	}>

	function addSkill(directory: string, name = "portable-review", metadata?: string, modeSlugs?: string[]) {
		const skillDir = path.join(directory, name)
		files.set(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Review from ${directory}\n${modeSlugs ? `modeSlugs: [${modeSlugs.join(", ")}]\n` : ""}---\nInstructions from ${directory}`,
		)
		if (metadata !== undefined) files.set(path.join(skillDir, "agents", "openai.yaml"), metadata)
		return skillDir
	}

	const policyPath = (skillDir: string) => path.join(skillDir, "agents", "openai.yaml")

	beforeEach(() => {
		vi.clearAllMocks()
		files = new Map()
		handles = []
		disabledBuiltinSkills = []
		mockWatchers.length = 0
		mockHomedir.mockReturnValue(HOME_DIR)
		mockProjectDirectories.mockImplementation(async (cwd: string) => ({ root: PROJECT_DIR, directories: [cwd] }))
		const hasDirectory = (directory: string) =>
			[...files.keys()].some((file) => file.startsWith(directory + path.sep))
		mockDirectoryExists.mockImplementation(async (directory: string) => hasDirectory(directory))
		mockFileExists.mockImplementation(async (file: string) => files.has(file))
		fsMock.realpath.mockImplementation(async (directory: string) => directory)
		fsMock.stat.mockImplementation(async (candidate: string) => ({
			isDirectory: () => hasDirectory(candidate),
			isFile: () => files.has(candidate),
		}))
		fsMock.readdir.mockImplementation(async (directory: string) => [
			...new Set(
				[...files.keys()]
					.filter((file) => file.startsWith(directory + path.sep))
					.map((file) => path.relative(directory, file).split(path.sep)[0]),
			),
		])
		fsMock.readFile.mockImplementation(async (file: string) => {
			const text = files.get(file)
			if (text === undefined) throw Object.assign(new Error("Missing file"), { code: "ENOENT" })
			return text
		})
		fsMock.open.mockImplementation(async (file: string) => {
			const text = files.get(file)
			if (text === undefined) throw Object.assign(new Error("Missing metadata"), { code: "ENOENT" })
			const bytes = Buffer.from(text, "utf8")
			const handle = {
				stat: vi.fn(async () => ({ isFile: () => true, size: bytes.byteLength })),
				read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
					bytesRead: bytes.copy(buffer, offset, position, position + length),
					buffer,
				})),
				close: vi.fn(async () => undefined),
			}
			handles.push(handle)
			return handle
		})
		provider = {
			cwd: PROJECT_DIR,
			postMessageToWebview: vi.fn(async () => undefined),
			customModesManager: { getCustomModes: vi.fn(async () => []) },
			contextProxy: {
				extensionUri: { fsPath: EXTENSION_DIR },
				getValue: vi.fn((key: string) => (key === "disabledBuiltinSkills" ? disabledBuiltinSkills : undefined)),
			},
		}
		manager = new SkillsManager(provider as unknown as AlphaProvider)
	})

	afterEach(async () => {
		await manager.dispose()
		vi.unstubAllEnvs()
	})

	it.each([
		["false", policyText(false), false],
		["true", policyText(true), true],
		["missing metadata", undefined, undefined],
		["empty metadata", "", undefined],
		["missing policy", "interface:\n  display_name: Review\n", undefined],
		["missing flag", "policy: {}\n", undefined],
		["null policy", "policy: null\n", undefined],
		["null flag", "policy:\n  allow_implicit_invocation: null\n", undefined],
		["quoted boolean", 'policy:\n  allow_implicit_invocation: "false"\n', undefined],
		["numeric flag", "policy:\n  allow_implicit_invocation: 0\n", undefined],
		["sequence policy", "policy: [false]\n", undefined],
		["scalar metadata", "false\n", undefined],
		["invalid YAML", "policy: [\n", undefined],
		["multiple YAML documents", `${policyText(false)}---\n${policyText(true)}`, undefined],
		[
			"duplicate flag",
			"policy:\n  allow_implicit_invocation: false\n  allow_implicit_invocation: true\n",
			undefined,
		],
		["custom YAML tag", "policy:\n  allow_implicit_invocation: !custom false\n", undefined],
		["custom policy tag", "policy: !custom {allow_implicit_invocation: false}\n", undefined],
		["custom root tag", "!custom\npolicy:\n  allow_implicit_invocation: false\n", undefined],
		[
			"unrelated metadata and invocation claims",
			`interface:\n  display_name: Review\ndependencies:\n  tools:\n    - type: mcp\n      value: uninstalled-server\n      command: must-never-run\npolicy:\n  allow_implicit_invocation: false\n  explicit_user_invocation: true\n`,
			false,
		],
	] as const)("loads %s optional metadata without losing explicit resolution", async (_label, metadata, expected) => {
		const skillDir = addSkill(projectSkills, "portable-review", metadata)
		await manager.discoverSkills()

		const skill = manager.getSkillsForMode("code")[0]
		expect(skill).toMatchObject({ name: "portable-review", path: path.join(skillDir, "SKILL.md") })
		expect(skill.allowImplicitInvocation).toBe(expected)
		if (expected === undefined) expect(skill).not.toHaveProperty("allowImplicitInvocation")
		expect(await manager.getSkillContent("portable-review", "code")).toMatchObject({
			instructions: `Instructions from ${projectSkills}`,
		})
		const catalog = await getSkillsSection(manager, "code")
		expect(catalog.includes("<name>portable-review</name>")).toBe(expected !== false)
		for (const handle of handles) expect(handle.close).toHaveBeenCalledOnce()
	})

	it("retains explicit-only skills in Settings selectors and exact captured-path resolution", async () => {
		const skillDir = addSkill(projectSkills, "portable-review", policyText(false))
		await manager.discoverSkills()
		const capturedPath = path.join(skillDir, "SKILL.md")

		expect(manager.getSkillsMetadata()).toEqual([
			expect.objectContaining({ name: "portable-review", allowImplicitInvocation: false }),
		])
		expect(manager.findSkillByNameAndSource("portable-review", "project", { path: capturedPath })).toMatchObject({
			allowImplicitInvocation: false,
		})
		expect(await manager.getSkillContentByPath("portable-review", capturedPath)).toMatchObject({
			allowImplicitInvocation: false,
			instructions: `Instructions from ${projectSkills}`,
		})
		expect(await manager.getSkillContent("portable-review")).toMatchObject({ allowImplicitInvocation: false })
	})

	it("filters after ancestor and nearest-directory override resolution without exposing a fallback", async () => {
		const ancestor = path.join(PROJECT_DIR, "packages")
		const nested = path.join(ancestor, "client")
		mockProjectDirectories.mockResolvedValue({ root: PROJECT_DIR, directories: [PROJECT_DIR, ancestor, nested] })
		await manager.dispose()
		manager = new SkillsManager(provider as unknown as AlphaProvider, nested)
		addSkill(globalSkills, "portable-review", policyText(true))
		addSkill(projectSkills, "portable-review", policyText(true))
		addSkill(path.join(ancestor, ".agents", "skills"), "portable-review", policyText(true))
		const nearest = addSkill(path.join(nested, ".agents", "skills"), "portable-review", policyText(false))
		await manager.discoverSkills()

		expect(manager.getSkillsForMode("code")).toEqual([
			expect.objectContaining({ path: path.join(nearest, "SKILL.md"), allowImplicitInvocation: false }),
		])
		expect(await getSkillsSection(manager, "code")).toBe("")
		expect((await manager.getSkillContent("portable-review", "code"))?.path).toBe(path.join(nearest, "SKILL.md"))
	})

	it("honors an explicit-only Alpha override and a mode-specific override before filtering", async () => {
		addSkill(projectSkills, "portable-review", policyText(true))
		const alpha = addSkill(path.join(PROJECT_DIR, ".alpha", "skills"), "portable-review", policyText(false))
		addSkill(projectSkills, "mode-review", policyText(true))
		const specific = addSkill(path.join(PROJECT_DIR, ".agents", "skills-code"), "mode-review", policyText(false))
		await manager.discoverSkills()

		expect(await getSkillsSection(manager, "code")).toBe("")
		expect((await manager.getSkillContent("portable-review", "code"))?.path).toBe(path.join(alpha, "SKILL.md"))
		expect((await manager.getSkillContent("mode-review", "code"))?.path).toBe(path.join(specific, "SKILL.md"))
		expect(await getSkillsSection(manager, "architect")).toContain("<name>mode-review</name>")
	})

	it("preserves built-in skills and their disabled setting alongside explicit-only portable skills", async () => {
		addSkill(builtinSkills, "debug")
		addSkill(builtinSkills, "rich-documents")
		addSkill(projectSkills, "portable-review", policyText(false))
		await manager.discoverSkills()

		const catalog = await getSkillsSection(manager, "code")
		expect(catalog).toContain("<name>debug</name>")
		expect(catalog).toContain("<name>rich-documents</name>")
		expect(catalog).not.toContain("portable-review")
		expect(await manager.getSkillContent("debug", "code")).toMatchObject({ source: "builtin" })
		disabledBuiltinSkills = ["debug"]
		expect(await getSkillsSection(manager, "code")).not.toContain("<name>debug</name>")
		expect(await manager.getSkillContent("debug", "code")).toBeNull()
		expect(fsMock.mkdir).not.toHaveBeenCalled()
		expect(fsMock.writeFile).not.toHaveBeenCalled()
	})

	it("keeps an explicit-only portable override from revealing a built-in skill with the same name", async () => {
		addSkill(builtinSkills, "debug")
		const override = addSkill(projectSkills, "debug", policyText(false))
		await manager.discoverSkills()
		expect(await getSkillsSection(manager, "code")).toBe("")
		expect(await manager.getSkillContent("debug", "code")).toMatchObject({ path: path.join(override, "SKILL.md") })
	})

	it("refreshes metadata create, edit, and delete while preserving previously captured catalogs", async () => {
		const skillDir = addSkill(projectSkills)
		await manager.discoverSkills()
		const original = structuredClone(manager.getSkillsForMode("code"))
		files.set(policyPath(skillDir), policyText(false))
		await manager.refreshSkills()
		const explicitOnly = structuredClone(manager.getSkillsForMode("code"))
		expect(await getSkillsSection(manager, "code")).toBe("")
		files.set(policyPath(skillDir), policyText(true))
		await manager.refreshSkills()
		expect(await getSkillsSection(manager, "code")).toContain("<name>portable-review</name>")
		files.delete(policyPath(skillDir))
		await manager.refreshSkills()
		expect(manager.getSkillsForMode("code")[0]).not.toHaveProperty("allowImplicitInvocation")
		expect(getSkillsCatalogSection(original, "code")).toContain("<name>portable-review</name>")
		expect(getSkillsCatalogSection(explicitOnly, "code")).toBe("")
	})

	it("rejects oversized metadata before reading and closes the optional metadata handle", async () => {
		addSkill(projectSkills, "portable-review", `${policyText(false)}padding: ${"x".repeat(128 * 1024)}\n`)
		await manager.discoverSkills()
		expect(await getSkillsSection(manager, "code")).toContain("<name>portable-review</name>")
		expect(handles).toHaveLength(1)
		expect(handles[0].read).not.toHaveBeenCalled()
		expect(handles[0].close).toHaveBeenCalledOnce()
	})

	it("ignores alias expansion without dropping the skill", async () => {
		const aliases = new Array(200).fill("*entry").join(", ")
		addSkill(projectSkills, "portable-review", `${policyText(false)}base: &entry [a, b]\naliases: [${aliases}]\n`)
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")[0]).not.toHaveProperty("allowImplicitInvocation")
		expect(await getSkillsSection(manager, "code")).toContain("<name>portable-review</name>")
		expect(handles[0].close).toHaveBeenCalledOnce()
	})

	it.each([
		["flow", `extra: ${"[".repeat(100)}0${"]".repeat(100)}\n`],
		["block", Array.from({ length: 100 }, (_, index) => `${"  ".repeat(index)}level:\n`).join("")],
	] as const)("ignores excessively nested %s metadata without dropping SKILL.md", async (_kind, nesting) => {
		addSkill(projectSkills, "portable-review", policyText(false) + nesting)
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")[0]).not.toHaveProperty("allowImplicitInvocation")
		expect(await getSkillsSection(manager, "code")).toContain("<name>portable-review</name>")
		expect(handles[0].close).toHaveBeenCalledOnce()
	})

	it("accepts literal scalar punctuation without treating it as YAML nesting", async () => {
		addSkill(projectSkills, "portable-review", `${policyText(false)}description: |\n  ${"[".repeat(1_000)}\n`)
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")[0].allowImplicitInvocation).toBe(false)
		expect(await getSkillsSection(manager, "code")).toBe("")
	})

	it("bounds the read when metadata grows after stat", async () => {
		addSkill(projectSkills)
		const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
			buffer.fill("x", offset, offset + length)
			return { bytesRead: length, buffer }
		})
		const close = vi.fn(async () => undefined)
		fsMock.open.mockResolvedValue({ stat: vi.fn(async () => ({ isFile: () => true, size: 1 })), read, close })
		await manager.discoverSkills()
		expect(manager.getSkillsForMode("code")[0]).not.toHaveProperty("allowImplicitInvocation")
		expect(await getSkillsSection(manager, "code")).toContain("<name>portable-review</name>")
		const totalReadCapacity = read.mock.calls.reduce((total, [, , length]) => total + length, 0)
		expect(totalReadCapacity).toBeLessThanOrEqual(64 * 1024 + 1)
		expect(close).toHaveBeenCalledOnce()
	})

	it.each(["stat", "read"] as const)("retains the default and closes metadata when %s fails", async (operation) => {
		addSkill(projectSkills, "portable-review", policyText(false))
		const stat = vi.fn(async () => ({ isFile: () => true, size: 42 }))
		const read = vi.fn()
		const close = vi.fn(async () => undefined)
		if (operation === "stat") stat.mockRejectedValue(new Error("Metadata unavailable"))
		else read.mockRejectedValue(new Error("Metadata unavailable"))
		fsMock.open.mockResolvedValue({ stat, read, close })
		await manager.discoverSkills()
		expect(await getSkillsSection(manager, "code")).toContain("<name>portable-review</name>")
		expect(close).toHaveBeenCalledOnce()
	})

	it.each(["directory", "close failure"] as const)(
		"keeps SKILL.md available when optional metadata resolves to %s",
		async (kind) => {
			addSkill(projectSkills, "portable-review", policyText(false))
			const bytes = Buffer.from(policyText(false), "utf8")
			const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
				bytesRead: bytes.copy(buffer, offset, position, position + length),
				buffer,
			}))
			const close = vi.fn(async () => undefined)
			if (kind === "close failure") close.mockRejectedValue(new Error("Metadata close failed"))
			fsMock.open.mockResolvedValue({
				stat: vi.fn(async () => ({ isFile: () => kind !== "directory", size: bytes.byteLength })),
				read,
				close,
			})
			await manager.discoverSkills()
			expect(manager.getSkillsForMode("code")[0]).not.toHaveProperty("allowImplicitInvocation")
			expect(await getSkillsSection(manager, "code")).toContain("<name>portable-review</name>")
			expect(close).toHaveBeenCalledOnce()
			if (kind === "directory") expect(read).not.toHaveBeenCalled()
		},
	)

	it("watches metadata files and agents directories for create, change, delete, and disposal", async () => {
		vi.stubEnv("NODE_ENV", "development")
		const ancestor = path.join(PROJECT_DIR, "packages")
		mockProjectDirectories.mockResolvedValue({ root: PROJECT_DIR, directories: [PROJECT_DIR, ancestor] })
		const skillDir = addSkill(path.join(ancestor, ".agents", "skills"))
		await manager.initialize()
		const metadataWatcher = mockWatchers.find(
			({ pattern }) => pattern.base === ancestor && pattern.pattern.endsWith("/agents/openai.yaml"),
		)
		const agentsWatcher = mockWatchers.find(
			({ pattern }) => pattern.base === ancestor && pattern.pattern.endsWith("/agents"),
		)
		expect(metadataWatcher).toBeDefined()
		expect(agentsWatcher).toBeDefined()
		if (!metadataWatcher || !agentsWatcher) throw new Error("Portable metadata watchers were not registered")

		files.set(policyPath(skillDir), policyText(false))
		await agentsWatcher.onDidCreate.mock.calls[0][0]({ fsPath: path.dirname(policyPath(skillDir)) })
		expect(await getSkillsSection(manager, "code")).toBe("")
		files.set(policyPath(skillDir), policyText(true))
		await metadataWatcher.onDidChange.mock.calls[0][0]({ fsPath: policyPath(skillDir) })
		expect(await getSkillsSection(manager, "code")).toContain("<name>portable-review</name>")
		files.delete(policyPath(skillDir))
		await metadataWatcher.onDidDelete.mock.calls[0][0]({ fsPath: policyPath(skillDir) })
		expect(manager.getSkillsForMode("code")[0]).not.toHaveProperty("allowImplicitInvocation")
		expect(provider.postMessageToWebview).toHaveBeenCalledTimes(3)
		await manager.dispose()
		for (const watcher of mockWatchers) expect(watcher.dispose).toHaveBeenCalledOnce()
		await metadataWatcher.onDidCreate.mock.calls[0][0]({ fsPath: policyPath(skillDir) })
		expect(provider.postMessageToWebview).toHaveBeenCalledTimes(3)
	})
})
