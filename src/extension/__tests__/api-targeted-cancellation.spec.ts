import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { type TaskCommand, TaskCommandName } from "@alpha-code/types"
import { IpcServer } from "@alpha-code/ipc"

import { AlphaProvider } from "../../core/webview/AlphaProvider"
import { API } from "../api"

const ipcMock = vi.hoisted(() => ({
	handler: undefined as undefined | ((clientId: string, command: TaskCommand) => void),
	listen: vi.fn(),
	send: vi.fn(),
	broadcast: vi.fn(),
	dispose: vi.fn(),
}))

vi.mock("vscode")
vi.mock("../executionIdentity", () => ({ readExecutionIdentity: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@alpha-code/ipc", () => ({
	IpcServer: vi.fn().mockImplementation(function () {
		return {
			listen: ipcMock.listen,
			send: ipcMock.send,
			broadcast: ipcMock.broadcast,
			dispose: ipcMock.dispose,
			on: vi.fn((_eventName, handler) => {
				ipcMock.handler = handler
			}),
		}
	}),
}))

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

describe("API targeted IPC cancellation", () => {
	let api: API
	let provider: AlphaProvider
	let cancelTask: ReturnType<typeof vi.fn<AlphaProvider["cancelTask"]>>
	let log: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.clearAllMocks()
		ipcMock.handler = undefined
		cancelTask = vi.fn<AlphaProvider["cancelTask"]>().mockResolvedValue(undefined)
		provider = {
			context: { subscriptions: [] },
			on: vi.fn(),
			cancelTask,
			getCurrentTask: vi.fn(),
		} as unknown as AlphaProvider
		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider, "cancel-test-socket")
		log = vi.fn()
		Object.assign(api, { log })
	})

	afterEach(() => {
		api.removeAllListeners()
		for (const disposable of provider.context.subscriptions) disposable.dispose()
	})

	it("explicitly advertises the targeted cancellation handler installed by Alpha", () => {
		expect(IpcServer).toHaveBeenCalledExactlyOnceWith(
			"cancel-test-socket",
			expect.any(Function),
			expect.any(Function),
			{ capabilities: { targetedTaskCancellation: true, presentationModelCallOptOut: true } },
		)
	})

	it("forwards an IPC presentation opt-out to task admission outside configuration", () => {
		const startNewTask = vi.spyOn(api, "startNewTask").mockResolvedValue("governed-task")
		const data = {
			configuration: { apiProvider: "vertex" as const },
			text: "Use only execution model calls",
			presentationModelCalls: false as const,
		}

		ipcMock.handler!("client", { commandName: TaskCommandName.StartNewTask, data })

		expect(startNewTask).toHaveBeenCalledExactlyOnceWith(data)
	})

	it("retains current-task semantics for a legacy command without data", () => {
		const cancelCurrentTask = vi.spyOn(api, "cancelCurrentTask")

		ipcMock.handler!("client", { commandName: TaskCommandName.CancelTask })

		expect(cancelCurrentTask).toHaveBeenCalledOnce()
		expect(cancelTask).toHaveBeenCalledExactlyOnceWith()
	})

	it("addresses the requested root while another task is visible", () => {
		vi.mocked(provider.getCurrentTask).mockReturnValue({ taskId: "visible-child" } as ReturnType<
			AlphaProvider["getCurrentTask"]
		>)
		const cancelCurrentTask = vi.spyOn(api, "cancelCurrentTask")

		ipcMock.handler!("client", {
			commandName: TaskCommandName.CancelTask,
			data: { taskId: "background-root" },
		})

		expect(cancelTask).toHaveBeenCalledExactlyOnceWith("background-root")
		expect(cancelCurrentTask).not.toHaveBeenCalled()
		expect(provider.getCurrentTask).not.toHaveBeenCalled()
	})

	it("never falls back to the current task when an explicit target no longer exists", () => {
		const getLiveTask = vi.fn().mockReturnValue(undefined)
		Object.assign(provider, { getLiveTask, cancelTask: AlphaProvider.prototype.cancelTask })
		vi.mocked(provider.getCurrentTask).mockReturnValue({ taskId: "successor" } as ReturnType<
			AlphaProvider["getCurrentTask"]
		>)

		ipcMock.handler!("client", {
			commandName: TaskCommandName.CancelTask,
			data: { taskId: "finished-root" },
		})

		expect(getLiveTask).toHaveBeenCalledExactlyOnceWith("finished-root")
		expect(provider.getCurrentTask).not.toHaveBeenCalled()
		expect(cancelTask).not.toHaveBeenCalled()
	})

	it("retains the captured target while cancellation cleanup yields to a successor", async () => {
		const cleanup = barrier()
		cancelTask.mockImplementationOnce(() => cleanup.promise)
		const cancelCurrentTask = vi.spyOn(api, "cancelCurrentTask")

		ipcMock.handler!("client", {
			commandName: TaskCommandName.CancelTask,
			data: { taskId: "original-root" },
		})
		vi.mocked(provider.getCurrentTask).mockReturnValue({ taskId: "successor" } as ReturnType<
			AlphaProvider["getCurrentTask"]
		>)
		try {
			expect(cancelTask).toHaveBeenCalledExactlyOnceWith("original-root")
			expect(cancelCurrentTask).not.toHaveBeenCalled()
			expect(provider.getCurrentTask).not.toHaveBeenCalled()
		} finally {
			cleanup.resolve()
			await cleanup.promise
		}
		expect(cancelTask).toHaveBeenCalledOnce()
	})

	it("contains targeted cleanup failures without retrying against a different task", async () => {
		const failureLogged = barrier()
		log.mockImplementation((message: string) => {
			if (message === "[API] CancelTask failed: cleanup failed") failureLogged.resolve()
		})
		cancelTask.mockRejectedValueOnce(new Error("cleanup failed"))
		const cancelCurrentTask = vi.spyOn(api, "cancelCurrentTask")

		ipcMock.handler!("client", {
			commandName: TaskCommandName.CancelTask,
			data: { taskId: "original-root" },
		})
		await failureLogged.promise

		expect(cancelTask).toHaveBeenCalledExactlyOnceWith("original-root")
		expect(cancelCurrentTask).not.toHaveBeenCalled()
		expect(ipcMock.dispose).not.toHaveBeenCalled()
		ipcMock.handler!("client", {
			commandName: TaskCommandName.CancelTask,
			data: { taskId: "next-root" },
		})
		expect(cancelTask).toHaveBeenLastCalledWith("next-root")
	})

	it("preserves the public current-task method and propagates its cleanup failure", async () => {
		cancelTask.mockRejectedValueOnce(new Error("public cleanup failed"))

		await expect(api.cancelCurrentTask()).rejects.toThrow("public cleanup failed")
		expect(cancelTask).toHaveBeenCalledExactlyOnceWith()
	})
})
