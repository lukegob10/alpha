import type { ExtensionContext } from "vscode"
import { ProviderSettingsManager, type ProviderProfiles } from "../ProviderSettingsManager"

const canonicalKey = "alpha_config_api_config"
const legacyKey = "roo_cline_config_api_config"
const migrations = {
	rateLimitSecondsMigrated: true,
	openAiHeadersMigrated: true,
	consecutiveMistakeLimitMigrated: true,
	todoListEnabledMigrated: true,
	claudeCodeLegacySettingsMigrated: true,
}
const profiles = (): ProviderProfiles => ({
	currentApiConfigName: "Saved profile",
	apiConfigs: {
		"Saved profile": {
			id: "saved-id",
			apiProvider: "openai-codex",
			apiModelId: "gpt-6.1-sol",
			reasoningEffort: "high",
		},
	},
	modeApiConfigs: { code: "saved-id", architect: "saved-id" },
	migrations,
})
const placeholder = () => ({
	currentApiConfigName: "default",
	apiConfigs: { default: { id: "default" } },
	modeApiConfigs: { code: "default", architect: "default" },
	migrations,
})

function fixture(canonical?: unknown, legacy: unknown = profiles()) {
	const stored = new Map<string, string>()
	if (canonical !== undefined) stored.set(canonicalKey, JSON.stringify(canonical))
	if (legacy !== undefined) stored.set(legacyKey, JSON.stringify(legacy))
	const secrets = {
		get: vi.fn(async (key: string) => stored.get(key)),
		store: vi.fn(async (key: string, value: string) => {
			stored.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			stored.delete(key)
		}),
	}
	const context = { secrets } as unknown as ExtensionContext
	return { stored, secrets, context, manager: new ProviderSettingsManager(context) }
}

describe("saved provider namespace compatibility", () => {
	it.each([undefined, placeholder()])("recovers legacy profiles when canonical storage is %j", async (canonical) => {
		const data = fixture(canonical)
		await data.manager.initialize()
		expect(await data.manager.getProfile({ id: "saved-id" })).toMatchObject({
			name: "Saved profile",
			...profiles().apiConfigs["Saved profile"],
		})
		const recovered = JSON.parse(data.stored.get(canonicalKey)!)
		expect(recovered.modeApiConfigs).toEqual(profiles().modeApiConfigs)
		expect(recovered.migrations.legacyStorageMigrated).toBe(true)
		expect(data.stored.get(legacyKey)).toBe(JSON.stringify(profiles()))
	})

	it("persists recovery once and reads canonical profiles on later instances", async () => {
		const data = fixture()
		await data.manager.initialize()
		const writes = data.secrets.store.mock.calls.length
		data.stored.set(legacyKey, JSON.stringify({ ...profiles(), currentApiConfigName: "Obsolete" }))
		const reopened = new ProviderSettingsManager(data.context)
		await reopened.initialize()
		expect(await reopened.getProfile({ id: "saved-id" })).toMatchObject({ name: "Saved profile" })
		expect(data.secrets.store).toHaveBeenCalledTimes(writes)
	})

	it.each([
		profiles(),
		{ ...placeholder(), apiConfigs: { default: { id: "default", apiProvider: "openai-codex" } } },
		{ ...placeholder(), apiConfigs: { default: { id: "default", futurePreference: "keep" } } },
		{ ...placeholder(), modeApiConfigs: { code: "different-id" } },
		{ ...placeholder(), retainedApiConfigs: { future: { id: "future-id", value: { future: true } } } },
		{ ...placeholder(), migrations: { ...migrations, legacyStorageMigrated: true } },
	])("keeps meaningful or already-migrated canonical storage authoritative: %j", async (canonical) => {
		const data = fixture(canonical)
		await data.manager.initialize()
		expect(data.secrets.get).not.toHaveBeenCalledWith(legacyKey)
		expect(await data.manager.listConfig()).not.toContainEqual(expect.objectContaining({ name: "Obsolete" }))
	})

	it("retains opaque legacy profiles without substituting a provider", async () => {
		const legacy = profiles()
		legacy.apiConfigs["Saved profile"] = { id: "saved-id", apiProvider: "future-provider" as never }
		const data = fixture(undefined, legacy)
		await data.manager.initialize()
		expect(await data.manager.listConfig()).toContainEqual(
			expect.objectContaining({ id: "saved-id", name: "Saved profile", availability: "unsupported" }),
		)
	})

	it("does not resurrect legacy profiles after an explicit reset", async () => {
		const data = fixture()
		await data.manager.initialize()
		await data.manager.resetAllConfigs()
		expect(data.stored.has(canonicalKey)).toBe(false)
		expect(data.stored.has(legacyKey)).toBe(false)
		const reopened = new ProviderSettingsManager(data.context)
		await reopened.initialize()
		expect(await reopened.listConfig()).toEqual([{ id: "default", name: "default", apiProvider: undefined }])
	})

	it("keeps canonical data if removing legacy data during reset fails", async () => {
		const data = fixture(profiles())
		await data.manager.initialize()
		data.secrets.delete.mockRejectedValueOnce(new Error("storage unavailable"))
		await expect(data.manager.resetAllConfigs()).rejects.toThrow("storage unavailable")
		expect(data.stored.get(canonicalKey)).toBe(JSON.stringify(profiles()))
	})

	it("preserves both copies if persisting recovered profiles fails", async () => {
		const data = fixture(placeholder())
		data.secrets.store.mockRejectedValue(new Error("storage unavailable"))
		await expect(data.manager.initialize()).rejects.toThrow("storage unavailable")
		expect(data.stored.get(canonicalKey)).toBe(JSON.stringify(placeholder()))
		expect(data.stored.get(legacyKey)).toBe(JSON.stringify(profiles()))
	})

	it.each(["canonical", "legacy"])(
		"preserves invalid %s JSON without falling back or overwriting",
		async (source) => {
			const data = fixture(source === "canonical" ? profiles() : undefined)
			data.stored.set(source === "canonical" ? canonicalKey : legacyKey, "invalid-json")
			await expect(data.manager.initialize()).rejects.toThrow("not valid JSON")
			expect(data.secrets.store).not.toHaveBeenCalled()
			expect(data.secrets.delete).not.toHaveBeenCalled()
		},
	)

	it("serializes recovery across views sharing secret storage", async () => {
		const data = fixture()
		const other = new ProviderSettingsManager(data.context)
		await Promise.all([data.manager.initialize(), other.initialize()])
		expect(data.secrets.store).toHaveBeenCalledTimes(1)
		expect(await other.getProfile({ id: "saved-id" })).toMatchObject({ name: "Saved profile" })
	})
})
