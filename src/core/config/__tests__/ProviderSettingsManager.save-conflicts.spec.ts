import type { ExtensionContext } from "vscode"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { ProviderProfileSaveError, ProviderSettingsManager } from "../ProviderSettingsManager"
import * as atomicWrite from "../../task-persistence/atomicWrite"

describe("ProviderSettingsManager save conflicts", () => {
	let stored: string
	let secrets: { get: ReturnType<typeof vi.fn>; store: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }
	let manager: ProviderSettingsManager
	const profile = { id: "profile-id", apiProvider: "openai" as const, openAiModelId: "model", openAiApiKey: "key" }

	async function withFence(run: (manager: ProviderSettingsManager, fencePath: string) => Promise<void>) {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-provider-fence-"))
		const fencePath = path.join(directory, "provider-profiles")
		try {
			const fenced = new ProviderSettingsManager({
				secrets,
				globalStorageUri: { fsPath: directory },
			} as unknown as ExtensionContext)
			await fenced.initialize()
			await run(fenced, fencePath)
		} finally {
			await fs.rm(fencePath, { force: true })
			await fs.rmdir(directory)
		}
	}

	beforeEach(async () => {
		stored = JSON.stringify({
			currentApiConfigName: "saved",
			apiConfigs: { saved: profile, other: { id: "other-id", apiProvider: "vscode-lm" } },
			migrations: {
				rateLimitSecondsMigrated: true,
				openAiHeadersMigrated: true,
				consecutiveMistakeLimitMigrated: true,
				todoListEnabledMigrated: true,
				claudeCodeLegacySettingsMigrated: true,
				legacyStorageMigrated: true,
			},
		})
		secrets = {
			get: vi.fn(async () => stored),
			store: vi.fn(async (_key: string, value: string) => {
				stored = value
			}),
			delete: vi.fn(async (key: string) => {
				if (key === "alpha_config_api_config") stored = ""
			}),
		}
		manager = new ProviderSettingsManager({ secrets } as unknown as ExtensionContext)
		await manager.initialize()
		secrets.store.mockClear()
	})

	it("rejects a second independent edit buffer inside the shared storage lock", async () => {
		const first = (await manager.listConfig())[0]
		const second = (await manager.listConfig())[0]
		const sibling = new ProviderSettingsManager({ secrets } as unknown as ExtensionContext)
		const writes = await Promise.allSettled([
			manager.saveConfig(
				{ id: first.id, expectedVersion: first.version },
				{ ...profile, openAiModelId: "new-model" },
			),
			sibling.saveConfig(
				{ id: second.id, expectedVersion: second.version },
				{ ...profile, openAiApiKey: "new-key" },
			),
		])
		expect(writes[0].status).toBe("fulfilled")
		expect(writes[1]).toMatchObject({ status: "rejected", reason: { code: "conflict" } })
		expect(JSON.parse(stored).apiConfigs.saved).toMatchObject({ openAiModelId: "new-model", openAiApiKey: "key" })
		expect(secrets.store).toHaveBeenCalledOnce()
	})

	it("serializes saves across separate secret wrappers sharing the extension's global storage", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-provider-lock-"))
		const wrapper = () => ({
			get: vi.fn(async () => stored),
			store: vi.fn(async (_key: string, value: string) => {
				stored = value
			}),
		})
		const firstSecrets = wrapper()
		const secondSecrets = wrapper()
		try {
			const first = new ProviderSettingsManager({
				secrets: firstSecrets,
				globalStorageUri: { fsPath: directory },
			} as unknown as ExtensionContext)
			const second = new ProviderSettingsManager({
				secrets: secondSecrets,
				globalStorageUri: { fsPath: directory },
			} as unknown as ExtensionContext)
			await Promise.all([first.initialize(), second.initialize()])
			const snapshot = await first.getProfileSnapshot({ id: profile.id })
			firstSecrets.store.mockClear()
			secondSecrets.store.mockClear()
			const writes = await Promise.allSettled([
				first.saveConfig(
					{ id: profile.id, expectedVersion: snapshot.version },
					{ ...profile, openAiModelId: "first-model" },
				),
				second.saveConfig(
					{ id: profile.id, expectedVersion: snapshot.version },
					{ ...profile, openAiApiKey: "second-key" },
				),
			])
			expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
			expect(writes.find((result) => result.status === "rejected")).toMatchObject({
				reason: { code: "conflict" },
			})
			expect(firstSecrets.store.mock.calls.length + secondSecrets.store.mock.calls.length).toBe(1)
		} finally {
			await fs.rm(path.join(directory, "provider-profiles"), { force: true })
			await fs.rmdir(directory)
		}
	})

	it("does not write or fall back unlocked when the shared storage lease fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-provider-lock-"))
		try {
			const locked = new ProviderSettingsManager({
				secrets,
				globalStorageUri: { fsPath: directory },
			} as unknown as ExtensionContext)
			await locked.initialize()
			const snapshot = await locked.getProfileSnapshot({ id: profile.id })
			const before = stored
			secrets.store.mockClear()
			const lease = vi.spyOn(atomicWrite, "withFileLock").mockRejectedValueOnce(new Error("lease unavailable"))
			try {
				await expect(
					locked.saveConfig(
						{ id: profile.id, expectedVersion: snapshot.version },
						{ ...profile, openAiModelId: "draft" },
					),
				).rejects.toMatchObject({ code: "saveFailed" })
				expect(stored).toBe(before)
				expect(secrets.store).not.toHaveBeenCalled()
			} finally {
				lease.mockRestore()
			}
			await expect(
				locked.saveConfig({ id: profile.id, expectedVersion: snapshot.version }, profile),
			).resolves.toMatchObject({ id: profile.id })
		} finally {
			await fs.rm(path.join(directory, "provider-profiles"), { force: true })
			await fs.rmdir(directory)
		}
	})

	it("rejects a stale window cache after another window commits, then admits a fresh synchronized snapshot", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-provider-lock-"))
		let firstCache = stored
		let secondCache = stored
		const firstSecrets = {
			get: vi.fn(async () => firstCache),
			store: vi.fn(async (_key: string, value: string) => {
				firstCache = stored = value
			}),
		}
		const secondSecrets = {
			get: vi.fn(async () => secondCache),
			store: vi.fn(async (_key: string, value: string) => {
				secondCache = stored = value
			}),
		}
		try {
			const first = new ProviderSettingsManager({
				secrets: firstSecrets,
				globalStorageUri: { fsPath: directory },
			} as unknown as ExtensionContext)
			const second = new ProviderSettingsManager({
				secrets: secondSecrets,
				globalStorageUri: { fsPath: directory },
			} as unknown as ExtensionContext)
			await Promise.all([first.initialize(), second.initialize()])
			const snapshot = await first.getProfileSnapshot({ id: profile.id })
			await first.saveConfig(
				{ id: profile.id, expectedVersion: snapshot.version },
				{ ...profile, openAiModelId: "first-model" },
			)
			await expect(
				second.saveConfig(
					{ id: profile.id, expectedVersion: snapshot.version },
					{ ...profile, openAiApiKey: "second-key" },
				),
			).rejects.toMatchObject({ code: "saveFailed" })
			expect(secondSecrets.store).not.toHaveBeenCalled()
			await expect(second.getProfileSnapshot({ id: profile.id })).rejects.toThrow("synchronized")
			secondCache = stored
			const fresh = await second.getProfileSnapshot({ id: profile.id })
			await second.saveConfig(
				{ id: fresh.id, expectedVersion: fresh.version },
				{ ...fresh.configuration, openAiApiKey: "second-key" },
			)
			expect(JSON.parse(stored).apiConfigs.saved).toMatchObject({
				openAiModelId: "first-model",
				openAiApiKey: "second-key",
			})
		} finally {
			await fs.rm(path.join(directory, "provider-profiles"), { force: true })
			await fs.rmdir(directory)
		}
	})

	it("bootstraps one bounded hash-only receipt for old saved data without changing secrets", async () => {
		await withFence(async (fenced, file) => {
			const before = stored
			const content = await fs.readFile(file, "utf8")
			expect(Buffer.byteLength(content)).toBeLessThan(1024)
			expect(JSON.parse(content)).toEqual({
				format: 1,
				state: "committed",
				hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			})
			expect(content).not.toContain("openAiApiKey")
			await fenced.getProfileSnapshot({ id: profile.id })
			expect(stored).toBe(before)
		})
	})

	it("updates its receipt during an explicit user-requested reset and admits the empty bootstrap profile", async () => {
		await withFence(async (fenced, file) => {
			await fenced.resetAllConfigs()
			expect(stored).toBe("")
			expect(JSON.parse(await fs.readFile(file, "utf8")).state).toBe("committed")
			expect(await fenced.getProfileSnapshot({ name: "default" })).toMatchObject({
				id: "default",
				configuration: {},
			})
		})
	})

	it("restores the previous receipt after a rejected secret write and permits the same draft retry", async () => {
		await withFence(async (fenced, file) => {
			const snapshot = await fenced.getProfileSnapshot({ id: profile.id })
			const before = stored
			const receipt = await fs.readFile(file, "utf8")
			secrets.store.mockRejectedValueOnce(new Error("storage rejected"))
			await expect(
				fenced.saveConfig(
					{ id: profile.id, expectedVersion: snapshot.version },
					{ ...profile, openAiModelId: "draft" },
				),
			).rejects.toMatchObject({ code: "saveFailed" })
			expect(stored).toBe(before)
			expect(await fs.readFile(file, "utf8")).toBe(receipt)
			await expect(
				fenced.saveConfig(
					{ id: profile.id, expectedVersion: snapshot.version },
					{ ...profile, openAiModelId: "draft" },
				),
			).resolves.toMatchObject({ id: profile.id })
		})
	})

	it("keeps acceptance evidence when the secret API rejects after applying the intended contents", async () => {
		await withFence(async (fenced, file) => {
			const snapshot = await fenced.getProfileSnapshot({ id: profile.id })
			secrets.store.mockImplementationOnce(async (_key: string, content: string) => {
				stored = content
				throw new Error("accepted write lost its acknowledgement")
			})
			await expect(
				fenced.saveConfig(
					{ id: profile.id, expectedVersion: snapshot.version },
					{ ...profile, openAiModelId: "accepted" },
				),
			).rejects.toMatchObject({
				code: "applyFailed",
				saved: { id: profile.id, name: "saved", version: expect.any(String) },
			})
			expect(JSON.parse(await fs.readFile(file, "utf8")).state).toBe("prepared")
			secrets.store.mockClear()
			expect((await fenced.getProfileSnapshot({ id: profile.id })).configuration.openAiModelId).toBe("accepted")
			expect(secrets.store).not.toHaveBeenCalled()
		})
	})

	it("retains an uncertain prepared receipt when rejected-write readback also fails", async () => {
		await withFence(async (fenced, file) => {
			const snapshot = await fenced.getProfileSnapshot({ id: profile.id })
			const before = stored
			secrets.store.mockImplementationOnce(async () => {
				secrets.get.mockRejectedValueOnce(new Error("readback unavailable"))
				throw new Error("write rejected")
			})
			await expect(
				fenced.saveConfig(
					{ id: profile.id, expectedVersion: snapshot.version },
					{ ...profile, openAiModelId: "draft" },
				),
			).rejects.toMatchObject({ code: "saveFailed" })
			expect(stored).toBe(before)
			expect(JSON.parse(await fs.readFile(file, "utf8")).state).toBe("prepared")
			await expect(fenced.getProfileSnapshot({ id: profile.id })).rejects.toThrow("pending")
		})
	})

	it.each(["create", "update"] as const)(
		"retains a safe %s receipt after final stamp failure and reconciles without replaying secrets",
		async (operation) => {
			await withFence(async (fenced, file) => {
				const snapshot = await fenced.getProfileSnapshot({ id: profile.id })
				const originalWrite = atomicWrite.atomicWriteText
				let prepared = false
				const write = vi
					.spyOn(atomicWrite, "atomicWriteText")
					.mockImplementation(async (target, content, options) => {
						const stamp = JSON.parse(content)
						if (stamp.state === "prepared") prepared = true
						else if (prepared) throw new Error("final stamp rejected")
						return originalWrite(target, content, options)
					})
				const draft = { ...profile, openAiModelId: "committed-draft" }
				let failure: unknown
				try {
					await fenced.saveConfig(
						operation === "create"
							? { name: "created", createOnly: true }
							: { id: profile.id, expectedVersion: snapshot.version },
						draft,
					)
				} catch (error) {
					failure = error
				} finally {
					write.mockRestore()
				}
				if (!(failure instanceof ProviderProfileSaveError) || !failure.saved)
					throw new Error("Missing committed receipt")
				expect(failure.code).toBe("applyFailed")
				expect(JSON.parse(await fs.readFile(file, "utf8")).state).toBe("prepared")
				secrets.store.mockClear()
				const fresh = await fenced.getProfileSnapshot({ id: failure.saved.id })
				expect(fresh.version).toBe(failure.saved.version)
				expect(secrets.store).not.toHaveBeenCalled()
				expect(JSON.parse(await fs.readFile(file, "utf8")).state).toBe("committed")
				await expect(
					fenced.saveConfig({ id: fresh.id, expectedVersion: fresh.version }, fresh.configuration),
				).resolves.toMatchObject({ id: fresh.id })
			})
		},
	)

	it("does not authorize a secret write when preparing its receipt fails", async () => {
		await withFence(async (fenced, file) => {
			const snapshot = await fenced.getProfileSnapshot({ id: profile.id })
			const receipt = await fs.readFile(file, "utf8")
			const write = vi.spyOn(atomicWrite, "atomicWriteText").mockRejectedValueOnce(new Error("prepare rejected"))
			secrets.store.mockClear()
			try {
				await expect(
					fenced.saveConfig({ id: profile.id, expectedVersion: snapshot.version }, profile),
				).rejects.toMatchObject({ code: "saveFailed" })
				expect(secrets.store).not.toHaveBeenCalled()
				expect(await fs.readFile(file, "utf8")).toBe(receipt)
			} finally {
				write.mockRestore()
			}
		})
	})

	it.each(["corrupt", "oversized", "unknown-prepared"] as const)(
		"preserves data and refuses writes for a %s receipt",
		async (kind) => {
			await withFence(async (fenced, file) => {
				const previous = JSON.parse(await fs.readFile(file, "utf8")).hash
				const receipt =
					kind === "corrupt"
						? "malformed"
						: kind === "oversized"
							? "x".repeat(1025)
							: JSON.stringify({
									format: 1,
									state: "prepared",
									previousHash: previous,
									nextHash: `sha256:${"f".repeat(64)}`,
								})
				await fs.writeFile(file, receipt)
				const before = stored
				secrets.store.mockClear()
				await expect(fenced.getProfileSnapshot({ id: profile.id })).rejects.toThrow(
					kind === "unknown-prepared" ? "pending" : "receipt",
				)
				await expect(fenced.saveConfig({ id: profile.id }, profile)).rejects.toMatchObject({
					code: "saveFailed",
				})
				expect(stored).toBe(before)
				expect(secrets.store).not.toHaveBeenCalled()
				expect(await fs.readFile(file, "utf8")).toBe(receipt)
			})
		},
	)

	it("pairs editor configuration and version from one persisted read after an inactive save", async () => {
		await manager.saveConfig("saved", { ...profile, openAiBaseUrl: "https://new.example/v1" })
		const snapshot = await manager.getProfileSnapshot({ id: profile.id })
		expect(snapshot).toMatchObject({
			id: profile.id,
			name: "saved",
			configuration: { openAiBaseUrl: "https://new.example/v1" },
		})
		await expect(
			manager.saveConfig(
				{ id: snapshot.id, expectedVersion: snapshot.version },
				{ ...snapshot.configuration, openAiModelId: "edited-model" },
			),
		).resolves.toMatchObject({ id: profile.id })
		expect(JSON.parse(stored).apiConfigs.saved).toMatchObject({
			openAiBaseUrl: "https://new.example/v1",
			openAiModelId: "edited-model",
		})
	})

	it("uses one storage read for a snapshot and keeps its base stale when storage changes afterward", async () => {
		const expectedVersion = (await manager.listConfig())[0].version
		secrets.get.mockClear()
		secrets.get.mockImplementationOnce(async () => {
			const captured = stored
			const changed = JSON.parse(stored)
			changed.apiConfigs.saved.openAiApiKey = "external-key"
			stored = JSON.stringify(changed)
			return captured
		})
		const snapshot = await manager.getProfileSnapshot({ name: "saved" })
		expect(secrets.get).toHaveBeenCalledOnce()
		expect(snapshot.configuration.openAiApiKey).toBe("key")
		expect(snapshot.version).toBe(expectedVersion)
		await expect(
			manager.saveConfig({ id: snapshot.id, expectedVersion: snapshot.version }, snapshot.configuration),
		).rejects.toMatchObject({ code: "conflict" })
	})

	it("returns the committed content version and leaves the previous base stale", async () => {
		const { id, version } = (await manager.listConfig())[0]
		const saved = await manager.saveConfig({ id, expectedVersion: version }, { ...profile, openAiModelId: "new" })
		expect(saved.version).toMatch(/^sha256:[a-f0-9]{64}$/)
		expect(saved.version).not.toBe(version)
		expect((await manager.listConfig())[0].version).toBe(saved.version)
		await expect(manager.saveConfig({ id, expectedVersion: version }, profile)).rejects.toMatchObject({
			code: "conflict",
		})
	})

	it("keeps versions stable across renames and unrelated profile writes", async () => {
		const { id, version } = (await manager.listConfig())[0]
		await manager.renameProfile({ id }, "renamed")
		await manager.saveConfig("other", { apiProvider: "vscode-lm", vsCodeLmModelSelector: { id: "other-model" } })
		expect((await manager.listConfig()).find((entry) => entry.id === id)?.version).toBe(version)
		await expect(
			manager.saveConfig({ id, expectedVersion: version }, { ...profile, openAiModelId: "new" }),
		).resolves.toMatchObject({ id, name: "renamed", version: expect.any(String) })
		expect(JSON.parse(stored).apiConfigs).not.toHaveProperty("saved")
	})

	it("accepts content ABA only when the current persisted profile exactly matches the captured base", async () => {
		const { id, version } = (await manager.listConfig())[0]
		await manager.saveConfig({ id }, { ...profile, openAiModelId: "intermediate" })
		await manager.saveConfig({ id }, profile)
		expect((await manager.listConfig())[0].version).toBe(version)
		await expect(
			manager.saveConfig({ id, expectedVersion: version }, { ...profile, openAiApiKey: "new-key" }),
		).resolves.toMatchObject({ id, name: "saved" })
	})

	it("rejects a deleted identity even when its old name is reused", async () => {
		const { id, version } = (await manager.listConfig())[0]
		await manager.deleteConfig("saved")
		await manager.saveConfig("saved", { ...profile, id: "replacement-id" })
		await expect(manager.saveConfig({ id, expectedVersion: version }, profile)).rejects.toMatchObject({
			code: "notFound",
		})
		expect(JSON.parse(stored).apiConfigs.saved.id).toBe("replacement-id")
	})

	it("does not consume the expected version when persistence fails", async () => {
		const { id, version } = (await manager.listConfig())[0]
		const before = stored
		secrets.store.mockRejectedValueOnce(new Error("storage unavailable"))
		await expect(
			manager.saveConfig({ id, expectedVersion: version }, { ...profile, openAiModelId: "new" }),
		).rejects.toMatchObject({ code: "saveFailed" })
		expect(stored).toBe(before)
		await expect(
			manager.saveConfig({ id, expectedVersion: version }, { ...profile, openAiModelId: "new" }),
		).resolves.toMatchObject({ id, version: expect.any(String) })
	})

	it("rejects malformed preconditions without writing or exposing stored data", async () => {
		const before = stored
		await expect(manager.saveConfig({ id: profile.id, expectedVersion: "invalid" }, profile)).rejects.toMatchObject(
			{ code: "invalid", message: "Failed to save provider profile" },
		)
		expect(stored).toBe(before)
		expect(secrets.store).not.toHaveBeenCalled()
	})

	it.each(["future-provider", "ollama"])(
		"includes preserved %s fields in the content identity",
		async (apiProvider) => {
			const preserved = { ...profile, apiProvider, unknownProviderSetting: { nested: "old" } }
			const profiles = JSON.parse(stored)
			profiles.apiConfigs.saved = preserved
			stored = JSON.stringify(profiles)
			const { id, version } = (await manager.listConfig())[0]
			expect(await manager.getProfileSnapshot({ id })).toMatchObject({
				version,
				configuration: { apiProvider, unknownProviderSetting: { nested: "old" } },
			})
			profiles.apiConfigs.saved.unknownProviderSetting.nested = "external"
			stored = JSON.stringify(profiles)
			await expect(manager.saveConfig({ id, expectedVersion: version }, profile)).rejects.toMatchObject({
				code: "conflict",
			})
			expect(JSON.parse(stored).apiConfigs.saved.unknownProviderSetting.nested).toBe("external")
			expect(secrets.store).not.toHaveBeenCalled()
		},
	)

	it("creates at most one profile across independent views and returns its atomic content base", async () => {
		const sibling = new ProviderSettingsManager({ secrets } as unknown as ExtensionContext)
		const writes = await Promise.allSettled([
			manager.saveConfig({ name: "new", createOnly: true }, { apiProvider: "openai", openAiModelId: "first" }),
			sibling.saveConfig({ name: "new", createOnly: true }, { apiProvider: "openai", openAiModelId: "second" }),
		])
		expect(writes[0]).toMatchObject({ status: "fulfilled", value: { name: "new", version: expect.any(String) } })
		expect(writes[1]).toMatchObject({ status: "rejected", reason: { code: "conflict" } })
		const saved = (await manager.listConfig()).find((entry) => entry.name === "new")!
		if (writes[0].status === "fulfilled") expect(saved.version).toBe(writes[0].value.version)
		expect(JSON.parse(stored).apiConfigs.new.openAiModelId).toBe("first")
		expect(secrets.store).toHaveBeenCalledOnce()
	})

	it("cannot create over an existing saved identity or use a draft ID for new creation", async () => {
		await expect(manager.saveConfig({ name: "saved", createOnly: true }, profile)).rejects.toMatchObject({
			code: "conflict",
		})
		expect(secrets.store).not.toHaveBeenCalled()
		const saved = await manager.saveConfig({ name: "new", createOnly: true }, profile)
		expect(saved.id).not.toBe(profile.id)
		expect(saved.version).toBe((await manager.listConfig()).find(({ id }) => id === saved.id)?.version)
	})

	it("treats object field ordering as the same persisted content", async () => {
		const { id, version } = (await manager.listConfig())[0]
		const profiles = JSON.parse(stored)
		profiles.apiConfigs.saved = Object.fromEntries(Object.entries(profile).reverse())
		stored = JSON.stringify(profiles)
		expect((await manager.listConfig())[0].version).toBe(version)
		await expect(manager.saveConfig({ id, expectedVersion: version }, profile)).resolves.toMatchObject({ id })
	})
})
