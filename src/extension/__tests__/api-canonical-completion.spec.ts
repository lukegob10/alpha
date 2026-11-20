import EventEmitter from "node:events"
import type * as vscode from "vscode"
import { AlphaCodeEventName, IpcMessageType, type TokenUsage, type ToolUsage } from "@alpha-code/types"

import { API } from "../api"
import { AlphaProvider } from "../../core/webview/AlphaProvider"
import type { Task } from "../../core/task/Task"

const ipc = vi.hoisted(() => ({ broadcast: vi.fn() }))
vi.mock("../executionIdentity", () => ({ readExecutionIdentity: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../activate/registerCommands", () => ({ openAlphaInNewTab: vi.fn() }))
vi.mock("@alpha-code/ipc", () => ({
	IpcServer: vi.fn().mockImplementation(function () {
		return { listen: vi.fn(), on: vi.fn(), dispose: vi.fn(), broadcast: ipc.broadcast }
	}),
}))

const tokenUsage: TokenUsage = { totalTokensIn: 3, totalTokensOut: 1, totalCost: 0, contextTokens: 4 }
const toolUsage: ToolUsage = {}

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

function harness(withIpc = true) {
	const provider = Object.assign(new EventEmitter(), {
		context: { subscriptions: [] as vscode.Disposable[] },
		pendingManagedTaskCompletions: new Map<string, { tokenUsage: TokenUsage; toolUsage: ToolUsage }>(),
		markTaskLifecycle: vi.fn(),
		log: vi.fn(),
	})
	const appendLine = vi.fn()
	const api = new API(
		{ appendLine } as unknown as vscode.OutputChannel,
		provider as unknown as AlphaProvider,
		withIpc ? "completion-test-socket" : undefined,
	)
	const completed = vi.fn()
	api.on(AlphaCodeEventName.TaskCompleted, completed)
	const child = Object.assign(new EventEmitter(), {
		taskId: "managed-child",
		parentTaskId: "root",
		taskKind: "subagent",
	}) as unknown as Task
	child.on(AlphaCodeEventName.TaskCompleted, (taskId, tokenUsage, toolUsage) => {
		provider.pendingManagedTaskCompletions.set(taskId, { tokenUsage, toolUsage })
	})
	provider.emit(AlphaCodeEventName.TaskCreated, child)
	ipc.broadcast.mockClear()
	const publish = () =>
		Reflect.get(AlphaProvider.prototype, "publishDurableManagedTaskCompletion").call(
			provider,
			child.taskId,
			"completed",
		)
	return { provider, api, completed, child, publish, appendLine }
}

describe("API canonical completion", () => {
	beforeEach(() => vi.clearAllMocks())

	it("forwards exactly one API and IPC child completion after the provider accepts its durable result", async () => {
		const { provider, api, completed, child, publish } = harness()
		const committed = barrier()
		const accepting = committed.promise.then(publish)
		child.emit(AlphaCodeEventName.TaskCompleted, child.taskId, tokenUsage, toolUsage)
		expect(completed).not.toHaveBeenCalled()
		expect(ipc.broadcast).not.toHaveBeenCalled()

		committed.resolve()
		await accepting
		publish()
		expect(completed).toHaveBeenCalledExactlyOnceWith(child.taskId, tokenUsage, toolUsage, { isSubtask: true })
		expect(ipc.broadcast).toHaveBeenCalledExactlyOnceWith({
			type: IpcMessageType.TaskEvent,
			origin: "server",
			data: {
				eventName: AlphaCodeEventName.TaskCompleted,
				payload: [child.taskId, tokenUsage, toolUsage, { isSubtask: true }],
			},
		})
		for (const disposable of provider.context.subscriptions) disposable.dispose()
		api.removeAllListeners()
	})

	it("publishes no API or IPC success when the durable result commit fails", async () => {
		const { completed, child, publish } = harness()
		const committing = barrier()
		const accepting = committing.promise
			.then(() => {
				throw new Error("result/mailbox commit failed")
			})
			.then(publish)
		const outcome = Promise.allSettled([accepting])
		child.emit(AlphaCodeEventName.TaskCompleted, child.taskId, tokenUsage, toolUsage)
		committing.resolve()
		const [result] = await outcome

		expect(result.status).toBe("rejected")
		expect(completed).not.toHaveBeenCalled()
		expect(ipc.broadcast).not.toHaveBeenCalled()
	})

	it("registers a provider once and preserves primary completion metadata", () => {
		const { provider, api, completed } = harness()
		Reflect.get(API.prototype, "registerListeners").call(api, provider)
		const primary = Object.assign(new EventEmitter(), { taskId: "primary" })
		provider.emit(AlphaCodeEventName.TaskCreated, primary)
		provider.emit(AlphaCodeEventName.TaskCompleted, primary.taskId, tokenUsage, toolUsage)

		expect(completed).toHaveBeenCalledExactlyOnceWith(primary.taskId, tokenUsage, toolUsage, { isSubtask: false })
	})
})

describe("API task event delivery", () => {
	beforeEach(() => vi.clearAllMocks())

	it("keeps task creation and later observers running after a public listener throws", () => {
		const { provider, api, appendLine } = harness()
		const event = AlphaCodeEventName.TaskCreated
		const seen: string[] = []
		const removed = (taskId: string) => seen.push(`removed:${taskId}`)
		api.prependOnceListener(event, function (this: API, taskId) {
			expect(this).toBe(api)
			seen.push(`first:${taskId}`)
			api.off(event, removed)
			throw new Error("observer secret canary")
		})
		api.on(event, removed)
		api.on(event, (taskId) => seen.push(`last:${taskId}`))
		const owningListener = vi.fn()
		provider.on(event, owningListener)
		const first = Object.assign(new EventEmitter(), { taskId: "first-task" })
		const second = Object.assign(new EventEmitter(), { taskId: "second-task" })

		expect(() => provider.emit(event, first)).not.toThrow()
		provider.emit(event, second)

		expect(seen).toEqual(["first:first-task", "removed:first-task", "last:first-task", "last:second-task"])
		expect(owningListener.mock.calls).toEqual([[first], [second]])
		expect(ipc.broadcast.mock.calls.map(([message]) => message.data.payload)).toEqual([
			["first-task"],
			["second-task"],
		])
		expect(appendLine).toHaveBeenCalledExactlyOnceWith(`[API] Task observer failed for ${event}`)
	})

	it("owns asynchronous observer rejections without blocking synchronous delivery", async () => {
		const { api, child, appendLine } = harness(false)
		const event = AlphaCodeEventName.TaskAskResponded
		const rejected = Promise.reject(new Error("observer secret canary"))
		const received = vi.fn()
		api.once(event, () => rejected)
		api.on(event, received)

		try {
			child.emit(event)
			expect(received).toHaveBeenCalledExactlyOnceWith(child.taskId)
			await Promise.resolve()
			expect(appendLine).toHaveBeenCalledExactlyOnceWith(`[API] Task observer failed for ${event}`)
		} finally {
			await rejected.catch(() => undefined)
		}
	})

	it("preserves direct public EventEmitter failures", () => {
		const { api } = harness(false)
		api.once(AlphaCodeEventName.TaskCreated, () => {
			throw new Error("direct public emit failed")
		})
		expect(() => api.emit(AlphaCodeEventName.TaskCreated, "task-id")).toThrow("direct public emit failed")
	})

	it("delivers final messages without serializing them when file logging is disabled", () => {
		const { api, child } = harness(false)
		const received = vi.fn()
		api.on(AlphaCodeEventName.Message, received)
		const toJSON = vi.fn(() => ({ ts: 1, type: "say", text: "Final message", partial: false }))
		const message = {
			action: "created" as const,
			message: { ts: 1, type: "say" as const, text: "Final message", partial: false, toJSON },
		}

		child.emit(AlphaCodeEventName.Message, message)

		expect(toJSON).not.toHaveBeenCalled()
		expect(received).toHaveBeenCalledExactlyOnceWith({ taskId: child.taskId, ...message })
	})
})
