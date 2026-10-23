import type * as vscode from "vscode"
import { AlphaCodeEventName } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { WebviewMessage } from "../../../shared/WebviewMessage"
import type { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>

const fixtures: Harness[] = []

afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

async function fixture() {
	const value = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	fixtures.push(value)
	return value
}

describe("managed child Stop and provider disposal boundaries", () => {
	it("coalesces disposal reentered synchronously from native task cancellation", async () => {
		const value = await fixture()
		const owner = value.provider as unknown as { disposeOwnedResources(): Promise<void> }
		const disposeOwned = vi.spyOn(owner, "disposeOwnedResources")
		let nested: Promise<void> | undefined
		value.root.getTaskLifetimeCancellationSignal().addEventListener(
			"abort",
			() => {
				nested = value.provider.dispose()
			},
			{ once: true },
		)
		const disposing = value.provider.dispose()
		const disposed = Promise.allSettled([disposing, nested])
		try {
			expect(nested).toBeDefined()
			expect(disposeOwned).toHaveBeenCalledOnce()
		} finally {
			expect((await disposed).every((result) => result.status === "fulfilled")).toBe(true)
		}
	})

	it("joins native child Stop before finalizing its managed result", async () => {
		const value = await fixture()
		const child = await value.spawnChild("native-stop")
		const cleanupEntered = deferred()
		const releaseCleanup = deferred()
		let aborted = false
		let heldCleanup = false
		child.task.once(AlphaCodeEventName.TaskAborted, () => {
			aborted = true
		})
		const flush = child.task.flushApiConversationHistoryPersistence.bind(child.task)
		vi.spyOn(child.task, "flushApiConversationHistoryPersistence").mockImplementation(async (...args) => {
			if (aborted && !heldCleanup) {
				heldCleanup = true
				cleanupEntered.resolve()
				await releaseCleanup.promise
			}
			await flush(...args)
		})
		const finalize = vi.spyOn(child.task, "finalizeSubagentHistory")
		const stopping = value.provider.cancelTask(child.taskId, "webview_stop")
		const stopped = Promise.allSettled([stopping])
		try {
			await cleanupEntered.promise
			// TaskAborted precedes this held native persistence boundary. It cannot
			// release the manager's slot or publish a terminal child result yet.
			expect(finalize).not.toHaveBeenCalled()
			expect(value.runs.getResult(child.taskId)).toBeUndefined()
		} finally {
			releaseCleanup.resolve()
			const [outcome] = await stopped
			expect(outcome.status).toBe("fulfilled")
			await child.finalization
		}
		await expect(value.runs.waitForResult(child.taskId)).resolves.toMatchObject({
			status: "cancelled",
			stopReason: "cancelled",
		})
	})

	it("cancels owned tasks before draining a webview operation waiting on task cancellation", async () => {
		const value = await fixture()
		const child = await value.spawnChild("dispose-during-compaction")
		const entered = deferred()
		const released = deferred()
		const signal = value.root.getTaskLifetimeCancellationSignal()
		vi.spyOn(value.root, "condenseContext").mockImplementation(async () => {
			const onAbort = () => released.resolve()
			signal.addEventListener("abort", onAbort, { once: true })
			entered.resolve()
			try {
				if (signal.aborted) onAbort()
				await released.promise
			} finally {
				signal.removeEventListener("abort", onAbort)
			}
		})
		let receive!: (message: WebviewMessage) => Promise<void>
		const webview = {
			onDidReceiveMessage: (listener: typeof receive) => {
				receive = listener
				return { dispose: vi.fn() }
			},
		} as unknown as vscode.Webview
		const listener = Reflect.get(value.provider, "setWebviewMessageListener") as (webview: vscode.Webview) => void
		listener.call(value.provider, webview)
		const message = receive({ type: "condenseTaskContextRequest", text: value.root.taskId })
		await entered.promise
		const disposing = value.provider.dispose()
		const disposed = Promise.allSettled([disposing])
		try {
			expect(signal.aborted).toBe(true)
			expect(child.task.getTaskLifetimeCancellationSignal().aborted).toBe(true)
		} finally {
			released.resolve()
			await message
			const [outcome] = await disposed
			expect(outcome.status).toBe("fulfilled")
			await child.finalization
		}
	})

	it.each(["dispose", "remove"] as const)(
		"%s joins managed result persistence before releasing ownership",
		async (action) => {
			const value = await fixture()
			const child = await value.spawnChild("dispose-before-result")
			const resultEntered = deferred()
			const releaseResult = deferred()
			const joined = deferred<"joined" | "released">()
			const finalize = child.task.finalizeSubagentHistory.bind(child.task)
			vi.spyOn(child.task, "finalizeSubagentHistory").mockImplementation(async (...args) => {
				resultEntered.resolve()
				await releaseResult.promise
				await finalize(...args)
			})
			const then = child.finalization.then.bind(child.finalization)
			vi.spyOn(child.finalization, "then").mockImplementation((...args) => {
				joined.resolve("joined")
				return then(...args)
			})
			const history = Reflect.get(value.provider, "taskHistoryStore") as TaskHistoryStore
			const disposeHistory = history.dispose.bind(history)
			const disposal = vi.spyOn(history, "dispose").mockImplementation(async () => {
				joined.resolve("released")
				await disposeHistory()
			})
			const disposing = (
				action === "dispose"
					? value.provider.dispose()
					: value.provider.removeTaskFromStack({ taskId: value.root.taskId, requireAbortSuccess: true })
			).then(() => joined.resolve("released"))
			const disposed = Promise.allSettled([disposing])
			try {
				expect(await joined.promise).toBe("joined")
				await resultEntered.promise
				expect(disposal).not.toHaveBeenCalled()
				const finalizations = Reflect.get(value.provider, "subagentRunFinalizations") as Map<string, unknown>
				expect(finalizations.has(child.taskId)).toBe(true)
			} finally {
				releaseResult.resolve()
				const [outcome] = await disposed
				expect(outcome.status).toBe("fulfilled")
				await child.finalization
			}
			expect(disposal).toHaveBeenCalledTimes(action === "dispose" ? 1 : 0)
			expect(value.store.getAgent(child.taskId)?.terminalResult).toMatchObject({ status: "cancelled" })
		},
	)

	it("drains independent cancellation branches and retains failed cleanup for an explicit retry", async () => {
		const value = await fixture()
		const failed = await value.spawnChild("cleanup-failure")
		const healthy = await value.spawnChild("cleanup-independent")
		const error = new Error("Native child cleanup failed once")
		vi.spyOn(failed.task, "abortTask").mockRejectedValueOnce(error)
		const history = Reflect.get(value.provider, "taskHistoryStore") as TaskHistoryStore
		const disposal = vi.spyOn(history, "dispose")
		await expect(value.provider.dispose()).rejects.toBe(error)
		expect(disposal).not.toHaveBeenCalled()
		expect(value.provider.getLiveTask(failed.taskId)).toBe(failed.task)
		await expect(value.runs.waitForResult(healthy.taskId)).resolves.toMatchObject({ status: "cancelled" })
		await Promise.all([failed.finalization, healthy.finalization])
		await expect(value.provider.dispose()).resolves.toBeUndefined()
		expect(disposal).toHaveBeenCalledOnce()
		expect(value.provider.getLiveTask(failed.taskId)).toBeUndefined()
	})
})
