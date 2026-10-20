import type { ExtensionContext } from "vscode"

import { ProviderSettingsManager, type ProviderProfiles } from "../ProviderSettingsManager"

const migrations = {
	rateLimitSecondsMigrated: true,
	openAiHeadersMigrated: true,
	consecutiveMistakeLimitMigrated: true,
	todoListEnabledMigrated: true,
	claudeCodeLegacySettingsMigrated: true,
}

function savedProfiles(profiles: unknown) {
	let content = JSON.stringify(profiles)
	const secrets = {
		get: vi.fn(async () => content),
		store: vi.fn(async (_key: string, value: string) => {
			content = value
		}),
		delete: vi.fn(),
	}
	const context = {
		secrets,
		globalState: { get: vi.fn(), update: vi.fn() },
	} as unknown as ExtensionContext
	return { context, secrets, read: () => JSON.parse(content) as ProviderProfiles }
}

describe("provider profile upgrade continuity", () => {
	it("assigns legacy profile IDs before binding modes to the selected profile", async () => {
		const saved = savedProfiles({
			currentApiConfigName: "selected",
			apiConfigs: {
				selected: { apiProvider: "openai", openAiModelId: "selected-model" },
				other: { apiProvider: "vscode-lm" },
			},
			migrations,
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()

		const { id } = await manager.getProfile({ name: "selected" })
		expect(id).toBeTruthy()
		expect(await manager.getModeConfigId("code")).toBe(id)
		expect(await manager.getModeConfigId("architect")).toBe(id)
		await expect(manager.getProfile({ id: (await manager.getModeConfigId("code"))! })).resolves.toMatchObject({
			name: "selected",
			openAiModelId: "selected-model",
		})
	})

	it("does not replace the selected legacy profile with another profile that already has an ID", async () => {
		const saved = savedProfiles({
			currentApiConfigName: "selected",
			apiConfigs: {
				other: { id: "other-id", apiProvider: "vscode-lm" },
				selected: { apiProvider: "openai", openAiModelId: "selected-model" },
			},
			migrations,
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()

		expect(await manager.getModeConfigId("code")).toBe((await manager.getProfile({ name: "selected" })).id)
		expect(await manager.getModeConfigId("code")).not.toBe("other-id")
	})

	it("repairs dangling bindings from older migrations without changing valid mode choices", async () => {
		const saved = savedProfiles({
			currentApiConfigName: "selected",
			apiConfigs: {
				selected: { id: "selected-id", apiProvider: "openai" },
				other: { id: "other-id", apiProvider: "vscode-lm" },
			},
			modeApiConfigs: { code: "unpersisted-seed-id", architect: "other-id", retired: "historical-id" },
			migrations,
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()

		expect(await manager.getModeConfigId("code")).toBe("selected-id")
		expect(await manager.getModeConfigId("architect")).toBe("other-id")
		expect(saved.read().modeApiConfigs?.retired).toBe("historical-id")
		const migrated = saved.read()
		saved.secrets.store.mockClear()
		const reopened = new ProviderSettingsManager(saved.context)
		await reopened.initialize()
		expect(saved.read()).toEqual(migrated)
		expect(saved.secrets.store).not.toHaveBeenCalled()
	})

	it("leaves absent per-mode choices absent when the binding map already exists", async () => {
		const saved = savedProfiles({
			currentApiConfigName: "selected",
			apiConfigs: { selected: { id: "selected-id", apiProvider: "openai" } },
			modeApiConfigs: {},
			migrations,
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()

		expect(await manager.getModeConfigId("code")).toBeUndefined()
		expect(saved.secrets.store).not.toHaveBeenCalled()
	})

	it("migrates a legacy null mistake limit without silently deleting the profile", async () => {
		const saved = savedProfiles({
			currentApiConfigName: "selected",
			apiConfigs: {
				selected: {
					id: "selected-id",
					apiProvider: "openai",
					openAiModelId: "selected-model",
					consecutiveMistakeLimit: null,
					legacyMetadata: "preserve-me",
				},
			},
			modeApiConfigs: { code: "selected-id" },
			migrations: { ...migrations, consecutiveMistakeLimitMigrated: false },
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()

		await expect(manager.getProfile({ name: "selected" })).resolves.toMatchObject({
			id: "selected-id",
			openAiModelId: "selected-model",
			consecutiveMistakeLimit: 3,
			legacyMetadata: "preserve-me",
		})
		expect(saved.read().apiConfigs.selected).toBeDefined()
		expect(saved.read().migrations?.consecutiveMistakeLimitMigrated).toBe(true)
	})
})
