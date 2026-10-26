import type { ExtensionContext } from "vscode"

import { ContextProxy } from "../ContextProxy"

const credentialKey = "vertexJsonCredentials"
const legacyCredentials = JSON.stringify({ type: "service_account", private_key: "fixture-private-key" })

function createStorage(legacy?: string, secret?: string) {
	const globalState = new Map<string, unknown>([["apiProvider", "vertex"]])
	const secrets = new Map<string, string>()
	if (legacy !== undefined) globalState.set(credentialKey, legacy)
	if (secret !== undefined) secrets.set(credentialKey, secret)
	const update = vi.fn(async (key: string, value: unknown) => {
		if (value === undefined) globalState.delete(key)
		else globalState.set(key, value)
	})
	const getSecret = vi.fn(async (key: string) => secrets.get(key))
	const storeSecret = vi.fn(async (key: string, value: string) => {
		secrets.set(key, value)
	})
	const deleteSecret = vi.fn(async (key: string) => {
		secrets.delete(key)
	})
	const context = {
		globalState: { get: (key: string) => globalState.get(key), update },
		secrets: { get: getSecret, store: storeSecret, delete: deleteSecret },
	} as unknown as ExtensionContext
	return { context, globalState, secrets, update, getSecret, storeSecret, deleteSecret }
}

describe("Vertex credential SecretStorage migration", () => {
	it("stores legacy credentials before removing plaintext and preserves provider reads and saved profiles", async () => {
		const storage = createStorage(legacyCredentials)
		const savedProfiles = JSON.stringify({ apiConfigs: { saved: { vertexJsonCredentials: legacyCredentials } } })
		storage.secrets.set("roo_cline_config_api_config", savedProfiles)
		let release!: () => void
		let enter!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		storage.storeSecret.mockImplementationOnce(async (key, value) => {
			enter()
			await held
			storage.secrets.set(key, value)
		})
		const proxy = new ContextProxy(storage.context)
		const initialization = proxy.initialize()
		await entered
		try {
			expect(storage.globalState.get(credentialKey)).toBe(legacyCredentials)
			expect(storage.update).not.toHaveBeenCalledWith(credentialKey, undefined)
		} finally {
			release()
		}
		await initialization

		expect(storage.secrets.get(credentialKey)).toBe(legacyCredentials)
		expect(storage.globalState.has(credentialKey)).toBe(false)
		expect(proxy.getValue(credentialKey)).toBe(legacyCredentials)
		expect(proxy.getProviderSettings().vertexJsonCredentials).toBe(legacyCredentials)
		expect(storage.secrets.get("roo_cline_config_api_config")).toBe(savedProfiles)
		await new ContextProxy(storage.context).initialize()
		expect(storage.storeSecret).toHaveBeenCalledOnce()
	})

	it.each(["newer-service-account", ""])("prefers the existing secret %j to the legacy value", async (secret) => {
		const storage = createStorage(legacyCredentials, secret)
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(proxy.getValue(credentialKey)).toBe(secret)
		expect(storage.secrets.get(credentialKey)).toBe(secret)
		expect(storage.globalState.has(credentialKey)).toBe(false)
		expect(storage.storeSecret).not.toHaveBeenCalled()
	})

	it("serializes migration with a concurrent credential edit", async () => {
		const storage = createStorage(legacyCredentials)
		let release!: () => void
		let enter!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		storage.storeSecret.mockImplementationOnce(async (key, value) => {
			enter()
			await held
			storage.secrets.set(key, value)
		})
		const proxy = new ContextProxy(storage.context)
		const initialization = proxy.initialize()
		await entered
		const saving = proxy.setValue(credentialKey, "edited-service-account")
		release()
		await Promise.all([initialization, saving])

		expect(proxy.getValue(credentialKey)).toBe("edited-service-account")
		expect(storage.secrets.get(credentialKey)).toBe("edited-service-account")
		expect(storage.globalState.has(credentialKey)).toBe(false)
	})

	it("retains working legacy credentials after a failed store and retries during refresh", async () => {
		const storage = createStorage(legacyCredentials)
		storage.storeSecret.mockRejectedValueOnce(new Error("SecretStorage unavailable"))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(proxy.getValue(credentialKey)).toBe(legacyCredentials)
		expect(storage.globalState.get(credentialKey)).toBe(legacyCredentials)
		expect(storage.secrets.has(credentialKey)).toBe(false)
		await proxy.refreshSecrets()
		expect(storage.secrets.get(credentialKey)).toBe(legacyCredentials)
		expect(storage.globalState.has(credentialKey)).toBe(false)
		expect(proxy.getProviderSettings().vertexJsonCredentials).toBe(legacyCredentials)
	})

	it("does not overwrite an unreadable existing secret with legacy credentials", async () => {
		const storage = createStorage(legacyCredentials, "newer-service-account")
		storage.getSecret.mockImplementation(async (key) => {
			if (key === credentialKey) throw new Error("SecretStorage unavailable")
			return storage.secrets.get(key)
		})
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(proxy.getValue(credentialKey)).toBe(legacyCredentials)
		expect(storage.secrets.get(credentialKey)).toBe("newer-service-account")
		expect(storage.globalState.get(credentialKey)).toBe(legacyCredentials)
		expect(storage.storeSecret).not.toHaveBeenCalled()
		storage.getSecret.mockImplementation(async (key) => storage.secrets.get(key))
		await proxy.refreshSecrets()
		expect(proxy.getValue(credentialKey)).toBe("newer-service-account")
		expect(storage.globalState.has(credentialKey)).toBe(false)
	})

	it("retries failed plaintext cleanup without overwriting the stored secret", async () => {
		const storage = createStorage(legacyCredentials)
		storage.update.mockRejectedValueOnce(new Error("global state unavailable"))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(storage.secrets.get(credentialKey)).toBe(legacyCredentials)
		expect(storage.globalState.get(credentialKey)).toBe(legacyCredentials)
		await new ContextProxy(storage.context).initialize()
		expect(storage.storeSecret).toHaveBeenCalledOnce()
		expect(storage.globalState.has(credentialKey)).toBe(false)
	})

	it("removes both copies during reset after a failed migration", async () => {
		const storage = createStorage(legacyCredentials)
		storage.storeSecret.mockRejectedValueOnce(new Error("SecretStorage unavailable"))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()
		await proxy.resetAllState()

		expect(proxy.getValue(credentialKey)).toBeUndefined()
		expect(storage.globalState.has(credentialKey)).toBe(false)
		expect(storage.secrets.has(credentialKey)).toBe(false)
	})

	it("removes a retained legacy copy before explicitly deleting credentials", async () => {
		const storage = createStorage(legacyCredentials)
		storage.storeSecret.mockRejectedValueOnce(new Error("SecretStorage unavailable"))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()
		storage.deleteSecret.mockImplementationOnce(async (key) => {
			expect(storage.globalState.has(key)).toBe(false)
			storage.secrets.delete(key)
		})
		await proxy.setValue(credentialKey, undefined)
		await proxy.refreshSecrets()

		expect(proxy.getValue(credentialKey)).toBeUndefined()
		expect(storage.globalState.has(credentialKey)).toBe(false)
	})

	it("stores edited credentials securely and clears a missing field when replacing the profile", async () => {
		const storage = createStorage()
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()
		await proxy.setProviderSettings({ apiProvider: "vertex", vertexJsonCredentials: legacyCredentials })

		expect(storage.secrets.get(credentialKey)).toBe(legacyCredentials)
		expect(storage.update).not.toHaveBeenCalledWith(credentialKey, legacyCredentials)
		const reloaded = new ContextProxy(storage.context)
		await reloaded.initialize()
		expect(reloaded.getProviderSettings().vertexJsonCredentials).toBe(legacyCredentials)
		await reloaded.setProviderSettings({ apiProvider: "openai" })
		await reloaded.refreshSecrets()
		expect(reloaded.getValue(credentialKey)).toBeUndefined()
		expect(storage.secrets.has(credentialKey)).toBe(false)
	})
})
