import { FileContextTracker } from "../FileContextTracker"
import { taskMetadataSchema, type FileMetadataEntry, type TaskMetadata } from "../FileContextTrackerTypes"
import type { AlphaProvider } from "../../webview/AlphaProvider"
import * as vscode from "vscode"
import * as path from "path"

const host = vi.hoisted(() => ({ folders: [] as Array<{ uri: { fsPath: string } }> }))

vi.mock("vscode", () => ({
	workspace: {
		get workspaceFolders() {
			return host.folders
		},
		createFileSystemWatcher: vi.fn(),
	},
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	RelativePattern: class {
		constructor(
			readonly base: string,
			readonly pattern: string,
		) {}
	},
}))

const taskCwd = path.resolve("tracker-task-worktree")

function createWatcher() {
	let change: ((uri: vscode.Uri) => unknown) | undefined
	const watcher = {
		ignoreCreateEvents: false,
		ignoreChangeEvents: false,
		ignoreDeleteEvents: false,
		onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
		onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChange: vi.fn((listener: (uri: vscode.Uri) => unknown) => {
			change = listener
			return { dispose: vi.fn() }
		}),
		dispose: vi.fn(),
	}
	return { watcher, fireChange: () => change?.(vscode.Uri.file(path.join(taskCwd, "src/one.ts"))) }
}

beforeEach(() => {
	host.folders = [{ uri: { fsPath: path.resolve("editor-first-root") } }]
	vi.mocked(vscode.workspace.createFileSystemWatcher).mockReset()
	vi.mocked(vscode.workspace.createFileSystemWatcher).mockImplementation(() => createWatcher().watcher)
})

afterEach(() => {
	vi.restoreAllMocks()
})

function createTracker(): FileContextTracker {
	const tracker = new FileContextTracker({} as AlphaProvider, "task-1", taskCwd)
	vi.spyOn(tracker, "getTaskMetadata").mockResolvedValue({ files_in_context: [] })
	vi.spyOn(tracker, "saveTaskMetadata").mockResolvedValue()
	return tracker
}

function createPersistedTracker(initialMetadata: TaskMetadata = { files_in_context: [] }) {
	const tracker = createTracker()
	let persisted = structuredClone(initialMetadata)
	vi.mocked(tracker.getTaskMetadata).mockImplementation(async () => structuredClone(persisted))
	vi.mocked(tracker.saveTaskMetadata).mockImplementation(async (_taskId, metadata) => {
		persisted = structuredClone(metadata)
	})
	return { tracker, metadata: () => persisted }
}

function legacyEntry(overrides: Partial<FileMetadataEntry> = {}): FileMetadataEntry {
	return {
		path: "src/one.ts",
		record_state: "stale",
		record_source: "read_tool",
		roo_read_date: 100,
		roo_edit_date: null,
		user_edit_date: null,
		...overrides,
	}
}

async function markUserEditedFile(tracker: FileContextTracker, filePath: string): Promise<void> {
	await tracker.addFileToFileContextTracker("task-1", filePath, "user_edited")
}

describe("FileContextTracker metadata updates", () => {
	it("serializes concurrent read-modify-write transactions so neither file record is lost", async () => {
		const tracker = createTracker()
		let persisted: TaskMetadata = { files_in_context: [] }
		let releaseFirstSave!: () => void
		let markFirstSaveStarted!: () => void
		const firstSaveStarted = new Promise<void>((resolve) => {
			markFirstSaveStarted = resolve
		})
		const firstSaveGate = new Promise<void>((resolve) => {
			releaseFirstSave = resolve
		})

		const readSpy = vi.spyOn(tracker, "getTaskMetadata").mockImplementation(async () => structuredClone(persisted))
		let saveCount = 0
		vi.spyOn(tracker, "saveTaskMetadata").mockImplementation(async (_taskId, metadata) => {
			saveCount++
			if (saveCount === 1) {
				markFirstSaveStarted()
				await firstSaveGate
			}
			persisted = structuredClone(metadata)
		})

		const firstUpdate = tracker.addFileToFileContextTracker("task-1", "src/one.ts", "read_tool")
		await firstSaveStarted
		const secondUpdate = tracker.addFileToFileContextTracker("task-1", "src/two.ts", "read_tool")
		await Promise.resolve()

		expect(readSpy).toHaveBeenCalledTimes(1)
		releaseFirstSave()
		await Promise.all([firstUpdate, secondUpdate])

		expect(persisted.files_in_context.map(({ path }) => path)).toEqual(["src/one.ts", "src/two.ts"])
		expect(readSpy).toHaveBeenCalledTimes(2)
	})

	it("bounds repeated reads to one record while preserving the latest read timestamp", async () => {
		const { tracker, metadata } = createPersistedTracker()
		const now = vi.spyOn(Date, "now")
		for (let index = 0; index < 128; index++) {
			now.mockReturnValue(1_700_000_000_000 + index)
			await tracker.addFileToFileContextTracker("task-1", "src/repeated.ts", "read_tool")
		}

		expect(metadata().files_in_context).toEqual([
			expect.objectContaining({
				path: "src/repeated.ts",
				record_state: "active",
				record_source: "read_tool",
				roo_read_date: 1_700_000_000_127,
			}),
		])
		expect(await tracker.getFilesReadByAlpha(1_700_000_000_127)).toEqual(["src/repeated.ts"])
		expect(await tracker.getFilesReadByAlpha(1_700_000_000_128)).toEqual([])
	})

	it("folds legacy repeated sources without losing read, edit, or user-change evidence", async () => {
		const { tracker, metadata } = createPersistedTracker({
			files_in_context: [
				legacyEntry(),
				legacyEntry({ roo_read_date: 200, roo_edit_date: 150, user_edit_date: 180 }),
				legacyEntry({ record_source: "file_mentioned", roo_read_date: 300 }),
				legacyEntry({ record_source: "roo_edited", roo_read_date: 400, roo_edit_date: 400 }),
				legacyEntry({
					record_source: "user_edited",
					record_state: "active",
					roo_read_date: 400,
					roo_edit_date: 400,
					user_edit_date: 450,
				}),
				legacyEntry({ path: "src/two.ts", record_state: "active", roo_read_date: 350 }),
			],
		})
		vi.spyOn(Date, "now").mockReturnValue(500)

		await tracker.addFileToFileContextTracker("task-1", "src/one.ts", "user_edited")

		expect(metadata().files_in_context.filter((entry) => entry.path === "src/one.ts")).toHaveLength(4)
		expect(metadata().files_in_context.filter((entry) => entry.record_state === "active")).toEqual([
			legacyEntry({ path: "src/two.ts", record_state: "active", roo_read_date: 350 }),
			expect.objectContaining({
				path: "src/one.ts",
				record_source: "user_edited",
				roo_read_date: 400,
				roo_edit_date: 400,
				user_edit_date: 500,
			}),
		])
		expect(metadata().files_in_context).toContainEqual(
			legacyEntry({ roo_read_date: 200, roo_edit_date: 150, user_edit_date: 180 }),
		)
		expect(await tracker.getFilesReadByAlpha()).toEqual(["src/two.ts", "src/one.ts"])
		expect(await tracker.getFilesReadByAlpha(300)).toEqual(["src/two.ts", "src/one.ts"])
		expect(await tracker.getFilesReadByAlpha(301)).toEqual(["src/two.ts"])
		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/one.ts"])
		expect(taskMetadataSchema.safeParse(metadata()).success).toBe(true)

		const reloaded = createPersistedTracker(metadata()).tracker
		expect(await reloaded.getFilesReadByAlpha(301)).toEqual(["src/two.ts"])
	})

	it("preserves conservative timestamp filtering for legacy undated reads", async () => {
		const { tracker, metadata } = createPersistedTracker({
			files_in_context: [legacyEntry({ roo_read_date: null }), legacyEntry({ roo_read_date: 100 })],
		})
		vi.spyOn(Date, "now").mockReturnValue(200)

		await tracker.addFileToFileContextTracker("task-1", "src/one.ts", "user_edited")

		expect(metadata().files_in_context).toHaveLength(3)
		expect(await tracker.getFilesReadByAlpha(1_000)).toEqual(["src/one.ts"])
	})

	it("bounds mixed observations while retaining both undated read sources and checkpoint evidence", async () => {
		const { tracker, metadata } = createPersistedTracker({
			files_in_context: [
				legacyEntry({ roo_read_date: null }),
				legacyEntry({ record_source: "file_mentioned", roo_read_date: null }),
			],
		})
		const now = vi.spyOn(Date, "now")
		const sources = ["read_tool", "file_mentioned", "roo_edited", "user_edited"] as const
		for (let index = 0; index < 64; index++) {
			now.mockReturnValue(1_000 + index)
			await tracker.addFileToFileContextTracker("task-1", "src/one.ts", sources[index % sources.length])
			expect(metadata().files_in_context.length).toBeLessThanOrEqual(6)
		}

		expect(metadata().files_in_context).toHaveLength(6)
		expect(metadata().files_in_context.filter((entry) => entry.record_state === "active")).toEqual([
			expect.objectContaining({
				record_source: "user_edited",
				roo_read_date: 1_062,
				roo_edit_date: 1_062,
				user_edit_date: 1_063,
			}),
		])
		expect(await tracker.getFilesReadByAlpha(2_000)).toEqual(["src/one.ts"])
		expect(tracker.getAndClearCheckpointPossibleFile()).toEqual(["src/one.ts"])
		expect(tracker.getAndClearCheckpointPossibleFile()).toEqual([])
	})

	it("coalesces consecutive same-file event bursts behind an in-flight save", async () => {
		const { tracker, metadata } = createPersistedTracker()
		const save = vi.mocked(tracker.saveTaskMetadata).getMockImplementation()!
		let releaseSave!: () => void
		let markSaveStarted!: () => void
		const saveStarted = new Promise<void>((resolve) => {
			markSaveStarted = resolve
		})
		const saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve
		})
		vi.mocked(tracker.saveTaskMetadata).mockImplementationOnce(async (taskId, value) => {
			markSaveStarted()
			await saveGate
			await save(taskId, value)
		})
		const first = tracker.addFileToFileContextTracker("task-1", "src/one.ts", "read_tool")
		await saveStarted
		const burst = Array.from({ length: 128 }, () =>
			tracker.addFileToFileContextTracker("task-1", "src/one.ts", "user_edited"),
		)
		const receipt = tracker.captureRecentlyModifiedFiles()
		receipt.commit()
		releaseSave()
		await Promise.all([first, ...burst])

		expect(receipt.files).toEqual(["src/one.ts"])
		expect(tracker.saveTaskMetadata).toHaveBeenCalledTimes(2)
		expect(metadata().files_in_context).toHaveLength(2)
		expect(tracker.captureRecentlyModifiedFiles().files).toEqual([])
	})

	it("preserves source ordering when observations interrupt a same-path burst", async () => {
		const { tracker, metadata } = createPersistedTracker()
		const updates = [
			tracker.addFileToFileContextTracker("task-1", "src/one.ts", "user_edited"),
			tracker.addFileToFileContextTracker("task-1", "src/one.ts", "read_tool"),
			tracker.addFileToFileContextTracker("task-1", "src/one.ts", "user_edited"),
		]
		await Promise.all(updates)

		expect(metadata().files_in_context.filter((entry) => entry.record_state === "active")).toEqual([
			expect.objectContaining({ record_source: "user_edited" }),
		])
	})
})

describe("FileContextTracker watcher ownership", () => {
	it("watches the captured task root instead of the editor's first workspace", async () => {
		const tracker = createTracker()
		await tracker.trackFileContext("src/one.ts", "read_tool")

		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith(
			expect.objectContaining({ base: path.join(taskCwd, "src"), pattern: "one.ts" }),
		)
		tracker.dispose()
	})

	it("tracks a task root even when the editor has no workspace folder", async () => {
		host.folders = []
		const tracker = createTracker()
		await tracker.trackFileContext("src/one.ts", "read_tool")

		expect(tracker.saveTaskMetadata).toHaveBeenCalledOnce()
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledOnce()
		tracker.dispose()
	})

	it("retains the first external change after an initial Alpha write", async () => {
		const tracker = createTracker()
		const { watcher, fireChange } = createWatcher()
		vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(watcher)
		await tracker.trackFileContext("src/one.ts", "roo_edited")

		fireChange()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/one.ts"])
		tracker.dispose()
	})

	it("does not guess the author of an event after an already-watched Alpha write", async () => {
		const tracker = createTracker()
		const { watcher, fireChange } = createWatcher()
		vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(watcher)
		await tracker.trackFileContext("src/one.ts", "read_tool")
		await tracker.trackFileContext("src/one.ts", "roo_edited")

		fireChange()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/one.ts"])
		tracker.dispose()
	})

	it("does not create a watcher when an in-flight save settles after disposal", async () => {
		const tracker = createTracker()
		let releaseSave!: () => void
		let markSaveStarted!: () => void
		const saveStarted = new Promise<void>((resolve) => {
			markSaveStarted = resolve
		})
		const saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve
		})
		vi.mocked(tracker.saveTaskMetadata).mockImplementation(async () => {
			markSaveStarted()
			await saveGate
		})
		const tracking = tracker.trackFileContext("src/one.ts", "read_tool")
		await saveStarted
		tracker.dispose()
		releaseSave()
		await tracking

		expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled()
	})

	it("does not persist or watch a stale owner after its metadata read settles", async () => {
		const tracker = createTracker()
		let releaseRead!: (metadata: TaskMetadata) => void
		let markReadStarted!: () => void
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve
		})
		const readGate = new Promise<TaskMetadata>((resolve) => {
			releaseRead = resolve
		})
		vi.mocked(tracker.getTaskMetadata).mockImplementation(async () => {
			markReadStarted()
			return readGate
		})
		const tracking = tracker.trackFileContext("src/one.ts", "read_tool")
		await readStarted
		tracker.dispose()
		releaseRead({ files_in_context: [] })
		await tracking

		expect(tracker.saveTaskMetadata).not.toHaveBeenCalled()
		expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled()
	})

	it("ignores queued watcher callbacks and new tracking after idempotent disposal", async () => {
		const tracker = createTracker()
		const { watcher, fireChange } = createWatcher()
		vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(watcher)
		await tracker.trackFileContext("src/one.ts", "read_tool")
		vi.mocked(tracker.getTaskMetadata).mockClear()
		vi.mocked(tracker.saveTaskMetadata).mockClear()
		tracker.dispose()
		tracker.dispose()

		fireChange()
		await tracker.trackFileContext("src/two.ts", "read_tool")
		await tracker.addFileToFileContextTracker("task-1", "src/three.ts", "user_edited")
		await tracker.setupFileWatcher("src/four.ts")

		expect(watcher.dispose).toHaveBeenCalledOnce()
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledOnce()
		expect(tracker.getTaskMetadata).not.toHaveBeenCalled()
		expect(tracker.saveTaskMetadata).not.toHaveBeenCalled()
		expect(tracker.captureRecentlyModifiedFiles().files).toEqual([])
	})

	it("keeps a replaced owner's callbacks and pending read from rearming receipts or watchers", async () => {
		const retired = createTracker()
		const oldEvents = createWatcher()
		const newEvents = createWatcher()
		vi.mocked(vscode.workspace.createFileSystemWatcher)
			.mockReturnValueOnce(oldEvents.watcher)
			.mockReturnValueOnce(newEvents.watcher)
		await retired.trackFileContext("src/one.ts", "read_tool")
		let releaseRead!: (metadata: TaskMetadata) => void
		let markReadStarted!: () => void
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve
		})
		const readGate = new Promise<TaskMetadata>((resolve) => {
			releaseRead = resolve
		})
		vi.mocked(retired.getTaskMetadata).mockImplementationOnce(async () => {
			markReadStarted()
			return readGate
		})
		const pending = retired.trackFileContext("src/late.ts", "read_tool")
		await readStarted
		retired.dispose()

		const replacement = createTracker()
		await replacement.trackFileContext("src/one.ts", "read_tool")
		const tracking = vi.spyOn(replacement, "trackFileContext")
		newEvents.fireChange()
		const receipt = replacement.captureRecentlyModifiedFiles()
		oldEvents.fireChange()
		receipt.commit()
		releaseRead({ files_in_context: [] })
		await Promise.all([pending, tracking.mock.results[0].value])

		expect(receipt.files).toEqual(["src/one.ts"])
		expect(retired.captureRecentlyModifiedFiles().files).toEqual([])
		expect(replacement.captureRecentlyModifiedFiles().files).toEqual([])
		expect(retired.saveTaskMetadata).toHaveBeenCalledOnce()
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2)
		expect(oldEvents.watcher.dispose).toHaveBeenCalledOnce()
		expect(newEvents.watcher.dispose).not.toHaveBeenCalled()
		replacement.dispose()
	})
})

describe("FileContextTracker modified-file receipts", () => {
	it("keeps captured files pending when persistence does not commit the receipt", async () => {
		const tracker = createTracker()
		await markUserEditedFile(tracker, "src/one.ts")
		await markUserEditedFile(tracker, "src/two.ts")

		const firstAttempt = tracker.captureRecentlyModifiedFiles()
		expect(firstAttempt.files).toEqual(["src/one.ts", "src/two.ts"])

		const retry = tracker.captureRecentlyModifiedFiles()
		expect(retry.files).toEqual(["src/one.ts", "src/two.ts"])
		retry.commit()
	})

	it("preserves a same-path modification that happens after capture", async () => {
		const tracker = createTracker()
		await markUserEditedFile(tracker, "src/one.ts")

		const receipt = tracker.captureRecentlyModifiedFiles()
		await markUserEditedFile(tracker, "src/one.ts")
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/one.ts"])
	})

	it("makes committing a receipt idempotent", async () => {
		const tracker = createTracker()
		await markUserEditedFile(tracker, "src/one.ts")

		const receipt = tracker.captureRecentlyModifiedFiles()
		receipt.commit()
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual([])
	})

	it("commits only the captured portion and leaves the capped remainder pending", async () => {
		const tracker = createTracker()
		await markUserEditedFile(tracker, "src/one.ts")
		await markUserEditedFile(tracker, "src/two.ts")
		await markUserEditedFile(tracker, "src/three.ts")

		const receipt = tracker.captureRecentlyModifiedFiles(2)
		expect(receipt.files).toEqual(["src/one.ts", "src/two.ts"])
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/three.ts"])
	})

	it("bounds the default receipt and leaves the remainder pending", async () => {
		const tracker = createTracker()
		const filePaths = Array.from({ length: 201 }, (_, index) => `src/${index}.ts`)
		for (const filePath of filePaths) {
			await markUserEditedFile(tracker, filePath)
		}

		const receipt = tracker.captureRecentlyModifiedFiles()
		expect(receipt.files).toHaveLength(200)
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/200.ts"])
	})

	it("skips an over-budget path without blocking later paths or acknowledging it", async () => {
		const tracker = createTracker()
		const longPath = `src/${"a".repeat(32)}.ts`
		await markUserEditedFile(tracker, longPath)
		await markUserEditedFile(tracker, "src/short.ts")

		const receipt = tracker.captureRecentlyModifiedFiles(200, 20)
		expect(receipt.files).toEqual(["src/short.ts"])
		expect(receipt.files.join("\n").length).toBeLessThanOrEqual(20)
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles(200, 20).files).toEqual([])
		expect(tracker.captureRecentlyModifiedFiles(200, 100).files).toEqual([longPath])
	})
})
