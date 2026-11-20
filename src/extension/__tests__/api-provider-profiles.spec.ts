import type { ProviderSettings } from "@alpha-code/types"
import type * as vscode from "vscode"
import {
	ProviderSettingsManager,
	type ProviderProfileCreateTarget,
	type ProviderProfileSaveTarget,
} from "../../core/config/ProviderSettingsManager"
import type { AlphaProvider } from "../../core/webview/AlphaProvider"
import { API } from "../api"

vi.mock("../../core/webview/AlphaProvider", () => ({ AlphaProvider: vi.fn() }))
vi.mock("../../activate/registerCommands", () => ({ openAlphaInNewTab: vi.fn() }))

const original: ProviderSettings = { apiProvider: "openai", openAiModelId: "original" }
const other: ProviderSettings = { apiProvider: "openai", openAiModelId: "other" }

async function fixture() {
	let content: string | undefined
	const context = {
		subscriptions: [],
		secrets: {
			get: vi.fn(async () => content),
			store: vi.fn(async (_key: string, value: string) => {
				content = value
			}),
		},
	} as unknown as vscode.ExtensionContext
	const manager = new ProviderSettingsManager(context)
	await manager.initialize()
	const id = await manager.saveConfig("saved", original)
	const entries = await manager.listConfig()
	const provider = {
		context,
		on: vi.fn(),
		getProviderProfileEntry: (name: string) => entries.find((entry) => entry.name === name),
		upsertProviderProfile: (
			target: string | ProviderProfileCreateTarget | ProviderProfileSaveTarget,
			profile: ProviderSettings,
		) => (typeof target === "string" ? manager.saveConfig(target, profile) : manager.saveConfig(target, profile)),
	} as unknown as AlphaProvider
	const api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider)
	return { api, manager, id }
}

describe("provider profile API identity", () => {
	it("accepts only one concurrent creation of the same name", async () => {
		const { api, manager } = await fixture()
		const [first, duplicate] = await Promise.allSettled([
			api.createProfile("new", original, false),
			api.createProfile("new", other, false),
		])

		expect(first).toMatchObject({ status: "fulfilled", value: expect.any(String) })
		expect(duplicate).toMatchObject({
			status: "rejected",
			reason: new Error('Profile with name "new" already exists'),
		})
		expect(await manager.getProfile({ name: "new" })).toMatchObject(original)
	})

	it("cannot recreate the old name after a rename queued first", async () => {
		const { api, manager, id } = await fixture()
		const rename = manager.renameProfile({ id }, "renamed")
		const update = api.updateProfile("saved", other, false)

		await Promise.all([rename, expect(update).rejects.toThrow('Profile with name "saved" does not exist')])
		expect(await manager.getProfile({ name: "renamed" })).toMatchObject({ id, ...original })
		expect((await manager.listConfig()).map(({ name }) => name)).not.toContain("saved")
	})

	it("cannot update a replacement that reused the removed profile name", async () => {
		const { api, manager } = await fixture()
		await manager.deleteConfig("saved")
		const replacementId = await manager.saveConfig("saved", original)

		await expect(api.updateProfile("saved", other, false)).rejects.toThrow(
			'Profile with name "saved" does not exist',
		)
		expect(await manager.getProfile({ name: "saved" })).toMatchObject({ id: replacementId, ...original })
	})

	it("returns the original identity for a successful update", async () => {
		const { api, manager, id } = await fixture()

		await expect(api.updateProfile("saved", other, false)).resolves.toBe(id)
		expect(await manager.getProfile({ name: "saved" })).toMatchObject({ id, ...other })
	})
})
