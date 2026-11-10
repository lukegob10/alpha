import fs from "fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ExtensionContext } from "vscode"

import { ContextProxy } from "../ContextProxy"
import type { CustomModesManager } from "../CustomModesManager"
import { importSettingsFromPath } from "../importExport"
import { ProviderSettingsManager } from "../ProviderSettingsManager"

vi.mock("fs/promises", () => ({
	default: { readFile: vi.fn() },
	readFile: vi.fn(),
}))

const provider = {
	id: "custom-provider-id",
	apiProvider: "openai",
	openAiBaseUrl: "https://gateway.example.invalid/v1",
	openAiModelId: "private-model",
	openAiR1FormatEnabled: true,
	openAiStreamingEnabled: false,
	openAiUseAzure: true,
	azureApiVersion: "saved-api-version",
	includeMaxTokens: true,
	modelMaxTokens: 4096,
	modelTemperature: 0,
	todoListEnabled: false,
	consecutiveMistakeLimit: 7,
} as const

const savedPreferences = {
	soundEnabled: false,
	soundVolume: 0,
	enableCheckpoints: false,
	checkpointTimeout: 42,
	autoCondenseContext: false,
	autoCondenseContextPercent: 77,
	autoCondenseContextScope: "after-prefix",
	postTurnCondenseContextPercent: 0,
	maxOpenTabsContext: 0,
	maxWorkspaceFiles: 360,
	showAlphaIgnoredFiles: false,
	enableSubfolderRules: true,
	maxImageFileSize: 8,
	maxTotalImageSize: 24,
	includeDiagnosticMessages: false,
	maxDiagnosticMessages: 100,
	writeDelayMs: 1800,
	terminalShellIntegrationDisabled: false,
	terminalShellIntegrationTimeout: 23_000,
	terminalCommandDelay: 350,
	terminalZshOhMy: true,
	terminalZshP10k: true,
	terminalZdotdir: true,
	showWorktreesInHomeScreen: false,
	reasoningBlockCollapsed: false,
	enterBehavior: "newline",
	autoSteer: true,
	maxConcurrentTasks: 8,
	maxConcurrentSubagents: 4,
	subagentsEnabled: false,
	subagentInterruptMessage: false,
	subagentAgentTypes: {
		reviewer: {
			description: "Use the saved review connection",
			role: "review",
			apiConfigId: provider.id,
			model: "saved-review-model",
			reasoningEffort: "high",
			developerInstructions: "Preserve the review contract",
		},
	},
	memorySettings: {
		enabled: false,
		useMemories: false,
		generateMemories: true,
		disableOnExternalContext: true,
	},
	experiments: { preventFocusDisruption: true, customTools: false },
	customSupportPrompts: { CONDENSE: "Keep the user's recovery notes" },
} as const

function createStorageContext() {
	const state = new Map<string, unknown>()
	const secrets = new Map<string, string>()
	const context = {
		globalState: {
			get: (key: string) => state.get(key),
			update: vi.fn(async (key: string, value: unknown) => {
				if (value === undefined) state.delete(key)
				else state.set(key, value)
			}),
		},
		secrets: {
			get: vi.fn(async (key: string) => secrets.get(key)),
			store: vi.fn(async (key: string, value: string) => {
				secrets.set(key, value)
			}),
			delete: vi.fn(async (key: string) => {
				secrets.delete(key)
			}),
		},
	} as unknown as ExtensionContext
	return { context, state }
}

describe("settings layout import compatibility", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each(["en", "fr", "ja"])(
		"retains moved preferences and provider identity when an older %s export is imported twice",
		async (language) => {
			const { context, state } = createStorageContext()
			const contextProxy = new ContextProxy(context)
			await contextProxy.initialize()
			const providerSettingsManager = new ProviderSettingsManager(context)
			await providerSettingsManager.initialize()
			const updateCustomMode = vi.fn()
			const customModesManager = { updateCustomMode } as unknown as CustomModesManager
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "Saved gateway",
						apiConfigs: { "Saved gateway": provider },
						modeApiConfigs: { code: provider.id },
					},
					globalSettings: {
						...savedPreferences,
						terminalOutputPreviewSize: "large",
						telemetrySetting: "enabled",
						language,
					},
				}),
			)

			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await importSettingsFromPath("/fixtures/previous-settings.json", {
					providerSettingsManager,
					contextProxy,
					customModesManager,
				})

				expect(result.success).toBe(true)
				expect(result.warnings).toBeUndefined()
				expect(contextProxy.getValue("currentApiConfigName")).toBe("Saved gateway")
				expect(contextProxy.getValue("openAiModelId")).toBe(provider.openAiModelId)
				expect(state.get("language")).toBe("en")
				const profiles = await providerSettingsManager.export()
				expect(profiles.currentApiConfigName).toBe("Saved gateway")
				expect(profiles.apiConfigs["Saved gateway"]).toEqual(provider)
				expect(profiles.modeApiConfigs?.code).toBe(provider.id)

				const exportedPreferences = await contextProxy.export()
				expect(exportedPreferences).toMatchObject({ ...savedPreferences, language: "en" })
				expect(exportedPreferences?.subagentAgentTypes?.reviewer).toEqual(
					savedPreferences.subagentAgentTypes.reviewer,
				)
				expect(exportedPreferences).not.toHaveProperty("telemetrySetting")
				expect(exportedPreferences).not.toHaveProperty("terminalOutputPreviewSize")
				expect(state.has("terminalOutputPreviewSize")).toBe(false)
				expect(state.has("telemetrySetting")).toBe(false)
				expect(exportedPreferences).not.toHaveProperty("currentApiConfigName")
				expect(exportedPreferences).not.toHaveProperty("openAiBaseUrl")
			}
			expect(updateCustomMode).not.toHaveBeenCalled()
		},
	)

	it.each(["unset", "enabled", "disabled"])(
		"ignores an existing retired reporting preference (%s) without changing other stored preferences",
		async (telemetrySetting) => {
			const { context, state } = createStorageContext()
			state.set("telemetrySetting", telemetrySetting)
			state.set("approvalMode", "ask")
			state.set("soundEnabled", false)
			const contextProxy = new ContextProxy(context)
			await contextProxy.initialize()

			expect(contextProxy.getValues()).not.toHaveProperty("telemetrySetting")
			expect(contextProxy.getGlobalSettings()).not.toHaveProperty("telemetrySetting")
			expect(await contextProxy.export()).not.toHaveProperty("telemetrySetting")
			expect(contextProxy.getValue("approvalMode")).toBe("ask")
			expect(contextProxy.getValue("soundEnabled")).toBe(false)
			expect(state.get("telemetrySetting")).toBe(telemetrySetting)
			expect(context.globalState.update).not.toHaveBeenCalledWith("telemetrySetting", expect.anything())
		},
	)

	it.each(["small", "large", null, { obsolete: true }])(
		"ignores an existing retired preview value %j while preserving stored shell overrides",
		async (terminalOutputPreviewSize) => {
			const { context, state } = createStorageContext()
			const shellOverrides = {
				terminalShellIntegrationDisabled: false,
				terminalShellIntegrationTimeout: 23000,
				terminalCommandDelay: 350,
				terminalPowershellCounter: true,
				terminalZshClearEolMark: false,
				terminalZshOhMy: true,
				terminalZshP10k: true,
				terminalZdotdir: true,
			}
			state.set("terminalOutputPreviewSize", terminalOutputPreviewSize)
			for (const [key, value] of Object.entries(shellOverrides)) state.set(key, value)
			const contextProxy = new ContextProxy(context)
			await contextProxy.initialize()

			expect(contextProxy.getValues()).not.toHaveProperty("terminalOutputPreviewSize")
			expect(contextProxy.getGlobalSettings()).not.toHaveProperty("terminalOutputPreviewSize")
			expect(await contextProxy.export()).not.toHaveProperty("terminalOutputPreviewSize")
			expect(await contextProxy.export()).toMatchObject(shellOverrides)
			expect(state.get("terminalOutputPreviewSize")).toBe(terminalOutputPreviewSize)
			expect(context.globalState.update).not.toHaveBeenCalledWith("terminalOutputPreviewSize", expect.anything())
		},
	)

	it("keeps an existing hidden preference when a sparse import only changes sound", async () => {
		const { context } = createStorageContext()
		const contextProxy = new ContextProxy(context)
		await contextProxy.initialize()
		await contextProxy.setValues({
			enableCheckpoints: false,
			terminalShellIntegrationDisabled: false,
			experiments: { preventFocusDisruption: true, customTools: false },
			showAlphaIgnoredFiles: false,
		})
		const providerSettingsManager = new ProviderSettingsManager(context)
		await providerSettingsManager.initialize()
		const customModesManager = { updateCustomMode: vi.fn() } as unknown as CustomModesManager
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({
				providerProfiles: { currentApiConfigName: "default", apiConfigs: {} },
				globalSettings: { soundEnabled: true, soundVolume: 0.25 },
			}),
		)

		const result = await importSettingsFromPath("/fixtures/sparse-settings.json", {
			providerSettingsManager,
			contextProxy,
			customModesManager,
		})

		expect(result.success).toBe(true)
		expect(await contextProxy.export()).toMatchObject({
			soundEnabled: true,
			soundVolume: 0.25,
			enableCheckpoints: false,
			terminalShellIntegrationDisabled: false,
			experiments: { preventFocusDisruption: true, customTools: false },
			showAlphaIgnoredFiles: false,
		})
	})
})
