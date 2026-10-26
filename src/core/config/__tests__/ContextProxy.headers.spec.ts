import type { ExtensionContext } from "vscode"

import { ContextProxy } from "../ContextProxy"

const headerKey = "openAiHeaders"
const legacyHeaders = { Authorization: "fixture-legacy", "X-Route": "legacy" }
const editedHeaders = { Authorization: "fixture-edited" }

function createStorage(legacy?: unknown, secret?: string) {
	const globalState = new Map<string, unknown>([["apiProvider", "openai"]])
	const secrets = new Map<string, string>()
	if (legacy !== undefined) globalState.set(headerKey, legacy)
	if (secret !== undefined) secrets.set(headerKey, secret)
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

function barrier() {
	let release!: () => void
	const pending = new Promise<void>((resolve) => {
		release = resolve
	})
	return { pending, release }
}

describe("OpenAI custom-header secure mirror", () => {
	it("saves custom headers securely without changing provider reads, saved profiles, or global exports", async () => {
		const storage = createStorage()
		const savedProfiles = JSON.stringify({ apiConfigs: { saved: { openAiHeaders: legacyHeaders } } })
		storage.secrets.set("roo_cline_config_api_config", savedProfiles)
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()
		await proxy.setProviderSettings({ apiProvider: "openai", openAiHeaders: editedHeaders })

		expect(storage.globalState.has(headerKey)).toBe(false)
		expect(storage.update.mock.calls.every(([key, value]) => key !== headerKey || value === undefined)).toBe(true)
		expect(JSON.parse(storage.secrets.get(headerKey)!)).toEqual(editedHeaders)
		expect(proxy.getValue(headerKey)).toEqual(editedHeaders)
		expect(proxy.getProviderSettings().openAiHeaders).toEqual(editedHeaders)
		expect(await proxy.export()).not.toHaveProperty(headerKey)
		expect(storage.secrets.get("roo_cline_config_api_config")).toBe(savedProfiles)
		const reloaded = new ContextProxy(storage.context)
		await reloaded.initialize()
		expect(reloaded.getProviderSettings().openAiHeaders).toEqual(editedHeaders)
	})

	it("keeps the legacy map until migration has stored its secure copy", async () => {
		const storage = createStorage(legacyHeaders)
		const entered = barrier()
		const held = barrier()
		storage.storeSecret.mockImplementationOnce(async (key, value) => {
			entered.release()
			await held.pending
			storage.secrets.set(key, value)
		})
		const proxy = new ContextProxy(storage.context)
		const initialization = proxy.initialize()
		try {
			await entered.pending
			expect(storage.globalState.has(headerKey)).toBe(true)
			expect(storage.update).not.toHaveBeenCalledWith(headerKey, undefined)
		} finally {
			held.release()
		}
		await initialization

		expect(storage.globalState.has(headerKey)).toBe(false)
		expect(JSON.parse(storage.secrets.get(headerKey)!)).toEqual(legacyHeaders)
		expect(proxy.getProviderSettings().openAiHeaders).toEqual(legacyHeaders)
		await new ContextProxy(storage.context).initialize()
		expect(storage.storeSecret).toHaveBeenCalledOnce()
	})

	it.each([editedHeaders, {}])("prefers an existing secure map to the legacy map: %j", async (headers) => {
		const storage = createStorage(legacyHeaders, JSON.stringify(headers))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(proxy.getProviderSettings().openAiHeaders).toEqual(headers)
		expect(storage.globalState.has(headerKey)).toBe(false)
		expect(storage.storeSecret).not.toHaveBeenCalled()
	})

	it("retains the legacy map after a failed secure store and retries on refresh", async () => {
		const storage = createStorage(legacyHeaders)
		storage.storeSecret.mockRejectedValueOnce(new Error("SecretStorage unavailable"))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(storage.globalState.has(headerKey)).toBe(true)
		expect(storage.secrets.has(headerKey)).toBe(false)
		expect(proxy.getProviderSettings().openAiHeaders).toEqual(legacyHeaders)
		await proxy.refreshSecrets()
		expect(JSON.parse(storage.secrets.get(headerKey)!)).toEqual(legacyHeaders)
		expect(storage.globalState.has(headerKey)).toBe(false)
	})

	it("does not overwrite an unreadable existing secure map and retries the read", async () => {
		const storage = createStorage(legacyHeaders, JSON.stringify(editedHeaders))
		storage.getSecret.mockImplementation(async (key) => {
			if (key === headerKey) throw new Error("SecretStorage unavailable")
			return storage.secrets.get(key)
		})
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(storage.globalState.has(headerKey)).toBe(true)
		expect(storage.storeSecret).not.toHaveBeenCalled()
		storage.getSecret.mockImplementation(async (key) => storage.secrets.get(key))
		await proxy.refreshSecrets()
		expect(proxy.getProviderSettings().openAiHeaders).toEqual(editedHeaders)
		expect(storage.globalState.has(headerKey)).toBe(false)
	})

	it.each(["not-json", '{"Authorization":42}', "null"])(
		"preserves both saved representations when the secure map is invalid: %s",
		async (secret) => {
			const storage = createStorage(legacyHeaders, secret)
			const proxy = new ContextProxy(storage.context)
			await proxy.initialize()

			expect(storage.secrets.get(headerKey)).toBe(secret)
			expect(storage.globalState.has(headerKey)).toBe(true)
			expect(storage.storeSecret).not.toHaveBeenCalled()
			expect(storage.deleteSecret).not.toHaveBeenCalled()
		},
	)

	it("retries failed plaintext cleanup without overwriting the secure map", async () => {
		const storage = createStorage(legacyHeaders)
		storage.update.mockRejectedValueOnce(new Error("global state unavailable"))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(storage.secrets.has(headerKey)).toBe(true)
		expect(storage.globalState.has(headerKey)).toBe(true)
		await proxy.refreshSecrets()
		expect(storage.globalState.has(headerKey)).toBe(false)
		expect(storage.storeSecret).toHaveBeenCalledOnce()
	})

	it("preserves malformed legacy settings for repair without storing or deleting them", async () => {
		const storage = createStorage({ Authorization: 42 })
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		expect(storage.globalState.has(headerKey)).toBe(true)
		expect(storage.secrets.has(headerKey)).toBe(false)
		expect(storage.storeSecret).not.toHaveBeenCalled()
		expect(storage.update).not.toHaveBeenCalledWith(headerKey, undefined)
	})

	it("keeps the secure copy when an explicit clear cannot remove the legacy copy", async () => {
		const storage = createStorage(undefined, JSON.stringify(editedHeaders))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()
		storage.globalState.set(headerKey, legacyHeaders)
		storage.update.mockRejectedValueOnce(new Error("global state unavailable"))

		await expect(proxy.setValue(headerKey, undefined)).rejects.toBeInstanceOf(Error)
		expect(storage.globalState.has(headerKey)).toBe(true)
		expect(storage.secrets.has(headerKey)).toBe(true)
		expect(storage.deleteSecret).not.toHaveBeenCalled()
		await proxy.setValue(headerKey, undefined)
		await proxy.refreshSecrets()
		expect(storage.globalState.has(headerKey)).toBe(false)
		expect(storage.secrets.has(headerKey)).toBe(false)
		expect(proxy.getValue(headerKey)).toBeUndefined()
	})

	it("serializes a clear from another view after an in-flight migration", async () => {
		const storage = createStorage(legacyHeaders)
		const entered = barrier()
		const held = barrier()
		storage.storeSecret.mockImplementationOnce(async (key, value) => {
			entered.release()
			await held.pending
			storage.secrets.set(key, value)
		})
		const initialization = new ContextProxy(storage.context).initialize()
		let clearing: Promise<void> | undefined
		try {
			await Promise.race([
				entered.pending,
				initialization.then(() => {
					throw new Error("Header migration was not scheduled")
				}),
			])
			clearing = new ContextProxy(storage.context).setValue(headerKey, undefined)
		} finally {
			held.release()
		}
		await Promise.all([initialization, clearing])

		expect(storage.globalState.has(headerKey)).toBe(false)
		expect(storage.secrets.has(headerKey)).toBe(false)
		const reloaded = new ContextProxy(storage.context)
		await reloaded.initialize()
		expect(reloaded.getValue(headerKey)).toBeUndefined()
	})

	it("does not let an older refresh overwrite a newer header edit while persistence is pending", async () => {
		const storage = createStorage(undefined, JSON.stringify(legacyHeaders))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()
		const readEntered = barrier()
		const readHeld = barrier()
		const storeEntered = barrier()
		const storeHeld = barrier()
		storage.getSecret.mockImplementation(async (key) => {
			const value = storage.secrets.get(key)
			if (key === headerKey) {
				readEntered.release()
				await readHeld.pending
			}
			return value
		})
		storage.storeSecret.mockImplementation(async (key, value) => {
			storeEntered.release()
			await storeHeld.pending
			storage.secrets.set(key, value)
		})
		const refreshing = proxy.refreshSecrets()
		let saving: Promise<void> | undefined
		try {
			await readEntered.pending
			saving = proxy.setValue(headerKey, editedHeaders)
			expect(proxy.getValue(headerKey)).toEqual(editedHeaders)
			readHeld.release()
			await storeEntered.pending
			await refreshing
			expect(proxy.getValue(headerKey)).toEqual(editedHeaders)
		} finally {
			readHeld.release()
			storeHeld.release()
		}
		await saving
		expect(JSON.parse(storage.secrets.get(headerKey)!)).toEqual(editedHeaders)
	})

	it("clears both copies before replacing a profile without headers", async () => {
		const storage = createStorage(legacyHeaders, JSON.stringify(editedHeaders))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()
		await proxy.setProviderSettings({ apiProvider: "vscode-lm" })
		await proxy.refreshSecrets()

		expect(proxy.getValue(headerKey)).toBeUndefined()
		expect(storage.globalState.has(headerKey)).toBe(false)
		expect(storage.secrets.has(headerKey)).toBe(false)
	})

	it("resets both copies after a failed migration", async () => {
		const storage = createStorage(legacyHeaders)
		storage.storeSecret.mockRejectedValueOnce(new Error("SecretStorage unavailable"))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()
		await proxy.resetAllState()

		expect(proxy.getValue(headerKey)).toBeUndefined()
		expect(storage.globalState.has(headerKey)).toBe(false)
		expect(storage.secrets.has(headerKey)).toBe(false)
	})

	it("rejects an invalid edited map without changing the cached or saved map", async () => {
		const storage = createStorage(undefined, JSON.stringify(editedHeaders))
		const proxy = new ContextProxy(storage.context)
		await proxy.initialize()

		await expect(proxy.setValues({ openAiHeaders: { Authorization: 42 } as never })).rejects.toBeInstanceOf(Error)
		expect(proxy.getValue(headerKey)).toEqual(editedHeaders)
		expect(JSON.parse(storage.secrets.get(headerKey)!)).toEqual(editedHeaders)
		expect(storage.globalState.has(headerKey)).toBe(false)
	})
})
