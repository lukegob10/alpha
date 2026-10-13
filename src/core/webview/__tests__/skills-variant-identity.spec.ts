import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import matter from "gray-matter"
import * as vscode from "vscode"
import type { WebviewMessage } from "@alpha-code/types"
import type { AlphaProvider } from "../AlphaProvider"
import { SkillsManager } from "../../../services/skills/SkillsManager"
import { handleDeleteSkill, handleOpenSkillFile, handleUpdateSkillModes } from "../skillsMessageHandler"
import { openFile } from "../../../integrations/misc/open-file"

const fixture = vi.hoisted(() => ({ home: "", projectDirectories: [] as string[] }))
vi.mock("vscode", async (importOriginal) => {
	const original = await importOriginal<typeof import("vscode")>()
	return {
		...original,
		Uri: { ...original.Uri, from: vi.fn((properties) => properties) },
		workspace: { ...original.workspace, openTextDocument: vi.fn().mockResolvedValue({}) },
		window: { ...original.window, showErrorMessage: vi.fn(), showTextDocument: vi.fn() },
	}
})
vi.mock("os", async (importOriginal) => ({
	...(await importOriginal<typeof import("os")>()),
	homedir: () => fixture.home,
}))
vi.mock("../../../services/config-paths", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../services/config-paths")>()),
	getGlobalAgentsDirectory: () => path.join(fixture.home, ".agents"),
	getProjectInstructionDirectoriesForCwd: async (cwd: string) => ({
		root: fixture.projectDirectories[0] ?? cwd,
		directories: fixture.projectDirectories.length ? fixture.projectDirectories : [cwd],
	}),
}))
vi.mock("../../../integrations/misc/open-file", () => ({ openFile: vi.fn() }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

describe("skill settings variant identity", () => {
	let tmpDir: string
	let provider: AlphaProvider
	let manager: SkillsManager
	let genericPath: string
	let codePath: string

	async function writeSkill(target: string, modeSlugs?: string[]) {
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(
			target,
			matter.stringify(`Instructions from ${target}`, {
				name: path.basename(path.dirname(target)),
				description: `Skill from ${target}`,
				...(modeSlugs ? { modeSlugs } : {}),
			}),
		)
	}

	const operations = [
		["openSkillFile", handleOpenSkillFile],
		["updateSkillModes", handleUpdateSkillModes],
		["deleteSkill", handleDeleteSkill],
	] as const

	beforeEach(async () => {
		tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-skill-identity-")))
		fixture.home = path.join(tmpDir, "home")
		fixture.projectDirectories = []
		const workspace = path.join(tmpDir, "workspace")
		provider = {
			cwd: workspace,
			log: vi.fn(),
			customModesManager: { getCustomModes: vi.fn(async () => []) },
			postMessageToWebview: vi.fn(async () => undefined),
			getSkillsManager: () => manager,
			contextProxy: {
				extensionUri: { fsPath: path.join(tmpDir, "extension") },
				getValue: vi.fn(),
			},
		} as unknown as AlphaProvider
		genericPath = path.join(workspace, ".agents", "skills", "audit-review", "SKILL.md")
		codePath = path.join(workspace, ".agents", "skills-code", "audit-review", "SKILL.md")
		for (const target of [genericPath, codePath]) await writeSkill(target)
		manager = new SkillsManager(provider, workspace, { notifyWebview: false })
		await manager.discoverSkills()
		expect(manager.getSkillsMetadata().filter((skill) => skill.name === "audit-review")).toHaveLength(2)
	})

	afterEach(async () => {
		await manager.dispose()
		vi.clearAllMocks()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("opens the Code variant selected in settings instead of its generic sibling", async () => {
		await handleOpenSkillFile(provider, {
			type: "openSkillFile",
			skillName: "audit-review",
			source: "project",
			skillModeSlugs: ["code"],
		})

		expect(openFile).toHaveBeenCalledWith(codePath)
	})

	it("opens the selected path even after its mode bindings change", async () => {
		await writeSkill(codePath, ["architect"])
		await manager.discoverSkills()
		await handleOpenSkillFile(provider, {
			type: "openSkillFile",
			skillName: "audit-review",
			source: "project",
			skillPath: codePath,
			skillModeSlugs: ["code"],
		})
		expect(openFile).toHaveBeenCalledWith(codePath)
	})

	it("updates only the selected Code path and preserves its generic sibling and instructions", async () => {
		const genericBefore = await fs.readFile(genericPath, "utf8")
		const bodyBefore = matter(await fs.readFile(codePath, "utf8")).content
		await handleUpdateSkillModes(provider, {
			type: "updateSkillModes",
			skillName: "audit-review",
			source: "project",
			skillPath: codePath,
			newSkillModeSlugs: ["architect"],
		})
		expect(await fs.readFile(genericPath, "utf8")).toBe(genericBefore)
		const updated = matter(await fs.readFile(codePath, "utf8"))
		expect(updated.data.modeSlugs).toEqual(["architect"])
		expect(updated.content).toBe(bodyBefore)
		expect(manager.getSkillsMetadata()).toContainEqual(
			expect.objectContaining({ path: codePath, modeSlugs: ["architect"] }),
		)
	})

	it("deletes only the selected Code path and preserves its generic sibling", async () => {
		const genericBefore = await fs.readFile(genericPath, "utf8")
		await handleDeleteSkill(provider, {
			type: "deleteSkill",
			skillName: "audit-review",
			source: "project",
			skillPath: codePath,
		})
		expect(await fs.readFile(genericPath, "utf8")).toBe(genericBefore)
		await expect(fs.stat(path.dirname(codePath))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("never rewrites a sibling when a mode-change request lacks the selected variant identity", async () => {
		const genericBefore = await fs.readFile(genericPath, "utf8")
		const codeBefore = await fs.readFile(codePath, "utf8")
		// Older webviews sent no current mode or path with Save. Such requests
		// cannot identify a variant and must be rejected before any mutation.
		await handleUpdateSkillModes(provider, {
			type: "updateSkillModes",
			skillName: "audit-review",
			source: "project",
			newSkillModeSlugs: ["architect"],
		})

		expect(await fs.readFile(genericPath, "utf8")).toBe(genericBefore)
		expect(await fs.readFile(codePath, "utf8")).toBe(codeBefore)
	})

	it.each(operations)(
		"rejects an ambiguous legacy %s request without opening or mutating either path",
		async (type, handler) => {
			const genericBefore = await fs.readFile(genericPath, "utf8")
			const codeBefore = await fs.readFile(codePath, "utf8")
			await handler(provider, {
				type,
				skillName: "audit-review",
				source: "project",
				newSkillModeSlugs: ["architect"],
			})
			expect(openFile).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).toHaveBeenCalled()
			expect(await fs.readFile(genericPath, "utf8")).toBe(genericBefore)
			expect(await fs.readFile(codePath, "utf8")).toBe(codeBefore)
		},
	)

	it.each(operations)("preserves an unambiguous legacy %s request", async (type, handler) => {
		const uniquePath = path.join(provider.cwd!, ".agents", "skills-code", "unique-review", "SKILL.md")
		await writeSkill(uniquePath)
		await manager.discoverSkills()
		await handler(provider, {
			type,
			skillName: "unique-review",
			source: "project",
			newSkillModeSlugs: ["architect"],
		})
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		if (type === "openSkillFile") expect(openFile).toHaveBeenCalledWith(uniquePath)
		else if (type === "deleteSkill") await expect(fs.stat(uniquePath)).rejects.toMatchObject({ code: "ENOENT" })
		else expect(matter(await fs.readFile(uniquePath, "utf8")).data.modeSlugs).toEqual(["architect"])
	})

	describe.each(operations)("%s target validation", (type, handler) => {
		it.each(["unlisted", "relative", "outside", "wrong name", "wrong source", "empty", "null", "malformed"])(
			"rejects a %s identity without opening or mutating files",
			async (invalid) => {
				const outsidePath = path.join(tmpDir, "outside", "audit-review", "SKILL.md")
				await writeSkill(outsidePath)
				const before = await Promise.all(
					[genericPath, codePath, outsidePath].map((target) => fs.readFile(target, "utf8")),
				)
				const message: WebviewMessage = {
					type,
					skillName: "audit-review",
					source: "project",
					skillPath: codePath,
					newSkillModeSlugs: ["architect"],
				}
				if (invalid === "unlisted")
					message.skillPath = path.join(provider.cwd!, ".agents", "skills", "missing", "SKILL.md")
				else if (invalid === "relative") message.skillPath = path.relative(provider.cwd!, codePath)
				else if (invalid === "outside") message.skillPath = outsidePath
				else if (invalid === "wrong name") message.skillName = "other-skill"
				else if (invalid === "wrong source") message.source = "global"
				else if (invalid === "empty") message.skillPath = ""
				else if (invalid === "null") Object.assign(message, { skillPath: null })
				else Object.assign(message, { skillPath: { path: codePath } })
				await handler(provider, message)
				expect(openFile).not.toHaveBeenCalled()
				expect(vscode.window.showErrorMessage).toHaveBeenCalled()
				expect(
					await Promise.all(
						[genericPath, codePath, outsidePath].map((target) => fs.readFile(target, "utf8")),
					),
				).toEqual(before)
			},
		)

		it.each(["primary mode", "mode array", "any mode"])(
			"preserves an unambiguous legacy %s selector",
			async (selector) => {
				await writeSkill(codePath, ["code", "architect"])
				await manager.discoverSkills()
				const selectedPath = selector === "any mode" ? genericPath : codePath
				const siblingPath = selectedPath === codePath ? genericPath : codePath
				const siblingBefore = await fs.readFile(siblingPath, "utf8")
				const message: WebviewMessage = {
					type,
					skillName: "audit-review",
					source: "project",
					newSkillModeSlugs: ["architect"],
				}
				if (selector === "primary mode") message.skillMode = "code"
				else message.skillModeSlugs = selector === "any mode" ? [] : ["architect", "code"]
				await handler(provider, message)
				expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
				expect(await fs.readFile(siblingPath, "utf8")).toBe(siblingBefore)
				if (type === "openSkillFile") expect(openFile).toHaveBeenCalledWith(selectedPath)
				else if (type === "deleteSkill")
					await expect(fs.stat(selectedPath)).rejects.toMatchObject({ code: "ENOENT" })
				else expect(matter(await fs.readFile(selectedPath, "utf8")).data.modeSlugs).toEqual(["architect"])
			},
		)

		it("retains bundled read-only protection for an exact discovered alias", async () => {
			const builtinPath = path.join(tmpDir, "extension", "assets", "skills", "readonly-review", "SKILL.md")
			const aliasDir = path.join(provider.cwd!, ".agents", "skills", "readonly-review")
			const aliasPath = path.join(aliasDir, "SKILL.md")
			await writeSkill(builtinPath)
			await fs.symlink(path.dirname(builtinPath), aliasDir, "junction")
			await manager.discoverSkills()
			const before = await fs.readFile(builtinPath, "utf8")
			for (const [source, skillPath] of [
				["builtin", builtinPath],
				["project", aliasPath],
			] as const) {
				await handler(provider, {
					type,
					skillName: "readonly-review",
					source,
					skillPath,
					newSkillModeSlugs: ["architect"],
				})
			}
			expect(openFile).not.toHaveBeenCalled()
			if (type !== "openSkillFile") expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2)
			else {
				expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1)
				expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
					scheme: "alpha-builtin-skill",
					path: "/readonly-review/SKILL.md",
				})
				expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1)
			}
			expect(await fs.readFile(builtinPath, "utf8")).toBe(before)
			expect(await fs.readFile(aliasPath, "utf8")).toBe(before)
		})

		it("rejects the selected path after it leaves the discovery catalog", async () => {
			const before = await fs.readFile(genericPath, "utf8")
			await fs.rm(path.dirname(codePath), { recursive: true, force: true })
			await manager.discoverSkills()
			await handler(provider, {
				type,
				skillName: "audit-review",
				source: "project",
				skillPath: codePath,
				newSkillModeSlugs: ["architect"],
			})
			expect(openFile).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).toHaveBeenCalled()
			expect(await fs.readFile(genericPath, "utf8")).toBe(before)
		})

		it.each(["same-mode directory", "nested repository"])(
			"uses exact paths and rejects ambiguous legacy identities across %s overrides",
			async (variant) => {
				const overrideRoot =
					variant === "nested repository" ? path.join(provider.cwd!, "packages", "app") : provider.cwd!
				const overridePath = path.join(
					overrideRoot,
					variant === "same-mode directory" ? ".alpha" : ".agents",
					"skills-code",
					"audit-review",
					"SKILL.md",
				)
				if (variant === "nested repository") {
					fixture.projectDirectories = [provider.cwd!, overrideRoot]
					await manager.dispose()
					manager = new SkillsManager(provider, overrideRoot, { notifyWebview: false })
				}
				await writeSkill(overridePath)
				await manager.discoverSkills()
				expect(manager.getSkill("audit-review", "project", "code")?.path).toBe(overridePath)
				const before = await Promise.all(
					[genericPath, codePath, overridePath].map((target) => fs.readFile(target, "utf8")),
				)
				await handler(provider, {
					type,
					skillName: "audit-review",
					source: "project",
					skillModeSlugs: ["code"],
					newSkillModeSlugs: ["architect"],
				})
				expect(openFile).not.toHaveBeenCalled()
				expect(vscode.window.showErrorMessage).toHaveBeenCalled()
				expect(
					await Promise.all(
						[genericPath, codePath, overridePath].map((target) => fs.readFile(target, "utf8")),
					),
				).toEqual(before)
				vi.clearAllMocks()
				await handler(provider, {
					type,
					skillName: "audit-review",
					source: "project",
					skillPath: codePath,
					newSkillModeSlugs: ["architect"],
				})
				expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
				expect(await fs.readFile(genericPath, "utf8")).toBe(before[0])
				expect(await fs.readFile(overridePath, "utf8")).toBe(before[2])
				if (type === "openSkillFile") expect(openFile).toHaveBeenCalledWith(codePath)
				else if (type === "deleteSkill")
					await expect(fs.stat(codePath)).rejects.toMatchObject({ code: "ENOENT" })
				else expect(matter(await fs.readFile(codePath, "utf8")).data.modeSlugs).toEqual(["architect"])
			},
		)
	})

	it.each([{ newModeSlugs: undefined }, { newModeSlugs: [] as string[] }])(
		"keeps Any mode across rediscovery and reload for a directory skill saved with $newModeSlugs",
		async ({ newModeSlugs }) => {
			const skillPath = path.join(provider.cwd!, ".agents", "skills-code", "audit-any-mode", "SKILL.md")
			await writeSkill(skillPath)
			const before = matter(await fs.readFile(skillPath, "utf8"))
			await fs.writeFile(skillPath, matter.stringify(before.content, { ...before.data, mode: "code" }))
			await manager.discoverSkills()
			expect(manager.getSkillsForMode("architect").some((skill) => skill.name === "audit-any-mode")).toBe(false)

			await handleUpdateSkillModes(provider, {
				type: "updateSkillModes",
				skillName: "audit-any-mode",
				source: "project",
				newSkillModeSlugs: newModeSlugs,
			})

			expect(manager.getSkillsForMode("architect").some((skill) => skill.name === "audit-any-mode")).toBe(true)
			expect(manager.getSkillsForMode("code").some((skill) => skill.name === "audit-any-mode")).toBe(true)
			expect(matter(await fs.readFile(skillPath, "utf8")).data.modeSlugs).toEqual([])
			expect(matter(await fs.readFile(skillPath, "utf8")).data.mode).toBeUndefined()
			await manager.discoverSkills()
			expect(manager.getSkillsForMode("architect").some((skill) => skill.path === skillPath)).toBe(true)
			await manager.dispose()
			manager = new SkillsManager(provider, provider.cwd, { notifyWebview: false })
			await manager.initialize()
			for (const mode of ["code", "architect"]) {
				expect(manager.getSkillsForMode(mode)).toContainEqual(
					expect.objectContaining({ path: skillPath, modeSlugs: undefined }),
				)
			}
		},
	)
})
