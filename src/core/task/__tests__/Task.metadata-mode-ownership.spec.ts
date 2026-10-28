import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@alpha-code/types"

import { taskMetadata } from "../../task-persistence/taskMetadata"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"
import { WorkspaceMutationGate } from "../WorkspaceMutationGate"

vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureModeSwitch: vi.fn() } } }))
vi.mock("../../../utils/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/storage")>()),
	getStorageBasePath: async (storagePath: string) => storagePath,
}))
vi.mock("../../task-persistence/taskMetadata", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-persistence/taskMetadata")>()),
	taskMetadata: vi.fn((await importOriginal<typeof import("../../task-persistence/taskMetadata")>()).taskMetadata),
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

describe("Task metadata mode ownership", () => {
	let storage: string
	let stores: TaskHistoryStore[]

	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-mode-ownership-"))
		stores = []
	})

	afterEach(async () => {
		await Promise.all(stores.map((store) => store.dispose()))
		vi.restoreAllMocks()
		if (!path.resolve(storage).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
			throw new Error("Refusing to remove a non-temporary test directory")
		}
		await fs.rm(storage, { recursive: true, force: true })
	})

	const makeStore = async (storagePath: string, ownedStores: TaskHistoryStore[]) => {
		const store = new TaskHistoryStore(storagePath)
		ownedStores.push(store)
		await store.initialize()
		return store
	}

	const makeHarness = async (mode: string, status?: HistoryItem["status"]) => {
		const store = await makeStore(storage, stores)
		const item: HistoryItem = {
			id: "mode-owner",
			number: 1,
			ts: 1,
			task: "Preserve the selected mode",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: storage,
			mode,
			...(status ? { status } : {}),
		}
		await store.upsert(item)
		const provider = Object.assign(Object.create(AlphaProvider.prototype), {
			taskHistoryStore: store,
			taskHistoryStoreReady: Promise.resolve(),
			taskLifecycleHistoryWrites: new Map(),
			taskSessions: { markLifecycle: vi.fn() },
			agentControlStoreReady: Promise.resolve(),
			agentControlStore: { getAgent: () => undefined },
			workspaceMutationGate: new WorkspaceMutationGate(),
			isViewLaunched: false,
			currentWorkspacePath: storage,
			postTaskSessionStateToWebview: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as AlphaProvider
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: item.id,
			taskNumber: 1,
			taskKind: "primary",
			globalStoragePath: storage,
			historyWorkspacePath: storage,
			_taskMode: mode,
			taskModeReady: Promise.resolve(),
			_taskApiConfigName: "default",
			alphaMessagesSaveQueue: Promise.resolve(),
			alphaMessagesHydrated: true,
			alphaMessages: [],
			providerRef: { deref: () => provider },
			invalidateBackgroundUsageDrain: vi.fn(),
			debouncedEmitTokenUsage: vi.fn(),
			emit: vi.fn(),
			hasActiveCommandExecutions: () => false,
			hasPendingAsk: () => false,
		}) as Task
		Reflect.set(provider, "getLiveTask", (taskId: string) => (taskId === task.taskId ? task : undefined))
		return { store, item, provider, task }
	}

	it.each([
		{ originalMode: "code", selectedMode: "architect" },
		{ originalMode: "architect", selectedMode: "code" },
	])(
		"retains an explicit $selectedMode selection after an older transcript save",
		async ({ originalMode, selectedMode }) => {
			const { store, item, provider, task } = await makeHarness(originalMode)
			const entered = deferred()
			const released = deferred()
			const originalMetadata = (
				await vi.importActual<typeof import("../../task-persistence/taskMetadata")>(
					"../../task-persistence/taskMetadata",
				)
			).taskMetadata
			vi.mocked(taskMetadata).mockImplementationOnce(async (options) => {
				const metadata = await originalMetadata(options)
				entered.resolve()
				await released.promise
				return metadata
			})
			const save = task.overwriteAlphaMessages([{ ts: 2, type: "say", say: "text", text: item.task }])
			try {
				await entered.promise
				await provider.setTaskMode(task.taskId, selectedMode, { postState: false })
				expect(task.taskMode).toBe(selectedMode)
				expect(store.get(item.id)?.mode).toBe(selectedMode)
			} finally {
				released.resolve()
			}
			expect(await save).toBe(true)
			const reloaded = await makeStore(storage, stores)
			expect(reloaded.get(item.id)?.mode).toBe(selectedMode)
		},
	)

	it.each([
		{ originalMode: "code", selectedMode: "architect" },
		{ originalMode: "architect", selectedMode: "code" },
	])("retains $selectedMode after a delayed lifecycle status projection", async ({ originalMode, selectedMode }) => {
		const { item, provider, task } = await makeHarness(originalMode, "interrupted")
		const entered = deferred()
		const released = deferred()
		const projected = deferred()
		const updateHistory = provider.updateTaskHistory.bind(provider)
		vi.spyOn(provider, "updateTaskHistory").mockImplementation(async (updated, options) => {
			if (updated.status !== "active") return updateHistory(updated, options)
			entered.resolve()
			await released.promise
			try {
				return await updateHistory(updated, options)
			} finally {
				projected.resolve()
			}
		})
		provider.markCompletionWait(task.taskId, "verification")
		try {
			await entered.promise
			await provider.setTaskMode(task.taskId, selectedMode, { postState: false })
			expect(task.taskMode).toBe(selectedMode)
		} finally {
			released.resolve()
		}
		await projected.promise
		const reloaded = await makeStore(storage, stores)
		expect(reloaded.get(item.id)).toMatchObject({ mode: selectedMode, status: "active" })
	})
})
