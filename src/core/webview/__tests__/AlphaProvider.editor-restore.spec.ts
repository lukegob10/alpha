import { describe, expect, it, vi } from "vitest"
import type { HistoryItem } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

const fixture = (historyReady: Promise<void> = Promise.resolve()) => {
	const focus = vi.fn().mockResolvedValue(false)
	const lookup = vi.fn().mockResolvedValue({ historyItem: { id: "saved-task" } as HistoryItem })
	const restore = vi.fn().mockResolvedValue({ taskId: "saved-task" })
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		taskNavigationGeneration: 0,
		taskHistoryStoreReady: historyReady,
		focusTask: focus,
		getTaskWithId: lookup,
		createTaskWithHistoryItem: restore,
	})
	return { provider, focus, lookup, restore }
}

describe("editor chat identity restoration", () => {
	it("joins history loading and requires explicit resume instead of consuming queued input", async () => {
		const ready = barrier()
		const { provider, focus, lookup, restore } = fixture(ready.promise)
		const restoring = provider.restoreEditorTask("saved-task", () => true)
		expect(focus).not.toHaveBeenCalled()
		ready.resolve()
		await expect(restoring).resolves.toBe(true)
		expect(lookup).toHaveBeenCalledWith("saved-task", { includeApiConversationHistory: false })
		expect(restore).toHaveBeenCalledWith(
			{ id: "saved-task" },
			expect.objectContaining({
				requireExplicitResume: true,
				preserveExisting: true,
				navigationGeneration: 1,
				isRestoreCurrent: expect.any(Function),
			}),
		)
	})

	it("borrows the canonical live task without replacing or restarting it", async () => {
		const { provider, focus, lookup, restore } = fixture()
		focus.mockResolvedValue(true)
		await expect(provider.restoreEditorTask("saved-task", () => true)).resolves.toBe(true)
		expect(lookup).not.toHaveBeenCalled()
		expect(restore).not.toHaveBeenCalled()
	})

	it.each(["closed", "navigation"] as const)(
		"does not restore after %s supersedes history loading",
		async (reason) => {
			const ready = barrier()
			const { provider, focus, lookup, restore } = fixture(ready.promise)
			let open = true
			const restoring = provider.restoreEditorTask("saved-task", () => open)
			if (reason === "closed") open = false
			else Object.assign(provider, { taskNavigationGeneration: 2 })
			ready.resolve()
			await expect(restoring).resolves.toBe(false)
			expect(focus).not.toHaveBeenCalled()
			expect(lookup).not.toHaveBeenCalled()
			expect(restore).not.toHaveBeenCalled()
		},
	)

	it("keeps the admission guard live while the queued restore awaits ownership", async () => {
		const { provider, restore } = fixture()
		let guard!: () => boolean
		restore.mockImplementation(async (_item, options) => {
			guard = options.isRestoreCurrent
			expect(guard()).toBe(true)
			Object.assign(provider, { taskNavigationGeneration: 2 })
			expect(guard()).toBe(false)
			throw new Error("superseded")
		})
		await expect(provider.restoreEditorTask("saved-task", () => true)).resolves.toBe(false)
	})

	it("propagates missing history so the panel can explain the failure without resetting data", async () => {
		const { provider, lookup, restore } = fixture()
		lookup.mockRejectedValue(new Error("Task not found"))
		await expect(provider.restoreEditorTask("deleted-task", () => true)).rejects.toThrow("Task not found")
		expect(restore).not.toHaveBeenCalled()
	})

	it("revokes history constructor admission if the panel closes while awaiting initialization", async () => {
		const ready = barrier()
		const { provider } = fixture(ready.promise)
		const ownership = vi.fn()
		Object.assign(provider, {
			getLiveTask: () => undefined,
			taskSessions: { runOwnershipOperation: ownership },
		})
		let open = true
		const restoring = AlphaProvider.prototype.createTaskWithHistoryItem.call(
			provider,
			{ id: "saved-task" } as HistoryItem,
			{ isRestoreCurrent: () => open, requireExplicitResume: true },
		)
		open = false
		ready.resolve()
		await expect(restoring).rejects.toThrow("superseded")
		expect(ownership).not.toHaveBeenCalled()
	})
})
