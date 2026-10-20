import { describe, expect, it, vi } from "vitest"
import type { ExtensionContext } from "vscode"

import { ContextProxy } from "../ContextProxy"

describe("provider selection projection", () => {
	it("keeps selected identity and provider fields paired while a persistence failure settles", async () => {
		const original = new Map<string, unknown>()
		const update = vi.fn(async (key: string, value: unknown) => {
			original.set(key, value)
		})
		const context = {
			globalState: { get: (key: string) => original.get(key), update },
			secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
		} as unknown as ExtensionContext
		const proxy = new ContextProxy(context)
		await proxy.setProviderSettings({ apiProvider: "openai", apiModelId: "model-a" })
		await proxy.setValue("currentApiConfigName", "A")
		const entries = [{ id: "b", name: "B", apiProvider: "vertex" }]
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let enter!: () => void
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		const failure = new Error("storage write failed")
		update.mockImplementation(async (key: string, value: unknown) => {
			if (key === "apiProvider") throw failure
			if (key === "currentApiConfigName") {
				enter()
				await held
			}
			original.set(key, value)
		})
		// The additive projection parameter is deliberately exercised through the
		// actual cache/persistence boundary, including a held write and rejection.
		const pending = proxy.setProviderSettings(
			{ apiProvider: "vertex", apiModelId: "model-b" },
			{ currentApiConfigName: "B", listApiConfigMeta: entries },
		)
		void pending.catch(() => undefined)
		// The cache projection is synchronous even while persistence is pending.
		try {
			expect(proxy.getValue("currentApiConfigName")).toBe("B")
			expect(proxy.getValue("apiProvider")).toBe("vertex")
			expect(proxy.getValue("apiModelId")).toBe("model-b")
			expect(proxy.getValue("listApiConfigMeta")).toEqual(entries)
			await entered
		} finally {
			release()
		}
		await expect(pending).rejects.toBe(failure)
		expect(proxy.getValue("currentApiConfigName")).toBe("B")
		expect(proxy.getValue("apiProvider")).toBe("vertex")
	})
})
