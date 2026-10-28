import type { ExtensionContext } from "vscode"

import { ProviderSettingsManager } from "../ProviderSettingsManager"

const migrations = {
	rateLimitSecondsMigrated: true,
	openAiHeadersMigrated: true,
	consecutiveMistakeLimitMigrated: true,
	todoListEnabledMigrated: true,
	claudeCodeLegacySettingsMigrated: true,
}

const invalid = {
	id: "invalid-id",
	apiProvider: "openai",
	rateLimitSeconds: "invalid-number",
	openAiApiKey: "retained-test-secret",
	legacyField: { preserve: true },
}

function fixture(
	profiles: unknown = {
		currentApiConfigName: "invalid",
		apiConfigs: { valid: { id: "valid-id", apiProvider: "vscode-lm" }, invalid },
		modeApiConfigs: { code: "invalid-id", architect: "valid-id" },
		migrations,
	},
) {
	let stored = JSON.stringify(profiles)
	const secrets = {
		get: vi.fn(async () => stored),
		store: vi.fn(async (_key: string, value: string) => {
			stored = value
		}),
		delete: vi.fn(),
	}
	const context = {
		secrets,
		globalState: { get: vi.fn(), update: vi.fn() },
	} as unknown as ExtensionContext
	return {
		context,
		secrets,
		read: () => JSON.parse(stored),
		contents: () => stored,
		clear: () => {
			stored = ""
		},
	}
}

describe("saved provider profile retention", () => {
	it.each([
		{ apiProvider: "constructor", apiModelId: "name" },
		{ apiProvider: "__proto__", apiModelId: "toString" },
		{ apiProvider: "toString", apiModelId: "name" },
		{ apiProvider: "future-provider", apiModelId: "constructor" },
		{ apiProvider: "openai-native", apiModelId: "constructor" },
		{ apiProvider: "openai-native", apiModelId: "gpt-5" },
	])(
		"preserves saved provider $apiProvider and model $apiModelId through initialization and reopen",
		async (settings) => {
			const profile = { id: "selected-id", ...settings }
			const profiles = {
				currentApiConfigName: "selected",
				apiConfigs: { selected: profile },
				modeApiConfigs: { code: profile.id, architect: profile.id },
				migrations,
			}
			const saved = fixture(profiles)

			for (let open = 0; open < 2; open++) {
				const manager = new ProviderSettingsManager(saved.context)
				await manager.initialize()
				expect(saved.read()).toEqual(profiles)
				await expect(manager.getProfile({ id: profile.id })).resolves.toMatchObject(profile)
			}
		},
	)

	it("preserves raw invalid profiles through unrelated saves, migration and reopen", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		await manager.saveConfig("valid", { id: "valid-id", apiProvider: "vscode-lm", modelTemperature: 0.5 })

		expect(saved.read().retainedApiConfigs).toEqual({ invalid: { id: "invalid-id", value: invalid } })
		expect(saved.read().apiConfigs.invalid).toBeUndefined()
		expect(saved.read().currentApiConfigName).toBe("invalid")
		expect(await manager.getModeConfigId("code")).toBe("invalid-id")
		expect(await manager.listConfig()).toContainEqual({
			id: "invalid-id",
			name: "invalid",
			apiProvider: "openai",
			availability: "invalid",
			invalidFields: ["rateLimitSeconds"],
		})

		const beforeReopen = saved.contents()
		saved.secrets.store.mockClear()
		const reopened = new ProviderSettingsManager(saved.context)
		await reopened.initialize()
		expect(saved.contents()).toBe(beforeReopen)
		expect(saved.secrets.store).not.toHaveBeenCalled()
		expect((await reopened.export()).retainedApiConfigs).toEqual(saved.read().retainedApiConfigs)
	})

	it("returns an explicit safe error and never activates an invalid retained profile", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		const before = saved.contents()
		for (const target of [{ id: "invalid-id" }, { name: "invalid" }]) {
			await expect(manager.getProfile(target)).rejects.toMatchObject({
				code: "invalid",
				profile: { id: "invalid-id", name: "invalid" },
				invalidFields: ["rateLimitSeconds"],
			})
			await expect(manager.activateProfile(target)).rejects.not.toThrow("retained-test-secret")
		}
		expect(saved.contents()).toBe(before)
	})

	it("retains unsupported profiles for editing but never activates them", async () => {
		const unsupported = { id: "old-id", apiProvider: "removed-provider", apiKey: "retained-test-secret" }
		const saved = fixture({ currentApiConfigName: "old", apiConfigs: { old: unsupported }, migrations })
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()

		await expect(manager.getProfile({ id: "old-id" })).resolves.toMatchObject(unsupported)
		await expect(manager.activateProfile({ id: "old-id" })).rejects.toMatchObject({ code: "unsupported" })
		expect(await manager.listConfig()).toContainEqual({
			id: "old-id",
			name: "old",
			apiProvider: "removed-provider",
			availability: "unsupported",
		})
		expect((await manager.export()).apiConfigs.old).toMatchObject(unsupported)
	})

	it("renames retained profiles without changing raw values, identities, current selection or routes", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		await expect(manager.renameProfile({ id: "invalid-id" }, "renamed")).resolves.toMatchObject({
			id: "invalid-id",
			oldName: "invalid",
			newName: "renamed",
			isActive: true,
		})

		expect(saved.read().retainedApiConfigs).toEqual({ renamed: { id: "invalid-id", value: invalid } })
		expect(saved.read().currentApiConfigName).toBe("renamed")
		expect(saved.read().modeApiConfigs.code).toBe("invalid-id")
		await expect(manager.renameProfile({ id: "invalid-id" }, "VALID")).rejects.toMatchObject({ code: "nameInUse" })
		await manager.renameProfile({ id: "invalid-id" }, "__proto__")
		expect(Object.hasOwn(saved.read().retainedApiConfigs, "__proto__")).toBe(true)
	})

	it("only replaces retained data after an explicit validated save targeting its stable ID", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		const before = saved.contents()
		await expect(
			manager.saveConfig({ id: "invalid-id" }, { rateLimitSeconds: "bad" } as never),
		).rejects.toMatchObject({ code: "invalid" })
		expect(saved.contents()).toBe(before)

		await expect(
			manager.saveConfig({ id: "invalid-id" }, { apiProvider: "vscode-lm", id: "wrong-id" }),
		).resolves.toEqual({ id: "invalid-id", name: "invalid" })
		expect(saved.read().retainedApiConfigs?.invalid).toBeUndefined()
		await expect(manager.getProfile({ id: "invalid-id" })).resolves.toMatchObject({
			name: "invalid",
			apiProvider: "vscode-lm",
		})
		expect(saved.read().modeApiConfigs.code).toBe("invalid-id")
	})

	it("retains primitive invalid values with stable IDs across an all-invalid store and explicit deletion", async () => {
		const saved = fixture({ currentApiConfigName: "broken", apiConfigs: { broken: null }, migrations })
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		const entries = await manager.listConfig()
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ name: "broken", availability: "invalid", invalidFields: ["configuration"] })
		expect(entries[0].id).toBeTruthy()
		expect(saved.read().apiConfigs).toEqual({})
		expect(saved.read().retainedApiConfigs.broken).toEqual({ id: entries[0].id, value: null })
		const reopened = new ProviderSettingsManager(saved.context)
		await reopened.initialize()
		expect(await reopened.listConfig()).toEqual(entries)
		await expect(reopened.deleteConfig("broken")).rejects.toThrow("last remaining")
		await reopened.saveConfig("replacement", { apiProvider: "vscode-lm" })
		await reopened.deleteConfig("broken")
		expect(await reopened.listConfig()).toMatchObject([{ name: "replacement" }])
		expect(saved.read().currentApiConfigName).toBe("replacement")
	})

	it("preserves retained records during unrelated imports and permits explicit valid import repair", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		await manager.import({
			currentApiConfigName: "new",
			apiConfigs: { new: { id: "new-id", apiProvider: "vscode-lm" } },
		})
		expect(saved.read().retainedApiConfigs.invalid).toEqual({ id: "invalid-id", value: invalid })
		const exported = await manager.export()
		const target = fixture({ currentApiConfigName: "empty", apiConfigs: {}, migrations })
		const targetManager = new ProviderSettingsManager(target.context)
		await targetManager.initialize()
		await targetManager.import(exported)
		expect(target.read().retainedApiConfigs.invalid).toEqual({ id: "invalid-id", value: invalid })

		await targetManager.import({
			currentApiConfigName: "invalid",
			apiConfigs: { invalid: { id: "invalid-id", apiProvider: "vscode-lm" } },
		})
		expect(target.read().retainedApiConfigs?.invalid).toBeUndefined()
		await expect(targetManager.getProfile({ id: "invalid-id" })).resolves.toMatchObject({
			apiProvider: "vscode-lm",
		})
	})

	it("does not create a default provider when reopening an empty persisted store", async () => {
		const saved = fixture({ currentApiConfigName: "deleted", apiConfigs: {}, migrations })
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		expect(await manager.listConfig()).toEqual([])
		await expect(manager.activateProfile({ name: "deleted" })).rejects.toThrow("not found")
		expect(saved.read().currentApiConfigName).toBe("deleted")
	})

	it("does not discard retained records shadowing an executable name during export/import", async () => {
		const saved = fixture({
			currentApiConfigName: "shadowed",
			apiConfigs: { shadowed: { id: "valid-id", apiProvider: "vscode-lm" } },
			retainedApiConfigs: { shadowed: { id: "invalid-id", value: invalid } },
			migrations,
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		await manager.import(await manager.export())
		expect(saved.read().retainedApiConfigs.shadowed.value).toEqual(invalid)
		await expect(manager.assertProfileAvailable({ name: "shadowed" })).rejects.toMatchObject({ code: "invalid" })
	})

	it("checks the clicked profile identity inside the deletion transaction", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		const before = saved.contents()
		await expect(manager.deleteConfig("invalid", { expectedId: "stale-ui-id" })).rejects.toThrow("identity")
		expect(saved.contents()).toBe(before)
		await expect(manager.deleteConfig("invalid", { expectedId: "invalid-id" })).resolves.toMatchObject({
			currentApiConfigName: "valid",
			entries: [{ name: "valid" }],
		})
		expect(saved.read().modeApiConfigs).toEqual({ architect: "valid-id" })
	})

	it("keeps retained identities and their routes when an explicit import repairs the same profile", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		await manager.import({
			currentApiConfigName: "invalid",
			apiConfigs: { invalid: { id: "import-id", apiProvider: "vscode-lm" } },
			modeApiConfigs: { architect: "import-id" },
		})
		await expect(manager.getProfile({ name: "invalid" })).resolves.toMatchObject({ id: "invalid-id" })
		expect(await manager.getModeConfigId("code")).toBe("invalid-id")
		expect(await manager.getModeConfigId("architect")).toBe("invalid-id")
	})

	it("publishes only bounded known field names from invalid nested settings", async () => {
		const saved = fixture({
			currentApiConfigName: "broken",
			migrations,
			apiConfigs: {
				broken: { id: "broken-id", apiProvider: "openai", openAiHeaders: { "private-test-header-name": 123 } },
			},
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		const entries = await manager.listConfig()
		expect(entries[0].invalidFields).toEqual(["openAiHeaders"])
		expect(JSON.stringify(entries)).not.toContain("private-test-header-name")
	})

	it.each(["valid", "retained"])(
		"rejects duplicate %s profile IDs without changing raw IDs or saved bindings",
		async (kind) => {
			const apiConfigs =
				kind === "valid"
					? {
							first: { id: "duplicate-id", apiProvider: "vscode-lm" },
							second: { id: "duplicate-id", apiProvider: "openai" },
						}
					: {
							first: { ...invalid, id: "duplicate-id" },
							second: { ...invalid, id: "duplicate-id", legacyField: { second: true } },
						}
			const saved = fixture({
				currentApiConfigName: "first",
				apiConfigs,
				modeApiConfigs: { code: "duplicate-id" },
				migrations,
			})
			const manager = new ProviderSettingsManager(saved.context)
			await manager.initialize()
			const before = saved.contents()
			await expect(manager.getProfile({ id: "duplicate-id" })).rejects.toMatchObject({
				code: "invalid",
				invalidFields: ["id"],
			})
			await expect(manager.activateProfile({ id: "duplicate-id" })).rejects.toMatchObject({ code: "invalid" })
			await expect(manager.getModeConfigId("code")).rejects.toMatchObject({
				code: "invalid",
				invalidFields: ["id"],
			})
			await expect(manager.renameProfile({ id: "duplicate-id" }, "renamed")).rejects.toMatchObject({
				code: "invalid",
			})
			await expect(
				manager.saveConfig({ id: "duplicate-id" }, { apiProvider: "vscode-lm" }),
			).rejects.toMatchObject({ code: "invalid" })
			expect(saved.contents()).toBe(before)
			if (kind === "valid") {
				await expect(manager.getProfile({ name: "first" })).resolves.toMatchObject({ apiProvider: "vscode-lm" })
				await expect(manager.assertProfileAvailable({ name: "first" })).resolves.toBeUndefined()
			}
			const reopened = new ProviderSettingsManager(saved.context)
			await reopened.initialize()
			expect(saved.contents()).toBe(before)
			expect((await reopened.listConfig()).map(({ id }) => id)).toEqual(["duplicate-id", "duplicate-id"])
			expect(saved.read().modeApiConfigs.code).toBe("duplicate-id")
			await expect(reopened.assertProfileAvailable({ id: "duplicate-id" })).rejects.toMatchObject({
				code: "invalid",
			})
		},
	)

	it.each(["mode", "settings"])("rejects ambiguous imported %s references before any durable write", async (kind) => {
		const saved = fixture({
			currentApiConfigName: "valid",
			apiConfigs: { valid: { id: "valid-id", apiProvider: "vscode-lm" } },
			retainedApiConfigs: {
				first: { id: "first-id", value: invalid },
				second: { id: "second-id", value: invalid },
			},
			modeApiConfigs: { code: "first-id" },
			migrations,
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		const before = saved.contents()
		const incoming = {
			currentApiConfigName: "first",
			apiConfigs: {
				first: { id: "duplicate-import-id", apiProvider: "vscode-lm" as const },
				second: { id: "duplicate-import-id", apiProvider: "openai" as const },
			},
			...(kind === "mode" ? { modeApiConfigs: { code: "duplicate-import-id" } } : {}),
		}
		await expect(
			manager.import(incoming, kind === "settings" ? { referencedIds: ["duplicate-import-id"] } : {}),
		).rejects.toMatchObject({ code: "invalid", invalidFields: ["id"] })
		expect(saved.contents()).toBe(before)
	})

	it("returns the committed available selection snapshot from the same deletion transaction", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		const result = await manager.deleteConfig("invalid", { expectedId: "invalid-id" })
		expect(result.selectedProfile).toEqual({ name: "valid", id: "valid-id", apiProvider: "vscode-lm" })
		expect(JSON.stringify(result)).not.toContain("retained-test-secret")
		expect(saved.read().currentApiConfigName).toBe(result.currentApiConfigName)
	})

	it("does not publish a deletion selection or remove retained data when storage rejects", async () => {
		const saved = fixture()
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		const before = saved.contents()
		saved.secrets.store.mockRejectedValueOnce(new Error("disk failure"))
		await expect(manager.deleteConfig("invalid", { expectedId: "invalid-id" })).rejects.toThrow("disk failure")
		expect(saved.contents()).toBe(before)
		await expect(manager.assertProfileAvailable({ name: "invalid" })).rejects.toMatchObject({ code: "invalid" })
	})

	it("shares the fresh default identity across views before the first explicit save", async () => {
		const saved = fixture()
		saved.clear()
		const sidebar = new ProviderSettingsManager(saved.context)
		const editor = new ProviderSettingsManager(saved.context)
		await sidebar.initialize()
		await editor.initialize()
		const [selected] = await sidebar.listConfig()
		await expect(editor.getProfile({ id: selected.id })).resolves.toMatchObject({
			name: "default",
			id: selected.id,
		})
		expect(saved.secrets.store).not.toHaveBeenCalled()
		await sidebar.saveConfig({ id: selected.id }, { apiProvider: "vscode-lm" })
		const reopened = new ProviderSettingsManager(saved.context)
		await reopened.initialize()
		await expect(editor.getProfile({ id: selected.id })).resolves.toMatchObject({ apiProvider: "vscode-lm" })
		await expect(reopened.getProfile({ id: selected.id })).resolves.toMatchObject({
			name: "default",
			id: selected.id,
			apiProvider: "vscode-lm",
		})
		const separate = fixture()
		separate.clear()
		const isolated = new ProviderSettingsManager(separate.context)
		await isolated.initialize()
		expect((await isolated.getProfile({ name: "default" })).apiProvider).toBeUndefined()
		expect(separate.secrets.store).not.toHaveBeenCalled()
	})

	it("keeps profile names authoritative when preserved settings contain a legacy name field", async () => {
		const saved = fixture({
			currentApiConfigName: "invalid",
			migrations,
			apiConfigs: {
				invalid,
				valid: { id: "valid-id", name: "misdirected-name", apiProvider: "vscode-lm" },
			},
		})
		const manager = new ProviderSettingsManager(saved.context)
		await manager.initialize()
		await expect(manager.getProfile({ name: "valid" })).resolves.toMatchObject({ name: "valid" })
		await expect(manager.activateProfile({ name: "valid" })).resolves.toMatchObject({ name: "valid" })
		const deleted = await manager.deleteConfig("invalid")
		expect(deleted.selectedProfile?.name).toBe("valid")
		expect(saved.read().currentApiConfigName).toBe("valid")
		expect(saved.read().apiConfigs.valid.name).toBe("misdirected-name")
	})
})
