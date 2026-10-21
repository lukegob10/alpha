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

function harness() {
	const provider = Object.assign(new EventEmitter(), {
		context: { subscriptions: [] as vscode.Disposable[] },
		pendingManagedTaskCompletions: new Map<string, { tokenUsage: TokenUsage; toolUsage: ToolUsage }>(),
		markTaskLifecycle: vi.fn(),
		log: vi.fn(),
	})
	const api = new API(
		{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		provider as unknown as AlphaProvider,
		"completion-test-socket",
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
		Reflect.get(AlphaProvider.prototype, "publishDurableManagedTaskCompletion").call(provider, child.taskId)
	return { provider, api, completed, child, publish }
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
