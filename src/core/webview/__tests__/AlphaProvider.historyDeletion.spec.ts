import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { managedSubagentWorktreeService } from "@alpha-code/core"
import { TaskLifecycleState } from "@alpha-code/types"
import type { ExtensionMessage, HistoryItem, WebviewMessage } from "@alpha-code/types"

import { ShadowCheckpointService } from "../../../services/checkpoints/ShadowCheckpointService"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { AgentLifecycleJournal } from "../../agent/lifecycle/AgentLifecycleJournal"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("vscode", async (original) => {
	const actual = await original<typeof vscode>()
	return {
		...actual,
		ProgressLocation: { Notification: 15 },
		window: { ...actual.window, withProgress: vi.fn((_options, run) => run()) },
	}
})

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

describe("project chat deletion", () => {
	let storage: string
	let workspace: string
	let store: TaskHistoryStore
	let stores: TaskHistoryStore[]
	let provider: AlphaProvider
	let legacyHistory: HistoryItem[]
	let live: Set<string>
	let peers: AlphaProvider[]
	let sessions: TaskSessionRegistry
	let post: ReturnType<typeof vi.fn<(message: ExtensionMessage) => Promise<void>>>

	const historyPath = (id: string) => path.join(storage, "tasks", id, GlobalFileNames.historyItem)
	const seed = async (id: string, overrides: Partial<HistoryItem> = {}) => {
		const item: HistoryItem = {
			id,
			number: 1,
			ts: 1_000,
			task: `Saved fixture ${id}`,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace,
			...overrides,
		}
		await store.upsert(item)
		legacyHistory.push(item)
		return item
	}
	const deleteSelected = (ids: string[]) =>
		webviewMessageHandler(provider, { type: "deleteMultipleTasksWithIds", ids })

	const openHistoryPeer = async () => {
		const peerStore = new TaskHistoryStore(storage)
		stores.push(peerStore)
		await peerStore.initialize()
		const peerPost = vi.fn()
		const peer = Object.assign(Object.create(AlphaProvider.prototype), {
			currentWorkspacePath: workspace,
			taskHistoryStore: peerStore,
			taskHistoryMetadataReady: Promise.resolve(),
			webviewLaunchWaiters: new Set(),
			isViewLaunched: true,
			scheduleGlobalStateWriteThrough: vi.fn(),
			postMessageToWebview: peerPost,
		}) as AlphaProvider
		peers.push(peer)
		return { peerStore, peerPost }
	}

	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-bulk-chat-delete-"))
		workspace = path.join(storage, "project")
		store = new TaskHistoryStore(storage)
		stores = [store]
		await store.initialize()
		legacyHistory = []
		live = new Set()
		sessions = TaskSessionRegistry.forGlobalStorage(storage)
		post = vi.fn(async () => undefined)
		vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
		vi.spyOn(ShadowCheckpointService, "deleteTask").mockResolvedValue(undefined)
		vi.spyOn(managedSubagentWorktreeService, "deleteArtifactsForTasks").mockResolvedValue(undefined)
		provider = Object.assign(Object.create(AlphaProvider.prototype), {
			currentWorkspacePath: workspace,
			taskHistoryStore: store,
			taskHistoryMetadataReady: Promise.resolve(),
			taskHistoryStoreReady: Promise.resolve(),
			taskHistoryStoreInitialized: true,
			taskLifecycleHistoryWrites: new Map(),
			agentLifecycleJournals: new Map(),
			taskSessions: sessions,
			contextProxy: {
				globalStorageUri: { fsPath: storage },
				getValue: (key: string) => (key === "taskHistory" ? legacyHistory : undefined),
			},
			getHostProviders: () => peers,
			getLiveTask: (id: string) => (live.has(id) ? { taskId: id } : undefined),
			removeTaskFromStack: vi.fn(async ({ taskId }: { taskId: string }) => {
				live.delete(taskId)
			}),
			purgeDeletedAgentControlRoots: vi.fn().mockResolvedValue([]),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: post,
			webviewLaunchWaiters: new Set(),
			isViewLaunched: true,
			webviewMessageQueue: Promise.resolve(),
			immediateWebviewOperations: new Set(),
			webviewDisposables: [],
			scheduleGlobalStateWriteThrough: vi.fn(),
			log: vi.fn(),
		}) as AlphaProvider
		peers = [provider]
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		sessions.disposeView()
		await Promise.all(stores.map((history) => history.dispose()))
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("deletes 45 saved chats in a single history batch, with one projection and artifact scan", async () => {
		const ids = Array.from({ length: 45 }, (_, index) => `selected-${index}`)
		for (const id of ids) await seed(id)
		await seed("keep")
		const commits = vi.spyOn(store, "deleteMany")

		await deleteSelected(ids)

		// This workload used to perform 45 catalog batches, 45 artifact scans and 48 full state posts.
		expect(store.getAll().map(({ id }) => id)).toEqual(["keep"])
		expect(commits).toHaveBeenCalledOnce()
		expect(commits.mock.calls[0]?.[0]).toEqual(ids)
		expect(managedSubagentWorktreeService.deleteArtifactsForTasks).toHaveBeenCalledExactlyOnceWith(storage, ids)
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
		expect(post).toHaveBeenCalledExactlyOnceWith({ type: "taskHistoryUpdated", taskHistory: [store.get("keep")] })
		await store.flushIndex()
		const reloaded = new TaskHistoryStore(storage)
		stores.push(reloaded)
		await reloaded.initialize()
		expect(reloaded.getAll().map(({ id }) => id)).toEqual(["keep"])
	})

	it("deletes eligible chats once and keeps open subtrees and other projects", async () => {
		await seed("parent", { childIds: ["child", "child"] })
		await seed("child", { parentTaskId: "parent", childIds: ["parent"] })
		await seed("open-parent", { childIds: ["open-child"] })
		await seed("open-child", { parentTaskId: "open-parent" })
		await seed("other", { workspace: path.join(storage, "other-project") })
		live.add("open-child")
		const commits = vi.spyOn(store, "deleteMany")

		await deleteSelected(["parent", "child", "parent", "open-parent", "other"])

		expect(commits).toHaveBeenCalledOnce()
		expect(commits.mock.calls[0]?.[0]).toEqual(["parent", "child"])
		expect(
			store
				.getAll()
				.map(({ id }) => id)
				.sort(),
		).toEqual(["open-child", "open-parent", "other"])
		expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
		expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce()
	})

	it("joins a queued lifecycle write before deleting a closed chat", async () => {
		await seed("closing", { status: "active" })
		const writing = barrier()
		const releaseWrite = barrier()
		const deleting = barrier()
		const originalUpsert = store.upsert.bind(store)
		const originalDeletion = sessions.runHistoryDeletion.bind(sessions)
		vi.spyOn(store, "upsert").mockImplementationOnce(async (...args) => {
			writing.resolve()
			await releaseWrite.promise
			return originalUpsert(...args)
		})
		vi.spyOn(sessions, "runHistoryDeletion").mockImplementation((ids, operation) => {
			deleting.resolve()
			return originalDeletion(ids, operation)
		})
		const deleteMany = vi.spyOn(store, "deleteMany")
		provider["queueTaskLifecycleHistoryStatus"]("closing", TaskLifecycleState.Closed)
		await writing.promise
		const removed = provider.deleteTasksWithIds(["closing"])
		try {
			await deleting.promise
			expect(deleteMany).not.toHaveBeenCalled()
		} finally {
			releaseWrite.resolve()
			await removed
		}
		expect(store.get("closing")).toBeUndefined()
		await expect(fs.access(path.dirname(historyPath("closing")))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each(["single", "batch"] as const)(
		"does not restore a deleted chat's lifecycle snapshot during view shutdown after %s deletion",
		async (operation) => {
			const task = await seed("with-journal")
			const journal = await AgentLifecycleJournal.open(task.id, storage)
			await journal.append({
				version: 1,
				eventId: "phase-1",
				taskId: task.id,
				runId: "run-1",
				turnId: "turn-1",
				occurredAt: 1,
				type: "phase_changed",
				payload: { phase: "working" },
			})
			provider["agentLifecycleJournals"].set(task.id, Promise.resolve(journal))
			const peerJournal = await AgentLifecycleJournal.open(task.id, storage)
			const peer = Object.assign(Object.create(AlphaProvider.prototype), {
				_disposed: true,
				agentLifecycleJournals: new Map([[task.id, Promise.resolve(peerJournal)]]),
				log: vi.fn(),
			}) as AlphaProvider
			peers.push(peer)

			if (operation === "single") await provider.deleteTaskWithId(task.id)
			else await provider.deleteTasksWithIds([task.id])
			await expect(fs.access(path.dirname(historyPath(task.id)))).rejects.toMatchObject({ code: "ENOENT" })

			await provider["closeAgentLifecycleJournals"]()
			await peer["closeAgentLifecycleJournals"]()
			await expect(fs.access(path.dirname(historyPath(task.id)))).rejects.toMatchObject({ code: "ENOENT" })
		},
	)

	it("publishes committed history while cleanup is pending and refuses to reopen deleted metadata", async () => {
		const selected = await seed("deleted")
		const kept = await seed("keep")
		const { peerStore, peerPost } = await openHistoryPeer()
		expect(peerStore.get(selected.id)).toEqual(selected)
		const cleanupStarted = barrier()
		const releaseCleanup = barrier()
		vi.mocked(managedSubagentWorktreeService.deleteArtifactsForTasks).mockImplementationOnce(async () => {
			cleanupStarted.resolve()
			await releaseCleanup.promise
		})
		let receive!: (message: WebviewMessage) => Promise<void>
		provider["setWebviewMessageListener"]({
			onDidReceiveMessage(handler) {
				receive = handler
				return { dispose: () => undefined }
			},
		} as vscode.Webview)
		vi.spyOn(provider, "exportTaskWithId").mockResolvedValue(undefined)
		const deleting = receive({ type: "deleteMultipleTasksWithIds", ids: [selected.id] })
		try {
			await Promise.race([cleanupStarted.promise, deleting])
			expect(post).toHaveBeenCalledExactlyOnceWith({ type: "taskHistoryUpdated", taskHistory: [kept] })
			expect(peerPost).toHaveBeenCalledExactlyOnceWith({ type: "taskHistoryUpdated", taskHistory: [kept] })
			await expect(provider.getTaskWithId(selected.id, { includeApiConversationHistory: false })).rejects.toThrow(
				"Task not found",
			)
			await expect(provider.createTaskWithHistoryItem(selected)).rejects.toThrow("being deleted")
			await expect(provider["getAgentLifecycleJournal"](selected.id)).rejects.toThrow("being deleted")
			const exported = receive({ type: "exportTaskWithId", text: kept.id })
			expect(provider["webviewMessageQueue"]).not.toBe(deleting)
			await exported
			expect(provider.exportTaskWithId).toHaveBeenCalledExactlyOnceWith(kept.id)
		} finally {
			releaseCleanup.resolve()
			await deleting
		}
		// An already queued restore is not allowed to resurrect the history either.
		await expect(provider.getTaskWithId(selected.id)).rejects.toThrow("Task not found")
	})

	it.each(["deleteTaskWithId", "deleteTaskFromState"] as const)(
		"publishes %s to both views before agent cleanup",
		async (deleteTask) => {
			const selected = await seed("deleted")
			const kept = await seed("keep")
			const { peerStore, peerPost } = await openHistoryPeer()
			expect(peerStore.get(selected.id)).toEqual(selected)

			const cleanupStarted = barrier()
			const releaseCleanup = barrier()
			vi.mocked(provider["purgeDeletedAgentControlRoots"]).mockImplementationOnce(async () => {
				cleanupStarted.resolve()
				await releaseCleanup.promise
				return []
			})

			const deleting = provider[deleteTask](selected.id)
			try {
				await Promise.race([cleanupStarted.promise, deleting])
				await expect(fs.access(historyPath(selected.id))).rejects.toMatchObject({ code: "ENOENT" })
				expect(peerStore.getAll()).toEqual([kept])
				const projection = { type: "taskHistoryUpdated", taskHistory: [kept] }
				expect(post).toHaveBeenCalledExactlyOnceWith(projection)
				expect(peerPost).toHaveBeenCalledExactlyOnceWith(projection)
			} finally {
				releaseCleanup.resolve()
				await deleting
			}
		},
	)

	it("publishes committed history when single deletion fails to remove a child", async () => {
		const root = await seed("parent", { childIds: ["denied"] })
		const denied = await seed("denied", { parentTaskId: root.id })
		const { peerStore, peerPost } = await openHistoryPeer()
		const deniedPath = historyPath(denied.id)
		await fs.rename(deniedPath, `${deniedPath}.kept`)
		await fs.mkdir(deniedPath)

		await expect(provider.deleteTaskWithId(root.id)).rejects.toBeInstanceOf(Error)

		expect(store.getAll()).toEqual([denied])
		expect(peerStore.getAll()).toEqual([denied])
		expect(peerPost).toHaveBeenCalledExactlyOnceWith({ type: "taskHistoryUpdated", taskHistory: [denied] })
		expect(provider["purgeDeletedAgentControlRoots"]).not.toHaveBeenCalled()
	})

	it("still removes successful chats and reports an I/O failure without waiting for the notification", async () => {
		await seed("denied")
		await seed("deleted")
		// A directory cannot be unlinked as a file, on Windows or POSIX.
		const denied = historyPath("denied")
		await fs.rename(denied, `${denied}.kept`)
		await fs.mkdir(denied)
		const notification = barrier()
		vi.mocked(vscode.window.showWarningMessage).mockReturnValue(notification.promise as Promise<undefined>)
		try {
			await deleteSelected(["denied", "deleted"])
			await expect(fs.readFile(`${denied}.kept`, "utf8")).resolves.toContain("denied")
			expect(store.get("denied")).toBeDefined()
			await expect(fs.access(path.dirname(historyPath("deleted")))).rejects.toMatchObject({ code: "ENOENT" })
			expect(managedSubagentWorktreeService.deleteArtifactsForTasks).toHaveBeenCalledExactlyOnceWith(storage, [
				"deleted",
			])
			expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce()
		} finally {
			notification.resolve()
		}
	})

	it("ignores a malformed batch without deleting a valid prefix", async () => {
		const item = await seed("keep")
		await webviewMessageHandler(provider, {
			type: "deleteMultipleTasksWithIds",
			ids: [item.id, null],
		} as WebviewMessage)
		expect(store.get(item.id)).toEqual(item)
	})

	it("captures the project before joining startup and protects a chat being admitted", async () => {
		await seed("local")
		const admitting = await seed("admitting")
		const foreignWorkspace = path.join(storage, "other-project")
		await seed("foreign", { workspace: foreignWorkspace })
		const releaseAdmission = sessions.reserveTaskAdmission(admitting.id)
		const ready = barrier()
		Object.assign(provider, { taskHistoryStoreReady: ready.promise })
		const deleting = deleteSelected(["local", admitting.id, "foreign"])
		Object.assign(provider, { currentWorkspacePath: foreignWorkspace })
		try {
			ready.resolve()
			await deleting
			expect(
				store
					.getAll()
					.map(({ id }) => id)
					.sort(),
			).toEqual(["admitting", "foreign"])
			expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce()
		} finally {
			releaseAdmission()
		}
	})
})
