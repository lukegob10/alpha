import type { ProviderProfiles } from "../../core/config/ProviderSettingsManager"

// Mock dependencies
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
}))

vi.mock("fs/promises", () => ({
	__esModule: true,
	default: {
		readFile: vi.fn(),
	},
	readFile: vi.fn(),
}))

vi.mock("path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("path")>()
	return {
		...actual,
		default: {
			...actual,
			join: vi.fn((...args: string[]) => args.join("/")),
			isAbsolute: vi.fn((p: string) => p.startsWith("/")),
			basename: vi.fn((p: string) => p.split("/").pop() || ""),
		},
		join: vi.fn((...args: string[]) => args.join("/")),
		isAbsolute: vi.fn((p: string) => p.startsWith("/")),
		basename: vi.fn((p: string) => p.split("/").pop() || ""),
	}
})

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return {
		...actual,
		default: {
			...actual,
			homedir: vi.fn(() => "/home/user"),
		},
		homedir: vi.fn(() => "/home/user"),
	}
})

vi.mock("../fs", () => ({
	fileExistsAtPath: vi.fn(),
}))

vi.mock("../../core/config/ProviderSettingsManager", async (importOriginal) => {
	const originalModule = await importOriginal()
	return {
		__esModule: true,
		// We need to mock the class constructor and its methods,
		// but keep other exports (like schemas) as their original values.
		...(originalModule || {}), // Spread original exports
		ProviderSettingsManager: vi.fn().mockImplementation(function () {
			return {
				// Mock the class
				export: vi.fn().mockResolvedValue({
					apiConfigs: {},
					modeApiConfigs: {},
					currentApiConfigName: "default",
				}),
				import: vi.fn().mockImplementation(async (profiles: ProviderProfiles) => profiles),
				listConfig: vi.fn().mockResolvedValue([]),
			}
		}),
	}
})
vi.mock("../../core/config/ContextProxy")
vi.mock("../../core/config/CustomModesManager")

import { autoImportSettings } from "../autoImportSettings"
import * as vscode from "vscode"
import fsPromises from "fs/promises"
import { fileExistsAtPath } from "../fs"

describe("autoImportSettings", () => {
	let mockProviderSettingsManager: any
	let mockContextProxy: any
	let mockCustomModesManager: any
	let mockOutputChannel: any
	let mockProvider: any

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
		}

		// Mock provider settings manager
		mockProviderSettingsManager = {
			export: vi.fn().mockResolvedValue({
				apiConfigs: {},
				modeApiConfigs: {},
				currentApiConfigName: "default",
			}),
			import: vi.fn().mockImplementation(async (profiles: ProviderProfiles) => profiles),
			listConfig: vi.fn().mockResolvedValue([]),
		}

		// Mock context proxy
		mockContextProxy = {
			setValues: vi.fn().mockResolvedValue(undefined),
			setValue: vi.fn().mockResolvedValue(undefined),
			setProviderSettings: vi.fn().mockResolvedValue(undefined),
		}

		// Mock custom modes manager
		mockCustomModesManager = {
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
		}

		// mockProvider must be initialized AFTER its dependencies
		mockProvider = {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			upsertProviderProfile: vi.fn().mockResolvedValue({ success: true }),
			postStateToWebview: vi.fn().mockResolvedValue({ success: true }),
		}

		// Reset fs mock
		vi.mocked(fsPromises.readFile).mockReset()
		vi.mocked(fileExistsAtPath).mockReset()
		vi.mocked(vscode.workspace.getConfiguration).mockReset()
		vi.mocked(vscode.window.showInformationMessage).mockReset()
		vi.mocked(vscode.window.showWarningMessage).mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it.each(["workspaceValue", "workspaceFolderValue"])(
		"ignores an automatic import path supplied only by %s",
		async (source) => {
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: vi.fn().mockReturnValue("/workspace/settings.json"),
				inspect: vi.fn().mockReturnValue({ [source]: "/workspace/settings.json" }),
			} as unknown as vscode.WorkspaceConfiguration)
			vi.mocked(fileExistsAtPath).mockResolvedValue(true)
			vi.mocked(fsPromises.readFile).mockResolvedValue(
				JSON.stringify({
					providerProfiles: { currentApiConfigName: "default", apiConfigs: {} },
					globalSettings: { approvalMode: "bypass", approvalModeBypassAcknowledged: true },
				}),
			)

			await autoImportSettings(mockOutputChannel, {
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(fileExistsAtPath).not.toHaveBeenCalled()
			expect(fsPromises.readFile).not.toHaveBeenCalled()
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		},
	)

	it("uses the user-owned automatic import path despite workspace overrides", async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue("/workspace/settings.json"),
			inspect: vi.fn().mockReturnValue({
				globalValue: "/user/settings.json",
				workspaceValue: "/workspace/settings.json",
				workspaceFolderValue: "/folder/settings.json",
			}),
		} as unknown as vscode.WorkspaceConfiguration)
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(fileExistsAtPath).toHaveBeenCalledExactlyOnceWith("/user/settings.json")
	})

	it("should skip auto-import when no settings path is specified", async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(""),
			inspect: vi.fn().mockReturnValue({ globalValue: "" }),
		} as any)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[AutoImport] No auto-import settings path specified, skipping auto-import",
		)
		expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
	})

	it("should skip auto-import when settings file does not exist", async () => {
		const settingsPath = "~/Documents/alpha-config.json"
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(settingsPath),
			inspect: vi.fn().mockReturnValue({ globalValue: settingsPath }),
		} as any)

		// Mock fileExistsAtPath to return false
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[AutoImport] Checking for settings file at: /home/user/Documents/alpha-config.json",
		)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[AutoImport] Settings file not found at /home/user/Documents/alpha-config.json, skipping auto-import",
		)
		expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
	})

	it("should successfully import settings when file exists and is valid", async () => {
		const settingsPath = "/absolute/path/to/config.json"
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(settingsPath),
			inspect: vi.fn().mockReturnValue({ globalValue: settingsPath }),
		} as any)

		// Mock fileExistsAtPath to return true
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)

		// Mock fs.readFile to return valid config
		const mockSettings = {
			providerProfiles: {
				currentApiConfigName: "test-config",
				apiConfigs: {
					"test-config": {
						apiProvider: "vertex",
						openAiApiKey: "test-key",
					},
				},
			},
			globalSettings: {
				customInstructions: "Test instructions",
			},
		}

		vi.mocked(fsPromises.readFile).mockResolvedValue(JSON.stringify(mockSettings) as any)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[AutoImport] Checking for settings file at: /absolute/path/to/config.json",
		)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[AutoImport] Successfully imported settings from /absolute/path/to/config.json",
		)
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("info.auto_import_success")
		expect(mockProviderSettingsManager.import).toHaveBeenCalled()
		expect(mockContextProxy.setValues).toHaveBeenCalled()
	})

	it("warns about retained setup issues without a success toast or raw payload and keeps the configured file authoritative", async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue("/absolute/path/to/legacy-config.json"),
			inspect: vi.fn().mockReturnValue({ globalValue: "/absolute/path/to/legacy-config.json" }),
		} as unknown as ReturnType<typeof vscode.workspace.getConfiguration>)
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(fsPromises.readFile).mockResolvedValue(
			JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "legacy",
					apiConfigs: {
						legacy: {
							id: "legacy-id",
							apiProvider: "openai",
							rateLimitSeconds: "invalid",
							openAiApiKey: "test-secret-never-log",
						},
					},
				},
			}),
		)
		const options = {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		}
		await autoImportSettings(mockOutputChannel, options)
		await autoImportSettings(mockOutputChannel, options)
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2)
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("warnings.auto_import_requires_attention")
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("legacy-config.json with 1 profile warning"),
		)
		expect(JSON.stringify(mockOutputChannel.appendLine.mock.calls)).not.toContain("test-secret-never-log")
		expect(JSON.stringify(vi.mocked(vscode.window.showWarningMessage).mock.calls)).not.toContain(
			"test-secret-never-log",
		)
		expect(fsPromises.readFile).toHaveBeenCalledTimes(2)
		expect(mockContextProxy.setProviderSettings).not.toHaveBeenCalled()
	})

	it("should handle invalid JSON gracefully", async () => {
		const settingsPath = "~/config.json"
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(settingsPath),
			inspect: vi.fn().mockReturnValue({ globalValue: settingsPath }),
		} as any)

		// Mock fileExistsAtPath to return true
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)

		// Mock fs.readFile to return invalid JSON
		vi.mocked(fsPromises.readFile).mockResolvedValue("invalid json" as any)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("[AutoImport] Failed to import settings:"),
		)
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("warnings.auto_import_failed"),
		)
		expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
	})

	it("should resolve home directory paths correctly", async () => {
		const settingsPath = "~/Documents/config.json"
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(settingsPath),
			inspect: vi.fn().mockReturnValue({ globalValue: settingsPath }),
		} as any)

		// Mock fileExistsAtPath to return false (so we can check the resolved path)
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[AutoImport] Checking for settings file at: /home/user/Documents/config.json",
		)
	})

	it("should handle relative paths by resolving them to home directory", async () => {
		const settingsPath = "Documents/config.json"
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(settingsPath),
			inspect: vi.fn().mockReturnValue({ globalValue: settingsPath }),
		} as any)

		// Mock fileExistsAtPath to return false (so we can check the resolved path)
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[AutoImport] Checking for settings file at: /home/user/Documents/config.json",
		)
	})

	it("should handle file system errors gracefully", async () => {
		const settingsPath = "~/config.json"
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(settingsPath),
			inspect: vi.fn().mockReturnValue({ globalValue: settingsPath }),
		} as any)

		// Mock fileExistsAtPath to throw an error
		vi.mocked(fileExistsAtPath).mockRejectedValue(new Error("File system error"))

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("[AutoImport] Unexpected error during auto-import:"),
		)
		expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
	})
})
