import type { ExtensionContext } from "vscode"

import { ProviderSettingsManager } from "../ProviderSettingsManager"

const duplicateId = "ambiguous-profile-id"
const invalidValue = {
	id: duplicateId,
	apiProvider: "openai",
	modelTemperature: "malformed-temperature",
	opaqueLegacySettings: { retain: true },
}

function fixture({ currentApiConfigName = "invalid", healthyId = duplicateId, invalidId = duplicateId } = {}) {
	let stored = JSON.stringify({
		currentApiConfigName,
		apiConfigs: {
			healthy: { id: healthyId, apiProvider: "openai", openAiModelId: "healthy-provider-model" },
			invalid: { ...invalidValue, id: invalidId },
		},
		modeApiConfigs: { code: invalidId },
		migrations: {
			rateLimitSecondsMigrated: true,
			openAiHeadersMigrated: true,
			consecutiveMistakeLimitMigrated: true,
			todoListEnabledMigrated: true,
			claudeCodeLegacySettingsMigrated: true,
		},
	})
	const context = {
		secrets: {
			get: vi.fn(async () => stored),
			store: vi.fn(async (_key: string, value: string) => {
				stored = value
			}),
		},
		globalState: { get: vi.fn(), update: vi.fn() },
	} as unknown as ExtensionContext
	return {
		context,
		manager: new ProviderSettingsManager(context),
		read: () => JSON.parse(stored),
		contents: () => stored,
	}
}

describe("retained provider identity collision review", () => {
	it("rejects ambiguous ID reads while preserving named healthy profiles and invalid raw settings", async () => {
		const { manager, read } = fixture()
		await manager.initialize()
		await expect(manager.getProfile({ name: "healthy" })).resolves.toMatchObject({
			apiProvider: "openai",
			openAiModelId: "healthy-provider-model",
		})
		expect(read().retainedApiConfigs.invalid.value).toEqual(invalidValue)

		await expect(manager.getProfile({ id: duplicateId })).rejects.toBeInstanceOf(Error)
	})

	it("does not activate another profile through an ambiguous ID", async () => {
		const { manager, read } = fixture()
		await manager.initialize()

		await expect(manager.activateProfile({ id: duplicateId })).rejects.toBeInstanceOf(Error)
		expect(read().currentApiConfigName).toBe("invalid")
	})

	it("does not redirect an ambiguous saved mode route to a healthy provider", async () => {
		const { manager, read } = fixture()
		await manager.initialize()
		const route = await manager.getModeConfigId("code").then(
			(id) => ({ status: "resolved" as const, id }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		)

		if (route.status === "rejected") {
			expect(route.error).toMatchObject({ name: "ProviderProfileUnavailableError", code: "invalid" })
		} else if (route.id !== undefined) {
			await expect(manager.activateProfile({ id: route.id })).rejects.toBeInstanceOf(Error)
		}
		expect(read().currentApiConfigName).toBe("invalid")
		expect(read().retainedApiConfigs.invalid.value).toEqual(invalidValue)
	})

	it("rejects an ambiguous existing-profile write without changing either profile", async () => {
		const { manager, contents } = fixture()
		await manager.initialize()
		const before = contents()

		await expect(manager.saveConfig({ id: duplicateId }, { apiProvider: "vscode-lm" })).rejects.toBeInstanceOf(
			Error,
		)
		expect(contents()).toBe(before)
	})

	it("preserves retained identity and blocked mode routes across invalid reimport and reopen", async () => {
		const { manager, context, read } = fixture({
			currentApiConfigName: "healthy",
			healthyId: "healthy-id",
			invalidId: "retained-id",
		})
		await manager.initialize()
		const importedInvalid = { id: "imported-invalid-id", apiProvider: "openai", rateLimitSeconds: "still-invalid" }

		await manager.import({
			currentApiConfigName: "healthy",
			apiConfigs: { invalid: importedInvalid as never },
			modeApiConfigs: { architect: "imported-invalid-id" },
		})
		expect(read().retainedApiConfigs.invalid).toEqual({ id: "retained-id", value: importedInvalid })
		expect(await manager.getModeConfigId("code")).toBe("retained-id")
		expect(await manager.getModeConfigId("architect")).toBe("retained-id")

		const reopened = new ProviderSettingsManager(context)
		await reopened.initialize()
		expect(await reopened.getModeConfigId("code")).toBe("retained-id")
		await expect(reopened.activateProfile({ id: "retained-id" })).rejects.toMatchObject({ code: "invalid" })
		expect(read().currentApiConfigName).toBe("healthy")
		expect(read().retainedApiConfigs.invalid.value).toEqual(importedInvalid)
	})
})
