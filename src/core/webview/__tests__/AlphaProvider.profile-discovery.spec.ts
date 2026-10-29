import { describe, expect, it, vi } from "vitest"
import type { ExtensionContext } from "vscode"
import type { ProviderSettings } from "@alpha-code/types"

import { ProviderSettingsManager, type ProviderProfiles } from "../../config/ProviderSettingsManager"
import { AlphaProvider } from "../AlphaProvider"

async function createProvider() {
	const saved: ProviderProfiles = {
		currentApiConfigName: "Active",
		apiConfigs: {
			Active: { id: "active-id", apiProvider: "openai-codex", apiModelId: "gpt-6.1-sol" },
			Shared: {
				id: "shared-id",
				apiProvider: "openai-native",
				apiModelId: "gpt-6.1-sol",
				openAiNativeApiKey: "fixture-secret-not-discoverable",
			},
		},
		modeApiConfigs: { code: "active-id", architect: "active-id" },
		migrations: {
			rateLimitSecondsMigrated: true,
			openAiHeadersMigrated: true,
			consecutiveMistakeLimitMigrated: true,
			todoListEnabledMigrated: true,
			claudeCodeLegacySettingsMigrated: true,
		},
	}
	let persisted = JSON.stringify(saved)
	const secrets = {
		get: vi.fn(async () => persisted),
		store: vi.fn(async (_key: string, value: string) => {
			persisted = value
		}),
	}
	const manager = new ProviderSettingsManager({ secrets } as unknown as ExtensionContext)
	await manager.initialize()
	secrets.get.mockClear()
	secrets.store.mockClear()
	const getState = vi.fn(async () => {
		throw new Error("Discovery must not build webview state")
	})
	const getValues = vi.fn(() => {
		throw new Error("Discovery must not read cached profile metadata")
	})
	const activate = vi.spyOn(manager, "activateProfile")
	const apiConfiguration: ProviderSettings = { apiProvider: "openai-codex", apiModelId: "gpt-6.1-sol" }
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		providerSettingsManager: manager,
		getState,
		contextProxy: { getValues },
		taskStack: [{ apiConfiguration }],
	})
	return {
		provider,
		saved,
		secrets,
		getState,
		getValues,
		activate,
		apiConfiguration,
		replaceSaved: (next: ProviderProfiles) => {
			persisted = JSON.stringify(next)
		},
		readSaved: () => JSON.parse(persisted),
	}
}

describe("authoritative saved profile discovery", () => {
	it("reads additions, renames, model changes and removals from current saved storage", async () => {
		const fixture = await createProvider()
		const first = await fixture.provider.listProviderProfiles()
		expect(first).toEqual([
			{ id: "active-id", name: "Active", apiProvider: "openai-codex", modelId: "gpt-6.1-sol" },
			{ id: "shared-id", name: "Shared", apiProvider: "openai-native", modelId: "gpt-6.1-sol" },
		])

		fixture.replaceSaved({
			...fixture.saved,
			apiConfigs: {
				Active: fixture.saved.apiConfigs.Active,
				Renamed: {
					id: "shared-id",
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "copilot", family: "grok-4.6" },
				},
				Added: { id: "added-id", apiProvider: "openai-native", apiModelId: "gpt-5.6-luna" },
			},
		})
		expect(await fixture.provider.listProviderProfiles()).toEqual([
			{ id: "active-id", name: "Active", apiProvider: "openai-codex", modelId: "gpt-6.1-sol" },
			{ id: "shared-id", name: "Renamed", apiProvider: "vscode-lm", modelId: "grok-4.6" },
			{ id: "added-id", name: "Added", apiProvider: "openai-native", modelId: "gpt-5.6-luna" },
		])
		fixture.replaceSaved({ ...fixture.saved, apiConfigs: { Active: fixture.saved.apiConfigs.Active } })
		expect(await fixture.provider.listProviderProfiles()).toEqual([first[0]])
		expect(first[1].name).toBe("Shared")
		expect(fixture.getState).not.toHaveBeenCalled()
		expect(fixture.getValues).not.toHaveBeenCalled()
	})

	it("returns full credential-free metadata without activating or updating a saved connection", async () => {
		const fixture = await createProvider()
		const saved = {
			...fixture.saved,
			apiConfigs: {
				Active: fixture.saved.apiConfigs.Active,
				...Object.fromEntries(
					Array.from({ length: 17 }, (_, index) => [
						`Profile ${index}`,
						{ ...fixture.saved.apiConfigs.Shared, id: `profile-${index}` },
					]),
				),
			},
		}
		fixture.replaceSaved(saved)
		const profiles = await fixture.provider.listProviderProfiles()
		expect(profiles).toHaveLength(18)
		expect(JSON.stringify(profiles)).not.toContain("fixture-secret")
		expect(fixture.secrets.store).not.toHaveBeenCalled()
		expect(fixture.activate).not.toHaveBeenCalled()
		expect(fixture.readSaved()).toEqual(saved)
		expect(fixture.apiConfiguration).toEqual({ apiProvider: "openai-codex", apiModelId: "gpt-6.1-sol" })
	})

	it("surfaces saved-storage errors without substituting cached or empty choices", async () => {
		const fixture = await createProvider()
		fixture.secrets.get.mockRejectedValueOnce(new Error("Profile storage unavailable"))
		await expect(fixture.provider.listProviderProfiles()).rejects.toThrow("Profile storage unavailable")
		expect(fixture.secrets.store).not.toHaveBeenCalled()
		expect(fixture.getState).not.toHaveBeenCalled()
		expect(fixture.getValues).not.toHaveBeenCalled()
	})
})
