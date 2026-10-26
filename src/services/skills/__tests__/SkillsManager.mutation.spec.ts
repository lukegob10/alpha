import * as path from "path"
import * as os from "os"
import matter from "gray-matter"
import * as vscode from "vscode"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AlphaProvider } from "../../../core/webview/AlphaProvider"

const { host } = vi.hoisted(() => ({
	host: {
		home: "",
		documents: new Map<string, TestDocument>(),
		readFile: vi.fn(),
		applyEdit: vi.fn(),
		openTextDocument: vi.fn(),
		saveConflictResolution: "askUser",
		beforeApply: undefined as (() => Promise<void>) | undefined,
		beforeSave: undefined as (() => Promise<void>) | undefined,
	},
}))

type TestDocument = {
	uri: { fsPath: string; scheme: string }
	version: number
	isDirty: boolean
	isClosed: boolean
	eol: number
	languageId: string
	text: string
	diskText: string
	bom: string
	getText: () => string
	positionAt: (offset: number) => { offset: number }
	save: ReturnType<typeof vi.fn>
}

type TestWorkspaceEdit = {
	replacement?: {
		uri: { fsPath: string }
		range: { start: { offset: number }; end: { offset: number } }
		text: string
	}
}

vi.mock("fs/promises", async (original) => ({
	...(await original<typeof import("fs/promises")>()),
	readFile: host.readFile,
}))
vi.mock("os", async (original) => ({
	...(await original<typeof import("os")>()),
	homedir: () => host.home,
}))
vi.mock("vscode", () => ({
	workspace: {
		openTextDocument: host.openTextDocument,
		applyEdit: host.applyEdit,
		get textDocuments() {
			return [...host.documents.values()]
		},
		getConfiguration: () => ({ get: (_key: string, fallback: unknown) => host.saveConflictResolution ?? fallback }),
	},
	Uri: { file: (fsPath: string) => ({ fsPath, scheme: "file" }) },
	Range: class {
		constructor(
			readonly start: { offset: number },
			readonly end: { offset: number },
		) {}
	},
	WorkspaceEdit: class {
		replacement?: TestWorkspaceEdit["replacement"]
		replace(uri: { fsPath: string }, range: NonNullable<TestWorkspaceEdit["replacement"]>["range"], text: string) {
			this.replacement = { uri, range, text }
		}
	},
	EndOfLine: { LF: 1, CRLF: 2 },
}))
vi.mock("ai-sdk-provider-poe/code", () => ({
	POE_DEFAULT_BASE_URL: "https://api.poe.com/v1",
	poeDefaultModelId: "poe-default-model",
	getPoeDefaultModelInfo: vi.fn(() => ({})),
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { SkillsManager } from "../SkillsManager"

const disk = await vi.importActual<typeof import("fs/promises")>("fs/promises")
const initialText =
	"---\nname: test-skill\ndescription: Keep user instructions\nmode: code\n---\nOriginal instructions\n"
const externalText = initialText.replace("Original instructions", "User's separately saved instructions")

describe("SkillsManager versioned file mutations", () => {
	let root: string
	let skillPath: string
	let manager: SkillsManager

	function changeDocument(document: TestDocument, text: string) {
		document.text = text
		document.version++
		document.isDirty = true
	}

	async function openDocument(candidate = skillPath): Promise<TestDocument> {
		const existing = host.documents.get(candidate)
		if (existing) return existing
		const diskText = await disk.readFile(candidate, "utf-8")
		const bom = diskText.startsWith("\uFEFF") ? "\uFEFF" : ""
		const text = diskText.slice(bom.length)
		const document: TestDocument = {
			uri: { fsPath: candidate, scheme: "file" },
			version: 1,
			isDirty: false,
			isClosed: false,
			eol: text.includes("\r\n") ? 2 : 1,
			languageId: "markdown",
			text,
			diskText,
			bom,
			getText: () => document.text,
			positionAt: (offset) => ({ offset }),
			save: vi.fn(async () => {
				await host.beforeSave?.()
				// Model the host's modified-since guard using actual on-disk bytes.
				if ((await disk.readFile(candidate, "utf-8")) !== document.diskText) return false
				await disk.writeFile(candidate, document.bom + document.text, "utf-8")
				document.diskText = document.bom + document.text
				document.isDirty = false
				return true
			}),
		}
		host.documents.set(candidate, document)
		return document
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		host.documents.clear()
		host.beforeApply = undefined
		host.beforeSave = undefined
		host.saveConflictResolution = "askUser"
		host.readFile.mockImplementation(disk.readFile)
		host.openTextDocument.mockImplementation((uri: { fsPath: string }) => openDocument(uri.fsPath))
		host.applyEdit.mockImplementation(async (edit: TestWorkspaceEdit) => {
			const replacement = edit.replacement!
			const document = host.documents.get(replacement.uri.fsPath)!
			// VS Code captures the version when applyEdit is called and validates it in the host.
			const version = document.version
			await host.beforeApply?.()
			if (version !== document.version) return false
			changeDocument(
				document,
				document.text.slice(0, replacement.range.start.offset) +
					replacement.text.replace(/\r?\n/g, document.eol === 2 ? "\r\n" : "\n") +
					document.text.slice(replacement.range.end.offset),
			)
			return true
		})
		root = await disk.realpath(await disk.mkdtemp(path.join(os.tmpdir(), "alpha-skills-mutation-")))
		host.home = path.join(root, "home")
		const cwd = path.join(root, "workspace")
		skillPath = path.join(cwd, ".agents", "skills", "test-skill", "SKILL.md")
		await disk.mkdir(path.dirname(skillPath), { recursive: true })
		await disk.writeFile(skillPath, initialText)
		const provider = {
			cwd,
			customModesManager: { getCustomModes: vi.fn(async () => []) },
			contextProxy: { extensionUri: { fsPath: path.join(root, "extension") } },
		} as unknown as AlphaProvider
		manager = new SkillsManager(provider, cwd, { projectInstructionDiscovery: {} })
		await manager.discoverSkills()
	})

	afterEach(async () => {
		await manager.dispose()
		vi.restoreAllMocks()
		// The only removal target is the canonical mkdtemp directory owned by this test.
		await disk.rm(root, { recursive: true, force: true })
	})

	it("rejects an external instruction save injected after reading the original real file", async () => {
		let injected = false
		host.readFile.mockImplementation(async (candidate: string, encoding: BufferEncoding) => {
			const contents = await disk.readFile(candidate, encoding)
			if (candidate === skillPath && !injected) {
				injected = true
				await disk.writeFile(skillPath, externalText)
			}
			return contents
		})

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow()
		expect(injected).toBe(true)
		expect(await disk.readFile(skillPath, "utf-8")).toBe(externalText)
	})

	it("preserves unsaved editor instructions and does not save or edit their document", async () => {
		const document = await openDocument()
		changeDocument(document, externalText)

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow()
		expect(document.getText()).toBe(externalText)
		expect(document.isDirty).toBe(true)
		expect(document.save).not.toHaveBeenCalled()
		expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
		expect(await disk.readFile(skillPath, "utf-8")).toBe(initialText)
	})

	it("rejects a document version change while its disk snapshot is being checked", async () => {
		const document = await openDocument()
		host.readFile.mockImplementationOnce(async (candidate: string, encoding: BufferEncoding) => {
			const contents = await disk.readFile(candidate, encoding)
			changeDocument(document, externalText)
			return contents
		})

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow()
		expect(document.getText()).toBe(externalText)
		expect(document.save).not.toHaveBeenCalled()
		expect(await disk.readFile(skillPath, "utf-8")).toBe(initialText)
	})

	it("honors the host version rejection after an edit is dispatched", async () => {
		const document = await openDocument()
		host.beforeApply = async () => changeDocument(document, externalText)

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow()
		expect(document.getText()).toBe(externalText)
		expect(document.save).not.toHaveBeenCalled()
		expect(await disk.readFile(skillPath, "utf-8")).toBe(initialText)
	})

	it("keeps a disk edit that arrives at the host save boundary and retains the unsaved metadata edit", async () => {
		const document = await openDocument()
		host.beforeSave = async () => disk.writeFile(skillPath, externalText)

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow()
		expect(await disk.readFile(skillPath, "utf-8")).toBe(externalText)
		expect(document.isDirty).toBe(true)
		expect(matter(document.getText()).data.modeSlugs).toEqual(["architect"])
	})

	it("does not save a new user amendment made after applying the metadata edit", async () => {
		const document = await openDocument()
		let reads = 0
		host.readFile.mockImplementation(async (candidate: string, encoding: BufferEncoding) => {
			const contents = await disk.readFile(candidate, encoding)
			if (candidate === skillPath && ++reads === 2) {
				changeDocument(document, document.getText().replace("Original instructions", "New unsaved amendment"))
			}
			return contents
		})

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow()
		expect(document.getText()).toContain("New unsaved amendment")
		expect(document.isDirty).toBe(true)
		expect(document.save).not.toHaveBeenCalled()
		expect(await disk.readFile(skillPath, "utf-8")).toBe(initialText)
	})

	it("updates only frontmatter and preserves CRLF instructions without adding a trailing newline", async () => {
		const text = initialText.replace(/\n/g, "\r\n").trimEnd()
		await disk.writeFile(skillPath, text)

		await manager.updateSkillModes("test-skill", "project", ["architect"])

		const updated = await disk.readFile(skillPath, "utf-8")
		expect(matter(updated).data).toEqual({
			name: "test-skill",
			description: "Keep user instructions",
			modeSlugs: ["architect"],
		})
		expect(matter(updated).content).toBe(matter(text).content)
		expect(updated.endsWith("Original instructions")).toBe(true)
	})

	it("preserves the host-owned UTF-8 BOM, unrelated metadata and body while clearing mode restrictions", async () => {
		const body = "\n# Instructions\n\nKeep this body exactly.  \n---\nFinal line"
		const text =
			"\uFEFF" +
			matter
				.stringify("", { name: "test-skill", description: "Keep metadata", custom: ["a", "b"], mode: "code" })
				.slice(0, -1) +
			body
		await disk.writeFile(skillPath, text)

		await manager.updateSkillModes("test-skill", "project")

		const updated = await disk.readFile(skillPath, "utf-8")
		expect(updated.startsWith("\uFEFF")).toBe(true)
		expect(matter(updated).content).toBe(body)
		expect(matter(updated).data).toEqual({
			name: "test-skill",
			description: "Keep metadata",
			custom: ["a", "b"],
			modeSlugs: [],
		})
	})

	it.each(["skills-personal", "skills"])(
		"retains the writable boundary for a real %s directory alias",
		async (directory) => {
			const linkedDirectory = path.dirname(skillPath)
			const targetDirectory = path.join(root, "extension", "assets", directory, "test-skill")
			await disk.mkdir(path.dirname(targetDirectory), { recursive: true })
			await disk.rename(linkedDirectory, targetDirectory)
			await disk.symlink(targetDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir")
			await manager.discoverSkills()

			if (directory === "skills") {
				await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow(
					"skills:errors.builtin_read_only",
				)
				expect(host.openTextDocument).not.toHaveBeenCalled()
				expect(await disk.readFile(path.join(targetDirectory, "SKILL.md"), "utf-8")).toBe(initialText)
			} else {
				await manager.updateSkillModes("test-skill", "project", ["architect"])
				const updated = await disk.readFile(path.join(targetDirectory, "SKILL.md"), "utf-8")
				expect(matter(updated).data.modeSlugs).toEqual(["architect"])
				expect(matter(updated).content).toBe(matter(initialText).content)
			}
		},
	)

	it("retains the installed skill boundary after its provider weak reference is unavailable", async () => {
		const linkedDirectory = path.dirname(skillPath)
		const targetDirectory = path.join(root, "extension", "assets", "skills", "test-skill")
		await disk.mkdir(path.dirname(targetDirectory), { recursive: true })
		await disk.rename(linkedDirectory, targetDirectory)
		await disk.symlink(targetDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir")
		vi.spyOn(WeakRef.prototype, "deref").mockReturnValue(undefined)

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow(
			"skills:errors.builtin_read_only",
		)
		expect(host.openTextDocument).not.toHaveBeenCalled()
		expect(await disk.readFile(path.join(targetDirectory, "SKILL.md"), "utf-8")).toBe(initialText)
	})

	it("rejects a dirty document opened through another symlink URI for the same skill", async () => {
		const linkedDirectory = path.dirname(skillPath)
		const targetDirectory = path.join(root, "personal-skills", "test-skill")
		await disk.mkdir(path.dirname(targetDirectory), { recursive: true })
		await disk.rename(linkedDirectory, targetDirectory)
		await disk.symlink(targetDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir")
		await manager.discoverSkills()
		const aliasDocument = await openDocument(skillPath)
		changeDocument(aliasDocument, externalText)

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow()
		expect(host.openTextDocument).not.toHaveBeenCalled()
		expect(aliasDocument.getText()).toBe(externalText)
		expect(aliasDocument.isDirty).toBe(true)
		expect(aliasDocument.save).not.toHaveBeenCalled()
		expect(await disk.readFile(path.join(targetDirectory, "SKILL.md"), "utf-8")).toBe(initialText)
	})

	it("rejects automatic saving when the host is configured to overwrite external file changes", async () => {
		host.saveConflictResolution = "overwriteFileOnDisk"

		await expect(manager.updateSkillModes("test-skill", "project", ["architect"])).rejects.toThrow()
		expect(host.applyEdit).not.toHaveBeenCalled()
		expect(await disk.readFile(skillPath, "utf-8")).toBe(initialText)
	})

	it("does not overwrite a skill created after the initial existence check", async () => {
		const createdPath = path.join(path.dirname(path.dirname(skillPath)), "new-skill", "SKILL.md")
		const mkdir = vi.spyOn(await import("fs/promises"), "mkdir")
		mkdir.mockImplementation(async (candidate, options) => {
			const result = await disk.mkdir(candidate, options)
			if (candidate === path.dirname(createdPath)) await disk.writeFile(createdPath, externalText)
			return result
		})

		await expect(manager.createSkill("new-skill", "project", "A new skill")).rejects.toThrow()
		expect(await disk.readFile(createdPath, "utf-8")).toBe(externalText)
	})
})
