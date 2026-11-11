import { describe, expect, it, vi } from "vitest"
import type { ExtensionContext } from "vscode"

import { ContextProxy } from "../ContextProxy"

function fixture() {
	const stored = new Map<string, unknown>()
	const update = vi.fn(async (key: string, value: unknown) => {
		stored.set(key, value)
	})
	const proxy = new ContextProxy({
		globalState: { get: (key: string) => stored.get(key), update },
		secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
	} as unknown as ExtensionContext)
	return { stored, update, proxy }
}

describe("preference persistence failure recovery", () => {
	it("keeps revocation immediately visible while rolling a failed write back to its committed value", async () => {
		const test = fixture()
		await test.proxy.setValue("followupAutoApproveTimeoutMs", 5000)
		let fail!: (error: Error) => void
		test.update.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					fail = reject
				}),
		)
		const pending = test.proxy.setValue("followupAutoApproveTimeoutMs", 0, true)
		expect(test.proxy.getValue("followupAutoApproveTimeoutMs")).toBe(0)
		fail(new Error("storage unavailable"))
		await expect(pending).rejects.toThrow("storage unavailable")
		expect(test.proxy.getValue("followupAutoApproveTimeoutMs")).toBe(5000)
	})

	it("orders concurrent writes and rolls two failures back to the last durable preference", async () => {
		const test = fixture()
		await test.proxy.setValue("soundVolume", 0.5)
		let fail!: (error: Error) => void
		test.update.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					fail = reject
				}),
		)
		test.update.mockRejectedValueOnce(new Error("second failure"))
		const first = test.proxy.setValue("soundVolume", 0.6, true)
		const second = test.proxy.setValue("soundVolume", 0.7, true)
		const settled = Promise.allSettled([first, second])
		expect(test.proxy.getValue("soundVolume")).toBe(0.7)
		fail(new Error("first failure"))
		expect((await settled).every((result) => result.status === "rejected")).toBe(true)
		expect(test.proxy.getValue("soundVolume")).toBe(0.5)
		expect(test.stored.get("soundVolume")).toBe(0.5)
	})

	it("never revives a pre-reset permission after a failed post-reset save", async () => {
		const test = fixture()
		await test.proxy.setValue("alwaysAllowWrite", true)
		await test.proxy.resetAllState()
		expect(test.proxy.getValue("alwaysAllowWrite")).toBeUndefined()
		test.update.mockRejectedValueOnce(new Error("storage unavailable"))
		await expect(test.proxy.setValue("alwaysAllowWrite", false, true)).rejects.toThrow("storage unavailable")
		expect(test.proxy.getValue("alwaysAllowWrite")).toBeUndefined()
		expect(test.stored.get("alwaysAllowWrite")).toBeUndefined()
	})

	it("restores a successfully migrated prompt when a later preference save fails", async () => {
		const test = fixture()
		test.stored.set("customCondensingPrompt", "Keep my original project constraints")
		await test.proxy.initialize()
		const migrated = { CONDENSE: "Keep my original project constraints" }
		expect(test.proxy.getValue("customSupportPrompts")).toEqual(migrated)
		test.update.mockRejectedValueOnce(new Error("storage unavailable"))
		await expect(test.proxy.setValue("customSupportPrompts", { CONDENSE: "replacement" }, true)).rejects.toThrow(
			"storage unavailable",
		)
		expect(test.proxy.getValue("customSupportPrompts")).toEqual(migrated)
		expect(test.stored.get("customSupportPrompts")).toEqual(migrated)
	})
})
