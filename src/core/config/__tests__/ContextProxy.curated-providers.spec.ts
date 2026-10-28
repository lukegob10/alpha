import type { ExtensionContext } from "vscode"

import {
	curatedProviders,
	curatedProviderApiKeyFields,
	getProviderDefaultModelId,
	type ProviderSettings,
} from "@alpha-code/types"

import { ContextProxy } from "../ContextProxy"

function contextFor(settings: ProviderSettings, initialSecrets: [string, string][] = []) {
	const state = new Map<string, unknown>(Object.entries(settings))
	const secrets = new Map<string, string>(initialSecrets)
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
	return { context, globalState, secretStorage, secrets }
}

const apiKeyCases = curatedProviders.flatMap((apiProvider) => {
	const field = curatedProviderApiKeyFields[apiProvider]
	return field ? [{ apiProvider, field }] : []
})
const awsCredentialCases = (["awsAccessKey", "awsSecretKey", "awsSessionToken", "awsApiKey"] as const).map((field) => ({
	apiProvider: "bedrock" as const,
	field,
}))

describe("curated provider credential storage", () => {
	it.each([...apiKeyCases, ...awsCredentialCases])(
		"loads and writes $apiProvider $field through SecretStorage only",
		async ({ apiProvider, field }) => {
			const settings: ProviderSettings = { apiProvider, apiModelId: getProviderDefaultModelId(apiProvider) }
			const { context, globalState, secretStorage } = contextFor(settings, [[field, "saved-test-secret"]])
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
		},
	)

	it.each(["openai-codex", "bedrock"] as const)(
		"keeps %s model setup usable without borrowing profile credentials or reading OAuth tokens",
		async (apiProvider) => {
			const settings: ProviderSettings = { apiProvider, apiModelId: getProviderDefaultModelId(apiProvider) }
			const accountSecret = "alpha.chatgpt.registrations.v1"
			const accountTokens = JSON.stringify({
				accessToken: "service-access-token",
				refreshToken: "service-refresh-token",
			})
			const { context, globalState, secretStorage, secrets } = contextFor(settings, [
				[accountSecret, accountTokens],
			])
			const proxy = new ContextProxy(context)
			await proxy.initialize()
			await proxy.setProviderSettings(settings)
			expect(proxy.getProviderSettings()).toMatchObject(settings)
			expect(secretStorage.get).not.toHaveBeenCalledWith(accountSecret)
			expect(secretStorage.store).not.toHaveBeenCalledWith(accountSecret, expect.anything())
			expect(secrets.get(accountSecret)).toBe(accountTokens)
			expect(JSON.stringify(await proxy.export())).not.toContain("service-access-token")
			expect(JSON.stringify(proxy.getProviderSettings())).not.toContain("service-refresh-token")
			expect(globalState.update).not.toHaveBeenCalledWith("accessToken", expect.anything())
			const reopened = new ContextProxy(context)
			await reopened.initialize()
			expect(reopened.getProviderSettings()).toMatchObject(settings)
		},
	)
})
