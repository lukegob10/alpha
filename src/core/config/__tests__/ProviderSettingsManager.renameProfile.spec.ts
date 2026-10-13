import type { ExtensionContext } from "vscode"
import type { ProviderSettingsWithId } from "@alpha-code/types"

import { ProviderSettingsManager } from "../ProviderSettingsManager"

const savedProfile = {
	id: "profile-id",
	apiProvider: "openai",
	openAiBaseUrl: "https://saved.example/v1",
	openAiApiKey: "saved-test-key",
	openAiModelId: "saved-model",
	legacySetting: { preserve: true },
}

function profileFixture(name = "saved") {
	return {
		currentApiConfigName: name,
		apiConfigs: Object.fromEntries([
			[name, savedProfile],
			["other", { id: "other-id", apiProvider: "vscode-lm" }],
		]),
		modeApiConfigs: { code: "profile-id", architect: "other-id" },
		migrations: {
			rateLimitSecondsMigrated: true,
			openAiHeadersMigrated: true,
			consecutiveMistakeLimitMigrated: true,
			todoListEnabledMigrated: true,
			claudeCodeLegacySettingsMigrated: true,
		},
	}
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((accept) => {
		resolve = accept
	})
	return { promise, resolve }
}

describe("ProviderSettingsManager persisted profile rename", () => {
	let stored: string
	let secrets: { get: ReturnType<typeof vi.fn>; store: ReturnType<typeof vi.fn> }
	let manager: ProviderSettingsManager

	beforeEach(async () => {
		stored = JSON.stringify(profileFixture())
		secrets = {
			get: vi.fn(async () => stored),
			store: vi.fn(async (_key: string, content: string) => {
				stored = content
			}),
		}
		manager = new ProviderSettingsManager({ secrets } as unknown as ExtensionContext)
		await manager.initialize()
		secrets.store.mockClear()
	})

	it("changes only the persisted name in one write and preserves settings, secrets, IDs and mode routes", async () => {
		const before = JSON.parse(stored)
		await expect(manager.renameProfile({ id: "profile-id" }, "renamed")).resolves.toMatchObject({
			id: "profile-id",
			oldName: "saved",
			newName: "renamed",
			isActive: true,
		})
		expect(secrets.store).toHaveBeenCalledOnce()
		expect(JSON.parse(stored)).toEqual({
			...before,
			currentApiConfigName: "renamed",
			apiConfigs: { renamed: savedProfile, other: before.apiConfigs.other },
		})
		expect(await manager.getProfile({ id: "profile-id" })).toEqual({ name: "renamed", ...savedProfile })
	})

	it("does not mutate the shared default fallback when the first rename write fails", async () => {
		secrets.get.mockResolvedValue(undefined)
		const before = await manager.getProfile({ name: "default" })
		secrets.store.mockRejectedValueOnce(new Error("private storage failure"))
		await expect(manager.renameProfile({ id: before.id! }, "renamed")).rejects.toMatchObject({ code: "saveFailed" })
		expect(await manager.getProfile({ name: "default" })).toEqual(before)
		await expect(manager.getProfile({ name: "renamed" })).rejects.toThrow("not found")
	})

	it("rejects a compensating rename when a newer rename owns the persisted name", async () => {
		await manager.renameProfile({ id: "profile-id" }, "renamed")
		await manager.renameProfile({ id: "profile-id" }, "newer")
		secrets.store.mockClear()
		await expect(
			manager.renameProfile({ id: "profile-id" }, "saved", { expectedName: "renamed" }),
		).rejects.toMatchObject({ code: "invalid" })
		expect((await manager.getProfile({ id: "profile-id" })).name).toBe("newer")
		expect(secrets.store).not.toHaveBeenCalled()
	})

	it("compensates only the name after a later explicit Save without restoring an old settings snapshot", async () => {
		await manager.renameProfile({ id: "profile-id" }, "renamed")
		await manager.saveConfig("renamed", {
			...savedProfile,
			apiProvider: "openai",
			openAiModelId: "newer-explicit-save",
			openAiApiKey: "newer-saved-test-key",
		})
		const latest = JSON.parse(stored).apiConfigs.renamed
		await manager.renameProfile({ id: "profile-id" }, "saved", { expectedName: "renamed" })
		expect(JSON.parse(stored).apiConfigs.saved).toEqual(latest)
	})

	it("renames an inactive legacy provider without activating it or filtering unknown settings", async () => {
		const legacy = { ...savedProfile, apiProvider: "future-provider", legacyApiKey: "legacy-test-key" }
		const fixture = profileFixture()
		stored = JSON.stringify({
			...fixture,
			currentApiConfigName: "other",
			apiConfigs: { ...fixture.apiConfigs, saved: legacy },
		})
		await expect(manager.renameProfile({ name: "saved" }, "renamed")).resolves.toMatchObject({ isActive: false })
		expect(JSON.parse(stored)).toMatchObject({ currentApiConfigName: "other", apiConfigs: { renamed: legacy } })
	})

	it.each(["other", "OTHER"])("rejects the existing destination %s without a write", async (newName) => {
		const before = stored
		await expect(manager.renameProfile({ id: "profile-id" }, newName)).rejects.toMatchObject({ code: "nameInUse" })
		expect(stored).toBe(before)
		expect(secrets.store).not.toHaveBeenCalled()
	})

	it("permits a case-only rename of the same profile and treats an unchanged name as an idempotent success", async () => {
		await manager.renameProfile({ id: "profile-id" }, "SAVED")
		await expect(manager.renameProfile({ id: "profile-id" }, "SAVED")).resolves.toMatchObject({
			oldName: "SAVED",
			newName: "SAVED",
		})
		expect(secrets.store).toHaveBeenCalledOnce()
	})

	it.each([{ id: "missing-id" }, { name: "missing-name" }])(
		"rejects a missing persisted profile %j without a write",
		async (target) => {
			const before = stored
			await expect(manager.renameProfile(target, "renamed")).rejects.toMatchObject({ code: "notFound" })
			expect(stored).toBe(before)
			expect(secrets.store).not.toHaveBeenCalled()
		},
	)

	it.each(["", "   "])("rejects an empty destination %j without a write", async (newName) => {
		await expect(manager.renameProfile({ id: "profile-id" }, newName)).rejects.toMatchObject({ code: "invalid" })
		expect(secrets.store).not.toHaveBeenCalled()
	})

	it.each(["__proto__", "constructor", "toString"])(
		"handles prototype-named destinations %s as persisted names",
		async (name) => {
			await manager.renameProfile({ id: "profile-id" }, name)
			expect(Object.hasOwn(JSON.parse(stored).apiConfigs, name)).toBe(true)
			expect(await manager.getProfile({ id: "profile-id" })).toEqual({ name, ...savedProfile })
			await manager.renameProfile({ name }, "restored")
			expect(JSON.parse(stored).apiConfigs.restored).toEqual(savedProfile)
		},
	)

	it("keeps the original profile when storage rejects and permits a later retry without leaking storage details", async () => {
		const before = stored
		secrets.store.mockRejectedValueOnce(new Error("private storage path and test-key"))
		await expect(manager.renameProfile({ id: "profile-id" }, "renamed")).rejects.toMatchObject({
			code: "saveFailed",
			message: "Failed to rename provider profile",
		})
		expect(stored).toBe(before)
		expect(await manager.getProfile({ id: "profile-id" })).toEqual({ name: "saved", ...savedProfile })
		await manager.renameProfile({ id: "profile-id" }, "renamed")
		expect(JSON.parse(stored).apiConfigs.renamed).toEqual(savedProfile)
	})

	it("serializes a rename after an explicit Save and reads the latest persisted values", async () => {
		const started = deferred()
		const complete = deferred()
		secrets.store.mockImplementationOnce(async (_key: string, content: string) => {
			started.resolve()
			await complete.promise
			stored = content
		})
		const save = manager.saveConfig("saved", {
			...savedProfile,
			apiProvider: "openai",
			openAiModelId: "explicit-save",
		})
		await started.promise
		const rename = manager.renameProfile({ id: "profile-id" }, "renamed")
		expect(secrets.store).toHaveBeenCalledOnce()
		complete.resolve()
		await save
		await rename
		expect(JSON.parse(stored).apiConfigs.renamed).toMatchObject({
			id: "profile-id",
			openAiModelId: "explicit-save",
			openAiApiKey: "saved-test-key",
		})
		expect(JSON.parse(stored).apiConfigs).not.toHaveProperty("saved")
	})

	it("serializes a sibling view rename behind another manager's Save on the same SecretStorage", async () => {
		const sibling = new ProviderSettingsManager({ secrets } as unknown as ExtensionContext)
		await sibling.initialize()
		const started = deferred()
		const complete = deferred()
		secrets.get.mockClear()
		secrets.store.mockClear()
		secrets.store.mockImplementationOnce(async (_key: string, content: string) => {
			started.resolve()
			await complete.promise
			stored = content
		})
		const save = manager.saveConfig("saved", {
			...savedProfile,
			apiProvider: "openai",
			openAiModelId: "sibling-explicit-save",
		})
		await started.promise
		const rename = sibling.renameProfile({ id: "profile-id" }, "renamed")
		let readCount: number
		try {
			// Drain the already-queued callbacks while the primary write remains held at the barrier.
			await Promise.resolve()
			await Promise.resolve()
			readCount = secrets.get.mock.calls.length
		} finally {
			complete.resolve()
		}
		await save
		await rename
		expect(readCount).toBe(1)
		expect(JSON.parse(stored).apiConfigs.renamed).toMatchObject({
			id: "profile-id",
			openAiModelId: "sibling-explicit-save",
			openAiApiKey: "saved-test-key",
		})
		expect(JSON.parse(stored).apiConfigs.other).toEqual(profileFixture().apiConfigs.other)
		expect(JSON.parse(stored).apiConfigs).not.toHaveProperty("saved")
	})

	describe("ID-targeted Save", () => {
		it.each([
			["string", "malformed-draft"],
			["array", []],
			["number", 42],
			["date", new Date("2026-10-11T00:00:00Z")],
			["null", null],
			["undefined", undefined],
			["boolean", true],
		])("rejects a malformed %s draft container before any profile write", async (_kind, draft) => {
			const before = stored
			await expect(
				manager.saveConfig({ id: "profile-id" }, draft as unknown as ProviderSettingsWithId),
			).rejects.toMatchObject({ code: "invalid" })
			expect(stored).toBe(before)
			expect(secrets.store).not.toHaveBeenCalled()
			expect(await manager.getProfile({ id: "profile-id" })).toMatchObject(savedProfile)
		})

		it("updates the latest canonical name atomically and keeps the target ID despite another profile's draft ID", async () => {
			await manager.renameProfile({ id: "profile-id" }, "renamed")
			secrets.store.mockClear()
			await expect(
				manager.saveConfig(
					{ id: "profile-id" },
					{
						...savedProfile,
						id: "other-id",
						apiProvider: "openai",
						openAiModelId: "explicit-save",
					},
				),
			).resolves.toEqual({ id: "profile-id", name: "renamed" })
			expect(secrets.store).toHaveBeenCalledOnce()
			expect(JSON.parse(stored).apiConfigs.renamed).toMatchObject({
				id: "profile-id",
				openAiModelId: "explicit-save",
			})
			expect(JSON.parse(stored).apiConfigs.other).toEqual(profileFixture().apiConfigs.other)
			expect(Object.keys(JSON.parse(stored).apiConfigs)).toEqual(["renamed", "other"])
			expect(JSON.parse(stored).modeApiConfigs).toEqual(profileFixture().modeApiConfigs)
		})

		it("rejects an unknown target without creating a profile or writing storage", async () => {
			const before = stored
			await expect(manager.saveConfig({ id: "missing-id" }, { apiProvider: "openai" })).rejects.toMatchObject({
				code: "notFound",
			})
			expect(stored).toBe(before)
			expect(secrets.store).not.toHaveBeenCalled()
		})

		it("rejects a deleted ID when its former name is now owned by another saved profile", async () => {
			await manager.deleteConfig("saved")
			await manager.saveConfig("saved", { id: "replacement-id", apiProvider: "vscode-lm" })
			secrets.store.mockClear()
			const before = stored
			await expect(
				manager.saveConfig({ id: "profile-id" }, { ...savedProfile, apiProvider: "openai" }),
			).rejects.toMatchObject({ code: "notFound" })
			expect(stored).toBe(before)
			expect(secrets.store).not.toHaveBeenCalled()
		})

		it("resolves the ID after an in-flight rename instead of updating the stale name", async () => {
			const started = deferred()
			const complete = deferred()
			secrets.store.mockImplementationOnce(async (_key: string, content: string) => {
				started.resolve()
				await complete.promise
				stored = content
			})
			const rename = manager.renameProfile({ id: "profile-id" }, "renamed")
			await started.promise
			const save = manager.saveConfig(
				{ id: "profile-id" },
				{
					...savedProfile,
					apiProvider: "openai",
					openAiModelId: "queued-save",
				},
			)
			complete.resolve()
			await rename
			await expect(save).resolves.toEqual({ id: "profile-id", name: "renamed" })
			expect(JSON.parse(stored).apiConfigs.renamed).toMatchObject({
				id: "profile-id",
				openAiModelId: "queued-save",
			})
			expect(JSON.parse(stored).apiConfigs).not.toHaveProperty("saved")
		})

		it("keeps the default fallback unchanged when a targeted Save fails in storage", async () => {
			secrets.get.mockResolvedValue(undefined)
			const before = await manager.getProfile({ name: "default" })
			secrets.store.mockRejectedValueOnce(new Error("private storage failure"))
			await expect(
				manager.saveConfig({ id: before.id! }, { apiProvider: "openai", openAiModelId: "failed-save" }),
			).rejects.toMatchObject({ code: "saveFailed", message: "Failed to save provider profile" })
			expect(await manager.getProfile({ name: "default" })).toEqual(before)
		})

		it("keeps legacy name creation, imported IDs and string results compatible", async () => {
			await expect(manager.saveConfig("created", { id: "imported-id", apiProvider: "vscode-lm" })).resolves.toBe(
				"imported-id",
			)
			await expect(manager.saveConfig("created", { apiProvider: "vscode-lm" })).resolves.toBe("imported-id")
			expect((await manager.getProfile({ name: "created" })).id).toBe("imported-id")
		})
	})
})
