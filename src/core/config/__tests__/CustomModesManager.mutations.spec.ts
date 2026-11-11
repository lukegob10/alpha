import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as yaml from "yaml"
import * as vscode from "vscode"

import type { ModeConfig } from "@alpha-code/types"

import { ensureSettingsDirectoryExists } from "../../../utils/globalContext"
import { getWorkspacePath } from "../../../utils/path"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import * as fileWrites from "../../task-persistence/atomicWrite"
import { CustomModesManager } from "../CustomModesManager"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [], createFileSystemWatcher: vi.fn() },
	window: { showErrorMessage: vi.fn() },
}))
vi.mock("fs/promises", async () => ({ ...(await vi.importActual<typeof import("fs/promises")>("fs/promises")) }))
vi.mock("../../../utils/globalContext", () => ({ ensureSettingsDirectoryExists: vi.fn() }))
vi.mock("../../../utils/path")

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("CustomModesManager mutation integrity", () => {
	let directory: string
	let settingsDirectory: string
	let settingsPath: string
	const managers: CustomModesManager[] = []
	const newMode = (slug: string, source: "global" | "project" = "global"): ModeConfig => ({
		slug,
		name: slug,
		roleDefinition: "Review fixture",
		groups: ["read"],
		source,
	})
	const createManager = (storagePath = settingsDirectory) => {
		const manager = new CustomModesManager(
			{
				globalStorageUri: { fsPath: storagePath },
				globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
			} as unknown as vscode.ExtensionContext,
			vi.fn(async () => undefined),
		)
		managers.push(manager)
		return manager
	}

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-custom-mode-mutations-"))
		settingsDirectory = path.join(directory, "settings")
		await fs.mkdir(settingsDirectory)
		settingsPath = path.join(settingsDirectory, GlobalFileNames.customModes)
		await fs.writeFile(settingsPath, yaml.stringify({ customModes: [] }))
		vi.mocked(ensureSettingsDirectoryExists).mockImplementation(async (context) => context.globalStorageUri.fsPath)
		vi.mocked(getWorkspacePath).mockReturnValue(directory)
		Object.assign(vscode.workspace, { workspaceFolders: [{ uri: { fsPath: directory } }] })
	})

	afterEach(async () => {
		for (const manager of managers.splice(0)) manager.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it.each(["EACCES", "EIO"])("preserves existing settings when reading fails with %s", async (code) => {
		const original = await fs.readFile(settingsPath, "utf-8")
		const canonicalPath = await fs.realpath(settingsPath)
		const readFile = fs.readFile
		vi.spyOn(fs, "readFile").mockImplementation(((file, ...args) => {
			if (file === settingsPath || file === canonicalPath)
				return Promise.reject(Object.assign(new Error("Read unavailable"), { code }))
			return Reflect.apply(readFile, fs, [file, ...args])
		}) as typeof fs.readFile)

		await expect(createManager().updateCustomMode("added", newMode("added"))).rejects.toThrow(/read|repair/i)
		expect(await readFile(settingsPath, "utf-8")).toBe(original)
	})

	it.each(["customModes: [broken", "null", "[]", "customModes: null", "customModes: false", "customModes: {}"])(
		"preserves invalid existing settings: %s",
		async (original) => {
			await fs.writeFile(settingsPath, original)

			await expect(createManager().updateCustomMode("added", newMode("added"))).rejects.toThrow(
				/repair|invalid|parse/i,
			)
			expect(await fs.readFile(settingsPath, "utf-8")).toBe(original)
		},
	)

	it("preserves unrelated settings and existing mode fields", async () => {
		const original = {
			customModes: [{ ...newMode("existing"), futureField: "retained" }],
			otherSetting: { keep: true },
		}
		await fs.writeFile(settingsPath, yaml.stringify(original))

		await createManager().updateCustomMode("added", newMode("added"))

		expect(yaml.parse(await fs.readFile(settingsPath, "utf-8"))).toEqual({
			...original,
			customModes: [...original.customModes, newMode("added")],
		})
	})

	it("creates an actually missing project settings file", async () => {
		await createManager().updateCustomMode("added", newMode("added", "project"))

		expect(yaml.parse(await fs.readFile(path.join(directory, ".alphamodes"), "utf-8")).customModes).toEqual([
			newMode("added", "project"),
		])
	})

	it.each([
		["null rule entry", [null]],
		["non-array rules", { relativePath: "new.md", content: "Replacement rule" }],
		["traversing path", [{ relativePath: "rules-existing/../outside.md", content: "Replacement rule" }]],
		["drive-relative path", [{ relativePath: "C:outside.md", content: "Replacement rule" }]],
		[
			"file/directory path collision",
			[
				{ relativePath: "nested", content: "Replacement rule" },
				{ relativePath: "nested/new.md", content: "Replacement rule" },
			],
		],
	])("preserves existing settings and rules when a later imported mode has %s", async (_label, rulesFiles) => {
		const original = yaml.stringify({ customModes: [newMode("existing", "project")] })
		const projectModes = path.join(directory, ".alphamodes")
		const rulesDirectory = path.join(directory, ".alpha", "rules-existing")
		const existingRule = path.join(rulesDirectory, "keep.md")
		await fs.writeFile(projectModes, original)
		await fs.mkdir(rulesDirectory, { recursive: true })
		await fs.writeFile(existingRule, "Keep this rule")

		const result = await createManager().importModeWithRules(
			yaml.stringify({
				customModes: [
					newMode("would-be-added"),
					{ ...newMode("existing"), name: "Replacement mode", rulesFiles },
				],
			}),
		)

		await expect(fs.readFile(projectModes, "utf-8")).resolves.toBe(original)
		await expect(fs.readFile(existingRule, "utf-8")).resolves.toBe("Keep this rule")
		expect(result.success).toBe(false)
	})

	it("preserves nested rules through a same-mode export and import", async () => {
		const projectModes = path.join(directory, ".alphamodes")
		const rulesDirectory = path.join(directory, ".alpha", "rules-existing")
		const nestedRule = path.join(rulesDirectory, "rules-nested", "deep.md")
		const emptyRule = path.join(path.dirname(nestedRule), "empty.md")
		await fs.writeFile(projectModes, yaml.stringify({ customModes: [newMode("existing", "project")] }))
		await fs.mkdir(path.dirname(nestedRule), { recursive: true })
		await fs.writeFile(path.join(rulesDirectory, "top.md"), "Top-level rule")
		await fs.writeFile(nestedRule, "  Nested rule\n")
		await fs.writeFile(emptyRule, "")

		const manager = createManager()
		const exported = await manager.exportModeWithRules("existing")
		expect(exported).toMatchObject({ success: true, yaml: expect.any(String) })
		await expect(manager.importModeWithRules(exported.yaml!)).resolves.toMatchObject({ success: true })

		await expect(fs.readFile(nestedRule, "utf-8")).resolves.toBe("  Nested rule\n")
		await expect(fs.readFile(emptyRule, "utf-8")).resolves.toBe("")
		await expect(fs.readFile(path.join(rulesDirectory, "top.md"), "utf-8")).resolves.toBe("Top-level rule")
	})

	it("does not export rules from linked directories", async () => {
		const projectModes = path.join(directory, ".alphamodes")
		const rulesDirectory = path.join(directory, ".alpha", "rules-existing")
		const linkedDirectory = path.join(directory, "linked-rules-target")
		await fs.writeFile(projectModes, yaml.stringify({ customModes: [newMode("existing", "project")] }))
		await fs.mkdir(rulesDirectory, { recursive: true })
		await fs.mkdir(linkedDirectory)
		await fs.writeFile(path.join(linkedDirectory, "private.md"), "Private rule")
		const linkedEntry = path.join(rulesDirectory, "linked")
		const linkType = process.platform === "win32" ? "junction" : "dir"
		await fs.symlink(linkedDirectory, linkedEntry, linkType)

		const manager = createManager()
		const exported = await manager.exportModeWithRules("existing")
		expect(exported.success).toBe(true)
		expect(exported.yaml).not.toContain("Private rule")

		await fs.unlink(linkedEntry)
		await fs.rmdir(rulesDirectory)
		await fs.symlink(linkedDirectory, rulesDirectory, linkType)
		await expect(manager.exportModeWithRules("existing")).resolves.toMatchObject({ success: false })
	})

	it("fails instead of emitting a partial export when rules exceed the content budget", async () => {
		const projectModes = path.join(directory, ".alphamodes")
		const rulesDirectory = path.join(directory, ".alpha", "rules-existing")
		const oversizedRule = path.join(rulesDirectory, "oversized.md")
		await fs.writeFile(projectModes, yaml.stringify({ customModes: [newMode("existing", "project")] }))
		await fs.mkdir(rulesDirectory, { recursive: true })
		await fs.writeFile(oversizedRule, "")
		await fs.truncate(oversizedRule, 9 * 1024 * 1024)
		const readFile = vi.spyOn(fs, "readFile")

		await expect(createManager().exportModeWithRules("existing")).resolves.toEqual({
			success: false,
			error: "customModes.errors.ruleExportLimit",
		})
		expect(readFile).not.toHaveBeenCalledWith(await fs.realpath(oversizedRule), "utf-8")
	})

	it("creates default settings only when the file is missing", async () => {
		await fs.unlink(settingsPath)
		await expect(createManager().getCustomModesFilePath()).resolves.toBe(settingsPath)
		expect(yaml.parse(await fs.readFile(settingsPath, "utf-8"))).toEqual({ customModes: [] })
	})

	it("keeps existing settings when an existence check fails", async () => {
		const original = await fs.readFile(settingsPath, "utf-8")
		const access = fs.access
		vi.spyOn(fs, "access").mockImplementation(async (file, ...args) => {
			if (file === settingsPath) throw Object.assign(new Error("Unavailable"), { code: "EACCES" })
			return access(file, ...args)
		})

		await expect(createManager().getCustomModesFilePath()).resolves.toBe(settingsPath)
		expect(await fs.readFile(settingsPath, "utf-8")).toBe(original)
	})

	it("retains the original settings when atomic replacement fails", async () => {
		const original = await fs.readFile(settingsPath, "utf-8")
		const canonicalPath = await fs.realpath(settingsPath)
		const rename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (destination === canonicalPath) throw Object.assign(new Error("Commit unavailable"), { code: "EIO" })
			return rename(source, destination)
		})

		await expect(createManager().updateCustomMode("added", newMode("added"))).rejects.toThrow("Commit unavailable")
		expect(await fs.readFile(settingsPath, "utf-8")).toBe(original)
		expect(await fs.readdir(settingsDirectory)).toEqual([GlobalFileNames.customModes])
	})

	it("rejects a settings alias retargeted while waiting for the shared lease", async () => {
		const aliasDirectory = path.join(directory, "settings-alias")
		const otherDirectory = path.join(directory, "other-settings")
		await fs.mkdir(otherDirectory)
		await fs.writeFile(path.join(otherDirectory, GlobalFileNames.customModes), yaml.stringify({ customModes: [] }))
		await fs.symlink(settingsDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir")
		const canonicalPath = await fs.realpath(settingsPath)
		const acquired = deferred()
		const release = deferred()
		const queued = deferred()
		const lock = fileWrites.withFileLock
		const holder = lock(canonicalPath, async () => {
			acquired.resolve()
			await release.promise
		})
		await acquired.promise
		vi.spyOn(fileWrites, "withFileLock").mockImplementation((file, operation) => {
			queued.resolve()
			return lock(file, operation)
		})
		const update = createManager(aliasDirectory).updateCustomMode("added", newMode("added"))
		const rejection = expect(update).rejects.toThrow(/conflict|changed|reload/i)
		try {
			await queued.promise
			await fs.unlink(aliasDirectory)
			await fs.symlink(otherDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir")
		} finally {
			release.resolve()
			await Promise.allSettled([holder, update])
		}
		await rejection
		expect(yaml.parse(await fs.readFile(settingsPath, "utf-8")).customModes).toEqual([])
		expect(
			yaml.parse(await fs.readFile(path.join(otherDirectory, GlobalFileNames.customModes), "utf-8")).customModes,
		).toEqual([])
	})

	it("preserves both views' updates through canonical aliases of the same file", async () => {
		const aliasDirectory = path.join(directory, "settings-alias")
		await fs.symlink(settingsDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir")
		const firstWrite = deferred()
		const releaseFirst = deferred()
		const secondAttempt = deferred()
		let writes = 0
		const pauseWrite = async () => {
			if (++writes === 1) {
				firstWrite.resolve()
				await releaseFirst.promise
			} else secondAttempt.resolve()
		}
		const writeFile = fs.writeFile
		vi.spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
			if ([settingsPath, path.join(aliasDirectory, GlobalFileNames.customModes)].includes(file.toString())) {
				await pauseWrite()
			}
			return Reflect.apply(writeFile, fs, [file, ...args])
		})
		const atomicWrite = fileWrites.atomicWriteText
		vi.spyOn(fileWrites, "atomicWriteText").mockImplementation(async (...args) => {
			await pauseWrite()
			return atomicWrite(...args)
		})
		const lock = fileWrites.withFileLock
		let attempts = 0
		vi.spyOn(fileWrites, "withFileLock").mockImplementation((file, operation) => {
			if (++attempts === 2) secondAttempt.resolve()
			return lock(file, operation)
		})
		const first = createManager().updateCustomMode("first", newMode("first"))
		await firstWrite.promise
		const second = createManager(aliasDirectory).updateCustomMode("second", newMode("second"))
		try {
			await secondAttempt.promise
		} finally {
			releaseFirst.resolve()
			await Promise.allSettled([first, second])
		}
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
		expect(
			yaml
				.parse(await fs.readFile(settingsPath, "utf-8"))
				.customModes.map((mode: ModeConfig) => mode.slug)
				.sort(),
		).toEqual(["first", "second"])
	})
})
