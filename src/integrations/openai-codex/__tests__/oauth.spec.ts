import type { ExtensionContext } from "vscode"
import { describe, expect, it, vi } from "vitest"

import { OpenAiCodexOAuthManager, type OpenAiCodexCredentials } from "../oauth"

const createContext = (get: () => Promise<string | undefined>): ExtensionContext =>
	({
		secrets: {
			get,
			store: vi.fn(async () => undefined),
			delete: vi.fn(async () => undefined),
		},
	}) as unknown as ExtensionContext

describe("OpenAiCodexOAuthManager credential cache", () => {
	it("deduplicates credential loading and caches a missing credential result", async () => {
		let finishRead!: (value: string | undefined) => void
		const get = vi.fn(
			() =>
				new Promise<string | undefined>((resolve) => {
					finishRead = resolve
				}),
		)
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(createContext(get))

		const firstLoad = manager.loadCredentials()
		const secondLoad = manager.loadCredentials()
		expect(get).toHaveBeenCalledTimes(1)

		finishRead(undefined)
		await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([null, null])
		await expect(manager.loadCredentials()).resolves.toBeNull()

		expect(get).toHaveBeenCalledTimes(1)
		expect(manager.hasStoredCredentials()).toBe(false)
	})

	it("reports cached credential presence without validating or refreshing the token", async () => {
		const expiredCredentials: OpenAiCodexCredentials = {
			type: "openai-codex",
			access_token: "expired-access-token",
			refresh_token: "refresh-token",
			expires: 0,
		}
		const get = vi.fn(async () => JSON.stringify(expiredCredentials))
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(createContext(get))
		await manager.loadCredentials()

		expect(manager.hasStoredCredentials()).toBe(true)
		expect(get).toHaveBeenCalledTimes(1)
	})

	it("does not let a slow startup read overwrite newly saved credentials", async () => {
		let finishRead!: (value: string | undefined) => void
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(
			createContext(
				() =>
					new Promise<string | undefined>((resolve) => {
						finishRead = resolve
					}),
			),
		)
		const startupLoad = manager.loadCredentials()
		const credentials: OpenAiCodexCredentials = {
			type: "openai-codex",
			access_token: "new-access-token",
			refresh_token: "new-refresh-token",
			expires: Date.now() + 60_000,
		}

		await manager.saveCredentials(credentials)
		finishRead(undefined)
		await startupLoad

		expect(manager.getCredentials()).toEqual(credentials)
		expect(manager.hasStoredCredentials()).toBe(true)
	})
})
