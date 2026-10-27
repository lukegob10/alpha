import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import * as yaml from "yaml"
import { fileExistsAtPath } from "../utils/fs"
import { GlobalFileNames } from "../shared/globalFileNames"
import { migrateSettings } from "../utils/migrateSettings"

vitest.mock("vscode")
vitest.mock("fs/promises", () => ({
	mkdir: vitest.fn().mockResolvedValue(undefined),
	readFile: vitest.fn(),
	writeFile: vitest.fn().mockResolvedValue(undefined),
	rename: vitest.fn().mockResolvedValue(undefined),
	unlink: vitest.fn().mockResolvedValue(undefined),
}))
vitest.mock("fs")
vitest.mock("../utils/fs")

describe("Alpha settings migration", () => {
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let globalState: Map<string, unknown>
	const mockStoragePath = "/mock/storage"
	const mockSettingsDir = path.join(mockStoragePath, "settings")
	const customModesJson = path.join(mockSettingsDir, "custom_modes.json")
	const customModesYaml = path.join(mockSettingsDir, GlobalFileNames.customModes)

	beforeEach(() => {
		vitest.resetAllMocks()
		vitest.mocked(fs.mkdir).mockResolvedValue(undefined)
		vitest.mocked(fs.writeFile).mockResolvedValue(undefined)
		globalState = new Map()
		mockOutputChannel = {
			appendLine: vitest.fn(),
		} as unknown as vscode.OutputChannel
		mockContext = {
			globalStorageUri: { fsPath: mockStoragePath },
			globalState: {
				get: vitest.fn((key: string) => globalState.get(key)),
				update: vitest.fn(async (key: string, value: unknown) => {
					globalState.set(key, value)
				}),
			},
		} as unknown as vscode.ExtensionContext
	})

	function existingFiles(...paths: string[]) {
		const existing = new Set([mockSettingsDir, ...paths])
		vitest.mocked(fileExistsAtPath).mockImplementation(async (filename: string) => existing.has(filename))
	}

	function expectNoFileChanges() {
		expect(fs.writeFile).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.unlink).not.toHaveBeenCalled()
	}

	it("returns without reading or rewriting files when settings are absent", async () => {
		vitest.mocked(fileExistsAtPath).mockResolvedValue(false)

		await migrateSettings(mockContext, mockOutputChannel)

		expect(fs.readFile).not.toHaveBeenCalled()
		expectNoFileChanges()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"No settings directory found, no migrations necessary",
		)
	})

	it("does not read or rewrite existing MCP settings when no Alpha mode JSON exists", async () => {
		existingFiles(path.join(mockSettingsDir, GlobalFileNames.mcpSettings))

		await migrateSettings(mockContext, mockOutputChannel)

		expect(fs.readFile).not.toHaveBeenCalled()
		expectNoFileChanges()
		expect(vitest.mocked(fileExistsAtPath).mock.calls.map(([filename]) => filename)).toEqual([
			mockSettingsDir,
			customModesJson,
			customModesYaml,
		])
	})

	it("converts Alpha custom_modes.json to equivalent YAML while preserving its source", async () => {
		const content = { customModes: [{ slug: "test-mode", name: "Test Mode" }] }
		existingFiles(customModesJson)
		vitest.mocked(fs.readFile).mockResolvedValue(JSON.stringify(content))

		await migrateSettings(mockContext, mockOutputChannel)

		expect(fs.readFile).toHaveBeenCalledWith(customModesJson, "utf-8")
		expect(fs.writeFile).toHaveBeenCalledOnce()
		const [destination, written, encoding] = vitest.mocked(fs.writeFile).mock.calls[0]
		expect(destination).toBe(customModesYaml)
		expect(encoding).toBe("utf-8")
		expect(yaml.parse(String(written))).toEqual(content)
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.unlink).not.toHaveBeenCalled()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("original JSON file preserved for rollback purposes"),
		)
	})

	it("does not overwrite an existing YAML configuration", async () => {
		existingFiles(customModesJson, customModesYaml)

		await migrateSettings(mockContext, mockOutputChannel)

		expect(fs.readFile).not.toHaveBeenCalled()
		expectNoFileChanges()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"custom_modes.yaml already exists, skipping migration",
		)
	})

	it("reports corrupt JSON without writing or deleting configuration", async () => {
		existingFiles(customModesJson)
		vitest.mocked(fs.readFile).mockResolvedValue("{ invalid json content")

		await migrateSettings(mockContext, mockOutputChannel)

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Error parsing custom_modes.json"),
		)
		expectNoFileChanges()
	})

	it("reports source read errors without writing or deleting configuration", async () => {
		existingFiles(customModesJson)
		vitest.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))

		await migrateSettings(mockContext, mockOutputChannel)

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Error reading custom_modes.json"),
		)
		expectNoFileChanges()
	})

	it("reports settings-discovery errors without changing files", async () => {
		vitest.mocked(fileExistsAtPath).mockRejectedValue(new Error("Test error"))

		await migrateSettings(mockContext, mockOutputChannel)

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Error migrating settings files"),
		)
		expectNoFileChanges()
	})

	it("removes former command defaults once while preserving explicit argument rules", async () => {
		vitest.mocked(fileExistsAtPath).mockResolvedValue(false)
		globalState.set("allowedCommands", ["npm install", "npm install express", "git log", "echo hello"])

		await migrateSettings(mockContext, mockOutputChannel)

		expect(globalState.get("allowedCommands")).toEqual(["npm install express", "echo hello"])
		expect(globalState.get("defaultCommandsMigrationCompleted")).toBe(true)
		expect(globalState.get("autoApprovalCommandDefaultsMigrationCompleted")).toBe(true)
		vitest.mocked(mockContext.globalState.update).mockClear()
		await migrateSettings(mockContext, mockOutputChannel)
		expect(mockContext.globalState.update).not.toHaveBeenCalled()
		expectNoFileChanges()
	})
})
