import { describe, expect, it, vi } from "vitest"

import { AlphaProvider } from "../AlphaProvider"
import type { Task } from "../../task/Task"

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

function fixture() {
	const request = new AbortController()
	const parent = {
		taskId: "parent",
		apiConfiguration: { apiProvider: "openai" },
		clineMessages: [],
		getTaskApiConfigName: vi.fn(async () => "Parent profile"),
		flushPendingToolResultsToHistory: vi.fn(async () => true),
	} as unknown as Task
	const child = { taskId: "child", start: vi.fn() } as unknown as Task
	const remove = vi.fn(async () => undefined)
	const create = vi.fn(async () => child)
	const profile = vi.fn(async () => undefined)
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		contextProxy: { globalStorageUri: { fsPath: "/storage" } },
		getTaskOwner: () => undefined,
		getLiveTask: () => parent,
		getModeProviderProfile: profile,
		getProviderProfile: vi.fn(async () => "Default profile"),
		getHostProviders: () => [],
		isTaskSelected: () => false,
		removeTaskFromStack: remove,
		createTask: create,
		getTaskWithId: vi.fn(async () => ({ historyItem: { id: parent.taskId, childIds: [] } })),
		updateTaskHistory: vi.fn(async () => undefined),
		emit: vi.fn(),
	})
	const params = {
		parentTaskId: parent.taskId,
		message: "Continue in a child",
		initialTodos: [],
		mode: "code",
		signal: request.signal,
	}
	return { provider, parent, child, request, remove, create, profile, params }
}

describe("legacy task handoff cancellation admission", () => {
	it.each(["profile", "config", "flush"] as const)(
		"leaves the parent live when interrupted during %s preparation",
		async (stage) => {
			const { provider, parent, request, remove, create, profile, params } = fixture()
			const entered = deferred()
			const held = deferred()
			const reason = new Error("Request interrupted before handoff")
			const wait = async () => {
				entered.resolve()
				await held.promise
			}
			if (stage === "profile") {
				profile.mockImplementationOnce(async () => {
					await wait()
					return undefined
				})
			} else if (stage === "config") {
				vi.mocked(parent.getTaskApiConfigName).mockImplementationOnce(async () => {
					await wait()
					return "Parent profile"
				})
			} else {
				vi.mocked(parent.flushPendingToolResultsToHistory).mockImplementationOnce(async () => {
					await wait()
					return true
				})
			}
			const operation = provider.delegateParentAndOpenChild(params)
			const rejected = expect(operation).rejects.toBe(reason)
			try {
				await entered.promise
				request.abort(reason)
				held.resolve()
				await rejected
				expect(remove).not.toHaveBeenCalled()
				expect(create).not.toHaveBeenCalled()
				expect(provider.getLiveTask(parent.taskId)).toBe(parent)
			} finally {
				held.resolve()
				await operation.catch(() => undefined)
				vi.restoreAllMocks()
			}
		},
	)

	it("finishes an admitted handoff when parent removal intentionally cancels the invoking request", async () => {
		const { provider, parent, child, request, remove, params } = fixture()
		remove.mockImplementationOnce(async () => {
			request.abort(new Error("Parent runtime removed for handoff"))
		})

		await expect(provider.delegateParentAndOpenChild(params)).resolves.toBe(child)

		expect(request.signal.aborted).toBe(true)
		expect(remove).toHaveBeenCalledExactlyOnceWith({ taskId: parent.taskId, skipDelegationRepair: true })
		expect(provider.updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ delegatedToId: child.taskId, awaitingChildId: child.taskId }),
		)
		expect(child.start).toHaveBeenCalledOnce()
	})
})
