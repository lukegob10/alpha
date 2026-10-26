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
		const settings: ProviderSettings = {
			apiProvider,
			apiModelId: getProviderDefaultModelId(apiProvider),
			[curatedProviderApiKeyFields[apiProvider]]: "saved-test-secret",
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
				[field]: "saved-test-secret",
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
