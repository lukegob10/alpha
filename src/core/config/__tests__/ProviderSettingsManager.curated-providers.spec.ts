import type { ExtensionContext } from "vscode"

import {
	curatedProviders,
	curatedProviderApiKeyFields,
	getProviderDefaultModelId,
	resolveOptionalOutputTokenLimit,
	type ProviderSettings,
} from "@alpha-code/types"

import { ProviderSettingsManager } from "../ProviderSettingsManager"
import { buildApiHandler } from "../../../api"

const migrations = {
	rateLimitSecondsMigrated: true,
	openAiHeadersMigrated: true,
	consecutiveMistakeLimitMigrated: true,
	todoListEnabledMigrated: true,
	claudeCodeLegacySettingsMigrated: true,
}

function savedProfile(settings: ProviderSettings) {
	let contents = JSON.stringify({
		currentApiConfigName: "selected",
		apiConfigs: { selected: { id: "saved-profile-id", ...settings } },
		modeApiConfigs: { code: "saved-profile-id", architect: "saved-profile-id" },
		migrations,
	})
	const context = {
		secrets: {
			get: vi.fn(async () => contents),
			store: vi.fn(async (_key: string, value: string) => {
				contents = value
			}),
		},
		globalState: { get: vi.fn(), update: vi.fn() },
	} as unknown as ExtensionContext
	return { context, read: () => JSON.parse(contents) }
}

describe("curated provider profile continuity", () => {
	it.each(curatedProviders)("preserves the explicit %s output cap through export and import", async (apiProvider) => {
		const field = curatedProviderApiKeyFields[apiProvider]
		const settings: ProviderSettings = {
			apiProvider,
			apiModelId: getProviderDefaultModelId(apiProvider),
			...(field ? { [field]: "saved-test-secret" } : {}),
			includeMaxTokens: true,
			modelMaxTokens: 2048,
			modelMaxThinkingTokens: 1024,
			reasoningEffort: "high",
		}
		const handler = buildApiHandler(settings)
		try {
			const model = handler.getModel().info
			expect(model.supportsReasoningBudget || model.requiredReasoningBudget).not.toBe(true)
			expect(resolveOptionalOutputTokenLimit({ model, settings })).toBe(2048)
		} finally {
			handler.dispose?.()
		}

		const source = savedProfile(settings)
		const manager = new ProviderSettingsManager(source.context)
		await manager.initialize()
		const exported = await manager.export()
		expect(exported.apiConfigs.selected).toMatchObject({ includeMaxTokens: true, modelMaxTokens: 2048 })
		expect(exported.apiConfigs.selected).not.toHaveProperty("modelMaxThinkingTokens")

		const destination = savedProfile({})
		const imported = new ProviderSettingsManager(destination.context)
		await imported.initialize()
		await imported.import(exported)
		const restored = await imported.getAvailableProfile("selected")
		expect(restored).toMatchObject({ apiProvider, includeMaxTokens: true, modelMaxTokens: 2048 })
		expect(restored).not.toHaveProperty("modelMaxThinkingTokens")
		if (!restored) throw new Error("Imported provider profile is unavailable")
		const restoredHandler = buildApiHandler(restored)
		try {
			expect(
				resolveOptionalOutputTokenLimit({ model: restoredHandler.getModel().info, settings: restored }),
			).toBe(2048)
		} finally {
			restoredHandler.dispose?.()
		}
	})

	it.each(curatedProviders)(
		"restores %s without replacing saved identity, selection, or credentials",
		async (apiProvider) => {
			const field = curatedProviderApiKeyFields[apiProvider]
			const settings: ProviderSettings = {
				apiProvider,
				apiModelId: getProviderDefaultModelId(apiProvider),
				...(field ? { [field]: "saved-test-secret" } : {}),
				reasoningEffort: "high",
			}
			const saved = savedProfile(settings)
			const manager = new ProviderSettingsManager(saved.context)
			await manager.initialize()
			expect(await manager.getAvailableProfile("selected")).toEqual(settings)
			expect(await manager.listConfig()).toEqual([
				{ name: "selected", id: "saved-profile-id", apiProvider, modelId: expect.any(String) },
			])

			await manager.saveConfig({ id: "saved-profile-id" }, { ...settings, openAiApiKey: "other-provider-secret" })
			expect(saved.read().apiConfigs.selected).toEqual({ id: "saved-profile-id", ...settings })
			expect(saved.read().currentApiConfigName).toBe("selected")
			expect(await manager.getModeConfigId("code")).toBe("saved-profile-id")
			const reopened = new ProviderSettingsManager(saved.context)
			await reopened.initialize()
			await reopened.import(await manager.export())
			expect(await reopened.getProfile({ id: "saved-profile-id" })).toEqual({
				id: "saved-profile-id",
				name: "selected",
				...settings,
			})
		},
	)

	it("keeps AWS authentication modes and credentials in the saved profile secret", async () => {
		const settings: ProviderSettings = {
			apiProvider: "bedrock",
			apiModelId: getProviderDefaultModelId("bedrock"),
			awsRegion: "us-east-1",
			awsUseProfile: true,
			awsProfile: "alpha",
			awsAccessKey: "saved-access-key",
			awsSecretKey: "saved-secret-key",
			awsSessionToken: "saved-session-token",
			awsUseApiKey: false,
			awsApiKey: "saved-bedrock-api-key",
		}
		const saved = savedProfile(settings)
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		await manager.saveConfig({ id: "saved-profile-id" }, settings)
		expect(await manager.getAvailableProfile("selected")).toEqual(settings)
		expect(saved.read().apiConfigs.selected).toEqual({ id: "saved-profile-id", ...settings })
		expect(saved.context.globalState.update).not.toHaveBeenCalled()
	})

	it.each(["openai-codex", "bedrock"] as const)(
		"reads and exports %s model preferences without an account or credential lookup",
		async (apiProvider) => {
			const fetch = vi.spyOn(globalThis, "fetch")
			try {
				const settings: ProviderSettings = { apiProvider, apiModelId: getProviderDefaultModelId(apiProvider) }
				const saved = savedProfile(settings)
				const manager = new ProviderSettingsManager(saved.context)
				await manager.initialize()
				const exported = await manager.export()
				expect(exported.apiConfigs.selected).toEqual({ id: "saved-profile-id", ...settings })
				expect(curatedProviderApiKeyFields[apiProvider]).toBeUndefined()
				expect(fetch).not.toHaveBeenCalled()
			} finally {
				fetch.mockRestore()
			}
		},
	)

	it("exports ChatGPT model preferences without copying runtime OAuth or other provider credentials", async () => {
		const settings = {
			apiProvider: "openai-codex" as const,
			apiModelId: getProviderDefaultModelId("openai-codex"),
			reasoningEffort: "high" as const,
			accessToken: "service-access-token",
			refreshToken: "service-refresh-token",
			openAiNativeApiKey: "unrelated-api-key",
		}
		const saved = savedProfile(settings)
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		await manager.saveConfig({ id: "saved-profile-id" }, settings)
		const exported = await manager.export()
		expect(exported.apiConfigs.selected).toEqual({
			id: "saved-profile-id",
			apiProvider: "openai-codex",
			apiModelId: getProviderDefaultModelId("openai-codex"),
			reasoningEffort: "high",
		})
		expect(JSON.stringify(exported)).not.toContain("service-access-token")
		expect(JSON.stringify(exported)).not.toContain("service-refresh-token")
		expect(JSON.stringify(exported)).not.toContain("unrelated-api-key")
	})

	it.each([
		["openai-native", "gpt-5.6-sol"],
		["openai-codex", "gpt-6-luna"],
		["meta", "older-removed-meta-model"],
		["bedrock", "anthropic.claude-3-sonnet-20240229-v1:0"],
	] as const)(
		"preserves the removed %s model %s without rewriting its saved identity",
		async (apiProvider, apiModelId) => {
			const field = curatedProviderApiKeyFields[apiProvider]
			const settings: ProviderSettings = {
				apiProvider,
				apiModelId,
				...(field ? { [field]: "saved-test-secret" } : {}),
			}
			const saved = savedProfile(settings)
			const manager = new ProviderSettingsManager(saved.context)
			await manager.initialize()
			await manager.saveConfig({ id: "saved-profile-id" }, settings)
			const restored = await manager.getProfile({ id: "saved-profile-id" })
			expect(restored.apiModelId).toBe(apiModelId)
			expect(saved.read().apiConfigs.selected.apiModelId).toBe(apiModelId)
			expect(() => buildApiHandler(restored)).toThrow(/Unsupported .* model/)
		},
	)

	it("keeps legacy OpenRouter model IDs and route choices through explicit saves", async () => {
		const settings: ProviderSettings = {
			apiProvider: "openrouter",
			openRouterApiKey: "saved-test-secret",
			openRouterModelId: "openai/historical-model-id",
			openRouterBaseUrl: "https://historical-gateway.example/api/v1",
			openRouterSpecificProvider: "historical-provider",
		}
		const saved = savedProfile(settings)
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		expect(await manager.listConfig()).toEqual([
			{ name: "selected", id: "saved-profile-id", apiProvider: "openrouter", modelId: "historical-model-id" },
		])
		await manager.saveConfig({ id: "saved-profile-id" }, settings)
		expect(saved.read().apiConfigs.selected).toEqual({ id: "saved-profile-id", ...settings })
	})
})
