import type { ExtensionContext } from "vscode"

import {
	curatedProviders,
	curatedProviderApiKeyFields,
	getProviderDefaultModelId,
	type ProviderSettings,
} from "@alpha-code/types"

import { ContextProxy } from "../ContextProxy"

describe("curated provider credential storage", () => {
	it.each(curatedProviders)("loads and writes %s credentials through SecretStorage only", async (apiProvider) => {
		const field = curatedProviderApiKeyFields[apiProvider]
		const state = new Map<string, unknown>([
			["apiProvider", apiProvider],
			["apiModelId", getProviderDefaultModelId(apiProvider)],
		])
		const secrets = new Map<string, string>([[field, "saved-test-secret"]])
		const globalState = {
			get: vi.fn((key: string) => state.get(key)),
			update: vi.fn(async (key: string, value: unknown) => {
				state.set(key, value)
			}),
		}
		const secretStorage = {
			get: vi.fn(async (key: string) => secrets.get(key)),
			store: vi.fn(async (key: string, value: string) => {
				secrets.set(key, value)
			}),
			delete: vi.fn(async (key: string) => {
				secrets.delete(key)
			}),
		}
		const context = { globalState, secrets: secretStorage } as unknown as ExtensionContext
		const proxy = new ContextProxy(context)
		await proxy.initialize()
		expect(proxy.getProviderSettings()[field]).toBe("saved-test-secret")
		expect(globalState.get).not.toHaveBeenCalledWith(field)

		const config: ProviderSettings = {
			apiProvider,
			apiModelId: getProviderDefaultModelId(apiProvider),
			[field]: "updated-test-secret",
		}
		await proxy.setProviderSettings(config)
		expect(secretStorage.store).toHaveBeenCalledWith(field, "updated-test-secret")
		expect(globalState.update).not.toHaveBeenCalledWith(field, expect.anything())
		expect(await proxy.export()).not.toHaveProperty(field)

		const reopened = new ContextProxy(context)
		await reopened.initialize()
		expect(reopened.getProviderSettings()).toMatchObject(config)
	})
})
