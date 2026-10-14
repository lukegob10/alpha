import EventEmitter from "node:events"
import os from "node:os"
import path from "node:path"

import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import type { Task } from "../../task/Task"
import type { SkillsManager } from "../../../services/skills/SkillsManager"
import { McpServerManager } from "../../../services/mcp/McpServerManager"

interface MockSkillsManager {
	provider: AlphaProvider
	workspacePath?: string
	options: { notifyWebview?: boolean }
	initialize: ReturnType<typeof vi.fn<() => Promise<void>>>
	dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

const managerMocks = vi.hoisted(() => ({
	instances: [] as MockSkillsManager[],
	initialize: vi.fn<() => Promise<void>>(),
	dispose: vi.fn<() => Promise<void>>(),
}))

vi.mock("../../../services/skills/SkillsManager", () => ({
	SkillsManager: class {
		initialize = vi.fn(() => managerMocks.initialize())
		dispose = vi.fn(() => managerMocks.dispose())

		constructor(
			readonly provider: AlphaProvider,
			readonly workspacePath?: string,
			readonly options: { notifyWebview?: boolean } = {},
		) {
			managerMocks.instances.push(this)
		}
	},
}))

const activeInstances = Reflect.get(AlphaProvider, "activeInstances") as Set<AlphaProvider>
const providers: AlphaProvider[] = []
const operations: Promise<unknown>[] = []
const barriers: Array<{ resolve: () => void }> = []
const workspace = (name: string) => path.join(os.tmpdir(), "alpha-scoped-skills", name)

function barrier() {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((complete, fail) => {
		resolve = complete
		reject = fail
	})
	const result = { promise, resolve, reject }
	barriers.push(result)
	return result
}

function track<T>(promise: Promise<T>): Promise<T> {
	operations.push(promise)
	void promise.catch(() => undefined)
	return promise
}

function makeProvider(storagePath = workspace(crypto.randomUUID())) {
	const sessions = TaskSessionRegistry.forGlobalStorage(storagePath, 10)
	const foregroundManager = { dispose: vi.fn(async () => undefined) }
	const postMessage = vi.fn(async () => undefined)
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		taskSessions: sessions,
		taskStack: [],
		currentView: { type: "newTaskDraft" },
		skillsManager: foregroundManager,
		scopedSkillsManagers: new Map(),
		taskEventListeners: new WeakMap(),
		publishedTaskTranscriptRevisions: new Map(),
		webviewMessageQueue: Promise.resolve(),
		taskControlMessageQueues: new Map(),
		immediateWebviewOperations: new Set(),
		webviewDisposables: [],
		disposables: [],
		taskHistoryStoreReady: Promise.resolve(),
		taskHistoryStore: { dispose: vi.fn() },
		postMessageToWebview: postMessage,
		postTaskSessionStateToWebview: vi.fn(async () => undefined),
		closeAgentLifecycleJournals: vi.fn(async () => undefined),
		flushGlobalStateWriteThrough: vi.fn(async () => undefined),
		removeAllListeners: vi.fn(),
		log: vi.fn(),
	}) as AlphaProvider
	activeInstances.add(provider)
	providers.push(provider)
	return { provider, sessions, foregroundManager, postMessage }
}

function makeTask(taskId: string, cwd: string, options: { workerWorkspace?: string } = {}) {
	return Object.assign(new EventEmitter(), {
		taskId,
		instanceId: crypto.randomUUID(),
		taskKind: options.workerWorkspace ? ("subagent" as const) : ("primary" as const),
		subagentRole: options.workerWorkspace ? "worker" : undefined,
		cwd,
		historyWorkspacePath: options.workerWorkspace ?? cwd,
		clineMessages: [],
		abortTask: vi.fn(async () => undefined),
	}) as unknown as Task
}

function observeRemoval(sessions: TaskSessionRegistry, taskId: string) {
	const removed = barrier()
	const unregister = sessions.unregister.bind(sessions)
	vi.spyOn(sessions, "unregister").mockImplementation((...args) => {
		const result = unregister(...args)
		if (args[0] === taskId) removed.resolve()
		return result
	})
	return removed.promise
}

beforeEach(() => {
	managerMocks.instances.length = 0
	managerMocks.initialize.mockReset().mockResolvedValue(undefined)
	managerMocks.dispose.mockReset().mockResolvedValue(undefined)
	vi.spyOn(McpServerManager, "unregisterProvider").mockResolvedValue(undefined)
})

afterEach(async () => {
	for (const pending of barriers.splice(0)) pending.resolve()
	await Promise.allSettled(operations.splice(0))
	for (const provider of providers.splice(0)) {
		await provider.dispose()
		activeInstances.delete(provider)
	}
	vi.restoreAllMocks()
})

describe("AlphaProvider task-scoped skills", () => {
	it("keeps the foreground catalog separate from task catalogs and disables task publication", async () => {
		const { provider, sessions, foregroundManager, postMessage } = makeProvider()
		const task = makeTask("primary", workspace("project"))
		sessions.register(task, { focus: false })

		expect(provider.getSkillsManager()).toBe(foregroundManager)
		const scoped = await provider.getSkillsManager(task)

		expect(scoped).toBe(managerMocks.instances[0])
		expect(scoped).not.toBe(foregroundManager)
		expect(managerMocks.instances[0]).toMatchObject({
			provider,
			workspacePath: path.resolve(task.cwd),
			options: { notifyWebview: false },
		})
		expect(provider.getSkillsManager()).toBe(foregroundManager)
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("reuses a normalized workspace until its final task owner is removed", async () => {
		const { provider, sessions } = makeProvider()
		const first = makeTask("first", workspace("shared"))
		const second = makeTask("second", `${first.cwd}${path.sep}nested${path.sep}..`)
		sessions.register(first, { focus: false })
		sessions.register(second, { focus: false })
		const manager = await provider.getSkillsManager(first)

		expect(await provider.getSkillsManager(second)).toBe(manager)
		expect(managerMocks.instances).toHaveLength(1)
		expect(managerMocks.instances[0].initialize).toHaveBeenCalledOnce()
		await provider.removeTaskFromStack({ taskId: first.taskId })
		expect(managerMocks.instances[0].dispose).not.toHaveBeenCalled()
		expect(await provider.getSkillsManager(second)).toBe(manager)

		await provider.removeTaskFromStack({ taskId: second.taskId })
		expect(managerMocks.instances[0].dispose).toHaveBeenCalledOnce()
		const replacement = makeTask("replacement", first.cwd)
		sessions.register(replacement, { focus: false })
		expect(await provider.getSkillsManager(replacement)).not.toBe(manager)
		expect(managerMocks.instances).toHaveLength(2)
	})

	it("separates background task catalogs by their cwd rather than the foreground workspace", async () => {
		const { provider, sessions } = makeProvider()
		const first = makeTask("first", workspace("project-a"))
		const second = makeTask("second", workspace("project-b"))
		sessions.register(first, { focus: true })
		sessions.register(second, { focus: false })
		Object.assign(second, { historyWorkspacePath: first.cwd })

		const [firstManager, secondManager] = await Promise.all([
			provider.getSkillsManager(first),
			provider.getSkillsManager(second),
		])

		expect(secondManager).not.toBe(firstManager)
		expect(managerMocks.instances.map(({ workspacePath }) => workspacePath)).toEqual([
			path.resolve(first.cwd),
			path.resolve(second.cwd),
		])
	})

	it("uses the managed Worker's logical workspace rather than its private checkout", async () => {
		const { provider, sessions } = makeProvider()
		const parent = makeTask("parent", workspace("logical"))
		const worker = makeTask("worker", workspace("private-worker"), { workerWorkspace: parent.cwd })
		sessions.register(parent, { focus: true })
		sessions.register(worker, { focus: false })

		expect(await provider.getSkillsManager(worker)).toBe(await provider.getSkillsManager(parent))
		expect(managerMocks.instances).toHaveLength(1)
		expect(managerMocks.instances[0].workspacePath).toBe(path.resolve(parent.cwd))
	})

	it("routes a cross-view lookup and cleanup through the canonical task owner", async () => {
		const storagePath = workspace(crypto.randomUUID())
		const owner = makeProvider(storagePath)
		const viewer = makeProvider(storagePath)
		const task = makeTask("owned", workspace("project"))
		owner.sessions.register(task, { focus: false })

		const manager = await viewer.provider.getSkillsManager(task)

		expect(await owner.provider.getSkillsManager(task)).toBe(manager)
		expect(managerMocks.instances).toHaveLength(1)
		expect(managerMocks.instances[0].provider).toBe(owner.provider)
		await viewer.provider.dispose()
		expect(managerMocks.instances[0].dispose).not.toHaveBeenCalled()
		await owner.provider.removeTaskFromStack({ taskId: task.taskId })
		expect(managerMocks.instances[0].dispose).toHaveBeenCalledOnce()
	})

	it("shares one pending initialization across concurrent tasks in the same workspace", async () => {
		const discovery = barrier()
		const entered = barrier()
		managerMocks.initialize.mockImplementationOnce(() => {
			entered.resolve()
			return discovery.promise
		})
		const { provider, sessions } = makeProvider()
		const first = makeTask("first", workspace("shared"))
		const second = makeTask("second", first.cwd)
		sessions.register(first, { focus: false })
		sessions.register(second, { focus: false })
		const firstLookup = track(provider.getSkillsManager(first))
		const secondLookup = track(provider.getSkillsManager(second))
		let returned = false
		void firstLookup.then(
			() => (returned = true),
			() => undefined,
		)
		await entered.promise

		expect(managerMocks.instances).toHaveLength(1)
		expect(managerMocks.instances[0].initialize).toHaveBeenCalledOnce()
		expect(returned).toBe(false)
		discovery.resolve()
		expect(await firstLookup).toBe(await secondLookup)
	})

	it("joins pending discovery on task removal and rejects its released lookup", async () => {
		const discovery = barrier()
		const entered = barrier()
		managerMocks.initialize.mockImplementationOnce(() => {
			entered.resolve()
			return discovery.promise
		})
		const { provider, sessions } = makeProvider()
		const task = makeTask("pending", workspace("project"))
		sessions.register(task, { focus: false })
		const lookup = track(provider.getSkillsManager(task))
		await entered.promise
		const removed = observeRemoval(sessions, task.taskId)
		const removal = track(provider.removeTaskFromStack({ taskId: task.taskId }))
		let settled = false
		void removal.then(
			() => (settled = true),
			() => undefined,
		)
		await removed

		expect(sessions.getTask(task.taskId)).toBeUndefined()
		expect(settled).toBe(false)
		expect(managerMocks.instances[0].dispose).not.toHaveBeenCalled()
		discovery.resolve()
		await expect(lookup).rejects.toThrow("released during discovery")
		await removal
		expect(managerMocks.instances[0].dispose).toHaveBeenCalledOnce()
	})

	it("keeps shared pending discovery alive when one of its task owners is removed", async () => {
		const discovery = barrier()
		const entered = barrier()
		managerMocks.initialize.mockImplementationOnce(() => {
			entered.resolve()
			return discovery.promise
		})
		const { provider, sessions } = makeProvider()
		const first = makeTask("first", workspace("shared"))
		const remaining = makeTask("remaining", first.cwd)
		sessions.register(first, { focus: false })
		sessions.register(remaining, { focus: false })
		const firstLookup = track(provider.getSkillsManager(first))
		const remainingLookup = track(provider.getSkillsManager(remaining))
		await entered.promise

		await provider.removeTaskFromStack({ taskId: first.taskId })
		expect(managerMocks.instances[0].dispose).not.toHaveBeenCalled()
		discovery.resolve()
		const manager = await remainingLookup
		await Promise.allSettled([firstLookup])
		expect(await provider.getSkillsManager(remaining)).toBe(manager)
		expect(managerMocks.instances).toHaveLength(1)
		expect(managerMocks.instances[0].initialize).toHaveBeenCalledOnce()

		await provider.removeTaskFromStack({ taskId: remaining.taskId })
		expect(managerMocks.instances[0].dispose).toHaveBeenCalledOnce()
	})

	it("disposes pending discovery before closing its owner and prevents later acquisition", async () => {
		const discovery = barrier()
		const entered = barrier()
		managerMocks.initialize.mockImplementationOnce(() => {
			entered.resolve()
			return discovery.promise
		})
		const { provider, sessions, foregroundManager } = makeProvider()
		const task = makeTask("pending", workspace("project"))
		sessions.register(task, { focus: false })
		const lookup = track(provider.getSkillsManager(task))
		await entered.promise
		const removed = observeRemoval(sessions, task.taskId)
		const disposal = track(provider.dispose())
		await removed

		expect(managerMocks.instances[0].dispose).not.toHaveBeenCalled()
		discovery.resolve()
		await expect(lookup).rejects.toThrow("released during discovery")
		await disposal
		expect(managerMocks.instances[0].dispose).toHaveBeenCalledOnce()
		expect(foregroundManager.dispose).toHaveBeenCalledOnce()
		expect(provider.getSkillsManager()).toBeUndefined()
		await expect(provider.getSkillsManager(task)).rejects.toThrow("owner has been disposed")
		await provider.dispose()
		expect(managerMocks.instances).toHaveLength(1)
		expect(managerMocks.instances[0].dispose).toHaveBeenCalledOnce()
	})

	it("evicts a failed initialization for all waiters and allows a fresh lookup", async () => {
		const discovery = barrier()
		const entered = barrier()
		managerMocks.initialize.mockImplementationOnce(() => {
			entered.resolve()
			return discovery.promise
		})
		const { provider, sessions } = makeProvider()
		const task = makeTask("retry", workspace("project"))
		sessions.register(task, { focus: false })
		const first = track(provider.getSkillsManager(task))
		const second = track(provider.getSkillsManager(task))
		await entered.promise
		const failure = new Error("Skill discovery failed")
		discovery.reject(failure)

		await expect(first).rejects.toBe(failure)
		await expect(second).rejects.toBe(failure)
		expect(managerMocks.instances[0].dispose).toHaveBeenCalledOnce()
		expect(await provider.getSkillsManager(task)).toBe(managerMocks.instances[1])
		expect(managerMocks.instances).toHaveLength(2)
	})
})
