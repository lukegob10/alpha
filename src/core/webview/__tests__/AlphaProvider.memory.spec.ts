import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { memorySettingsSchema, type HistoryItem, type MemorySettings } from "@alpha-code/types"
import type { MemoryCoordinatorOptions } from "../../../services/memory/MemoryCoordinator"
import type { MemoryStore } from "../../../services/memory/MemoryStore"
import { API } from "../../../extension/api"
import { AlphaProvider } from "../AlphaProvider"

interface CoordinatorDouble {
	options: MemoryCoordinatorOptions
	wake: ReturnType<typeof vi.fn>
	dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
	recordUsage: ReturnType<typeof vi.fn>
	recordNote: ReturnType<typeof vi.fn>
}

const memory = vi.hoisted(() => ({ coordinators: [] as CoordinatorDouble[] }))

vi.mock("../../../services/memory/MemoryCoordinator", () => ({
	MemoryCoordinator: vi.fn().mockImplementation(function (options: MemoryCoordinatorOptions) {
		const coordinator: CoordinatorDouble = {
			options,
			wake: vi.fn(),
			dispose: vi.fn(async () => undefined),
			recordUsage: vi.fn(async () => undefined),
			recordNote: vi.fn((text: string, signal?: AbortSignal) => options.store.addAdHocNote(text, signal)),
		}
		memory.coordinators.push(coordinator)
		return coordinator
	}),
}))
vi.mock("../../../services/memory/MemoryModel", () => ({ MemoryModel: vi.fn() }))
vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: { unregisterProvider: vi.fn(async () => undefined) },
}))

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

interface SharedFixture {
	state: Record<string, unknown>
	store: {
		home: string
		rootPath: string
		initialize: ReturnType<typeof vi.fn<() => Promise<void>>>
		reset: ReturnType<typeof vi.fn<() => Promise<void>>>
		addAdHocNote: ReturnType<typeof vi.fn<(text: string, signal?: AbortSignal) => Promise<string>>>
	}
	contextProxy: {
		globalStorageUri: { fsPath: string }
		getValue: ReturnType<typeof vi.fn<(key: string) => unknown>>
		setValue: ReturnType<typeof vi.fn<(key: string, value: unknown) => Promise<void>>>
		setValues: ReturnType<typeof vi.fn<(values: Record<string, unknown>) => Promise<void>>>
	}
}

const activeInstances = () => (AlphaProvider as unknown as { activeInstances: Set<AlphaProvider> }).activeInstances
interface ProviderFixture extends SharedFixture {
	provider: AlphaProvider
	task: {
		taskId: string
		setMemoryGenerationEnabled: ReturnType<typeof vi.fn<() => Promise<void>>>
		beginTaskCancellation: ReturnType<typeof vi.fn<() => { termination: Promise<void> }>>
	}
	history: HistoryItem[]
	historyDisposed: ReturnType<typeof vi.fn<() => Promise<void>>>
}

const fixtures: ProviderFixture[] = []
let storage: string
let nextTaskId = 0

function fixture(settings?: Partial<MemorySettings>, shared?: SharedFixture): ProviderFixture {
	const state: Record<string, unknown> = shared?.state ?? {
		memorySettings: settings === undefined ? undefined : memorySettingsSchema.parse(settings),
	}
	const store: SharedFixture["store"] = shared?.store ?? {
		home: path.join(storage, "alpha-home"),
		rootPath: path.join(storage, "alpha-home", "memories_v2"),
		initialize: vi.fn(async () => undefined),
		reset: vi.fn(async () => undefined),
		addAdHocNote: vi.fn(async () => "ad_hoc_notes/note.md"),
	}
	const contextProxy = shared?.contextProxy ?? {
		globalStorageUri: { fsPath: storage },
		getValue: vi.fn((key: string) => state[key]),
		setValue: vi.fn(async (key: string, value: unknown) => {
			state[key] = value
		}),
		setValues: vi.fn(async (values: Record<string, unknown>) => {
			Object.assign(state, values)
		}),
	}
	const task = {
		taskId: `current-${++nextTaskId}`,
		setMemoryGenerationEnabled: vi.fn(async () => undefined),
		beginTaskCancellation: vi.fn(() => ({ termination: Promise.resolve() })),
	}
	const history: HistoryItem[] = []
	const historyDisposed = vi.fn(async () => undefined)
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		context: { secrets: {}, subscriptions: [] },
		contextProxy,
		memoryStore: store as unknown as MemoryStore,
		memorySettingsSnapshot: memorySettingsSchema.parse(state.memorySettings ?? {}),
		memorySourceProviders: new Map(),
		getCurrentTask: vi.fn(() => task),
		getProviderSettingsSnapshot: vi.fn(() => ({ apiProvider: "fake-ai" })),
		taskHistoryStoreReady: Promise.resolve(),
		taskHistoryStore: { getAll: () => history, dispose: historyDisposed },
		taskSessions: {
			getLiveTaskIds: vi.fn(() => [task.taskId]),
			getOwnedTasks: vi.fn(() => [task]),
			disposeView: vi.fn(),
		},
		taskStack: [task],
		taskCreationQueue: Promise.resolve(),
		webviewMessageQueue: Promise.resolve(),
		taskControlMessageQueues: new Map(),
		immediateWebviewOperations: new Set(),
		subagentRunFinalizations: new Map(),
		subagentResidencyEvictions: new Map(),
		disposables: [],
		clearWebviewResources: vi.fn(),
		closeAgentLifecycleJournals: vi.fn(async () => undefined),
		removeTaskFromStack: vi.fn(async () => undefined),
		postStateToWebview: vi.fn(async () => undefined),
		providerSettingsManager: { saveConfig: vi.fn(async () => undefined) },
		mcpHubInitialization: Promise.resolve(),
		flushGlobalStateWriteThrough: vi.fn(async () => undefined),
		log: vi.fn(),
	}) as AlphaProvider
	activeInstances().add(provider)
	const result = { provider, state, store, contextProxy, task, history, historyDisposed }
	fixtures.push(result)
	return result
}

const historyItem = (id: string, overrides: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1_700_000_000_000,
	task: "Saved source",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...overrides,
})

beforeEach(async () => {
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-provider-memory-"))
	memory.coordinators.length = 0
})

afterEach(async () => {
	for (const item of fixtures.splice(0)) activeInstances().delete(item.provider)
	await fs.rm(storage, { recursive: true, force: true })
	vi.restoreAllMocks()
})

describe("AlphaProvider memory lifecycle", () => {
	it("keeps default/off activation disk-free and preserves subordinate preferences", async () => {
		const { provider, store } = fixture()
		await provider.refreshMemorySettings()
		expect(provider.getMemorySettings()).toMatchObject({
			enabled: false,
			useMemories: true,
			generateMemories: true,
		})
		expect(memory.coordinators).toHaveLength(0)
		expect(store.initialize).not.toHaveBeenCalled()
		expect(store.reset).not.toHaveBeenCalled()
		await expect(provider.addMemoryNote("do not persist")).rejects.toThrow("disabled")
		expect(store.addAdHocNote).not.toHaveBeenCalled()
	})

	it("updates the displayed generation preference while preserving sibling threads and master-off choices", async () => {
		const first = fixture({ enabled: true })
		const sibling = fixture(undefined, first)
		await first.provider.refreshMemorySettings()
		await sibling.provider.refreshMemorySettings()
		expect(memory.coordinators).toHaveLength(1)

		await sibling.provider.setValue(
			"memorySettings",
			memorySettingsSchema.parse({ enabled: true, generateMemories: false }),
		)
		expect(sibling.task.setMemoryGenerationEnabled).toHaveBeenCalledExactlyOnceWith(false)
		expect(first.task.setMemoryGenerationEnabled).not.toHaveBeenCalled()
		await first.provider.refreshMemorySettings()
		expect(first.task.setMemoryGenerationEnabled).not.toHaveBeenCalled()

		await sibling.provider.setValue(
			"memorySettings",
			memorySettingsSchema.parse({ enabled: false, generateMemories: false }),
		)
		expect(sibling.task.setMemoryGenerationEnabled).toHaveBeenCalledTimes(1)
		expect(sibling.store.reset).not.toHaveBeenCalled()
		await expect(first.provider.addMemoryNote("off")).rejects.toThrow("disabled")
	})

	it("refreshes memory after API configuration persistence through the existing settings boundary", async () => {
		const { provider } = fixture()
		const api = new API({ appendLine: vi.fn() } as never, provider)
		await api.setConfiguration({ memorySettings: memorySettingsSchema.parse({ enabled: true }) })
		expect(memory.coordinators).toHaveLength(1)
		expect(provider.getMemorySettings().enabled).toBe(true)
		await provider.setValues({ memorySettings: memorySettingsSchema.parse({ enabled: false }) })
		expect(memory.coordinators[0].dispose).toHaveBeenCalledOnce()
	})

	it("retries a failed displayed-thread preference without acknowledging it as saved", async () => {
		const { provider, task } = fixture({ enabled: true })
		await provider.refreshMemorySettings()
		task.setMemoryGenerationEnabled.mockRejectedValueOnce(new Error("Preference save failed"))
		const disabled = memorySettingsSchema.parse({ enabled: true, generateMemories: false })
		await expect(provider.setValue("memorySettings", disabled)).rejects.toThrow("Preference save failed")
		await provider.setValue("memorySettings", disabled)
		expect(task.setMemoryGenerationEnabled).toHaveBeenCalledTimes(2)
		expect(task.setMemoryGenerationEnabled).toHaveBeenLastCalledWith(false)
	})

	it("continues recording retrieval usage when generation is disabled", async () => {
		const { provider } = fixture({ enabled: true, generateMemories: false })
		await provider.refreshMemorySettings()
		await provider.recordMemoryUsage(["saved-source"])
		expect(memory.coordinators).toHaveLength(1)
		expect(memory.coordinators[0].recordUsage).toHaveBeenCalledExactlyOnceWith(["saved-source"])
	})

	it("forwards the finalized assistant's host-derived citation receipt without requiring dedicated tools", async () => {
		const { provider } = fixture({ enabled: true, dedicatedTools: false })
		await provider.refreshMemorySettings()
		const eventKey = "a".repeat(64)
		await provider.recordMemoryUsage(["saved-source"], eventKey)
		expect(memory.coordinators[0].recordUsage).toHaveBeenCalledExactlyOnceWith(["saved-source"], eventKey)
	})

	it("serializes reset against sibling notes and settings refreshes", async () => {
		const first = fixture({ enabled: true })
		const sibling = fixture(undefined, first)
		await first.provider.refreshMemorySettings()
		const entered = deferred()
		const release = deferred()
		first.store.reset.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
		})
		const reset = first.provider.resetMemories()
		await entered.promise
		const note = sibling.provider.addMemoryNote("keep this")
		const refresh = sibling.provider.refreshMemorySettings()
		expect(memory.coordinators[0].dispose).toHaveBeenCalledOnce()
		expect(memory.coordinators).toHaveLength(1)
		expect(first.store.addAdHocNote).not.toHaveBeenCalled()
		release.resolve()
		await Promise.all([reset, note, refresh])
		expect(memory.coordinators).toHaveLength(2)
		expect(first.store.addAdHocNote).toHaveBeenCalledExactlyOnceWith("keep this", undefined)
	})

	it("does not persist a note cancelled while waiting for a sibling reset", async () => {
		const first = fixture({ enabled: true })
		const sibling = fixture(undefined, first)
		const entered = deferred()
		const release = deferred()
		first.store.reset.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
		})
		const reset = first.provider.resetMemories()
		await entered.promise
		const controller = new AbortController()
		const note = sibling.provider.addMemoryNote("cancelled", controller.signal)
		const outcome = Promise.allSettled([note])
		controller.abort()
		release.resolve()
		await reset
		expect((await outcome)[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } })
		expect(first.store.addAdHocNote).not.toHaveBeenCalled()
	})

	it("inventories legacy root sources across views, excluding child and diagnostic conversations", async () => {
		const first = fixture({ enabled: true })
		const sibling = fixture(undefined, first)
		first.history.push(
			historyItem("old-root"),
			historyItem("child", { parentTaskId: "old-root" }),
			historyItem("worker", { taskKind: "subagent" }),
		)
		sibling.history.push(
			historyItem("diagnostic", { diagnosticSession: true }),
			historyItem("root"),
			historyItem("hidden-child", { rootTaskId: "root" }),
			historyItem(sibling.task.taskId),
		)
		await first.provider.refreshMemorySettings()
		const sources = await memory.coordinators[0].options.listSources()
		expect(sources.map((source) => source.id).sort()).toEqual([sibling.task.taskId, "old-root", "root"].sort())
		expect(sources.find((source) => source.id === "old-root")).toMatchObject({
			generateMemories: true,
			active: false,
			updatedAt: 1_700_000_000_000,
		})
		expect(sources.find((source) => source.id === sibling.task.taskId)?.active).toBe(true)
	})

	it("rechecks durable opt-out, source timestamp, and identity instead of trusting the cached inventory", async () => {
		const { provider, history } = fixture({ enabled: true })
		const original = historyItem("source")
		history.push(original)
		const directory = path.join(storage, "tasks", original.id)
		await fs.mkdir(directory, { recursive: true })
		const file = path.join(directory, "history_item.json")
		await fs.writeFile(file, JSON.stringify(original))
		await provider.refreshMemorySettings()
		const options = memory.coordinators[0].options
		const [source] = await options.listSources()
		await expect(options.isSourceCurrent(source)).resolves.toBe(true)
		await fs.writeFile(file, JSON.stringify({ ...original, ts: original.ts + 1 }))
		await expect(options.isSourceCurrent(source)).resolves.toBe(false)
		await fs.writeFile(
			file,
			JSON.stringify({ ...original, memory: { version: "v2", useMemories: true, generateMemories: false } }),
		)
		await expect(options.isSourceCurrent(source)).resolves.toBe(false)
		await fs.writeFile(file, JSON.stringify({ ...original, id: "other" }))
		await expect(options.isSourceCurrent(source)).resolves.toBe(false)
	})

	it("signals foreground cancellation before joining background disposal, then hands ownership to a sibling", async () => {
		const first = fixture({ enabled: true })
		const sibling = fixture(undefined, first)
		await first.provider.refreshMemorySettings()
		const release = deferred()
		memory.coordinators[0].dispose.mockReturnValueOnce(release.promise)
		const disposal = first.provider.dispose()
		expect(first.task.beginTaskCancellation).toHaveBeenCalledExactlyOnceWith(true)
		expect(first.historyDisposed).not.toHaveBeenCalled()
		release.resolve()
		await disposal
		expect(first.historyDisposed).toHaveBeenCalledOnce()
		expect(memory.coordinators).toHaveLength(2)
		await sibling.provider.refreshMemorySettings()
		expect(memory.coordinators).toHaveLength(2)
	})
})
