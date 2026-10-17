import type { Mock } from "vitest"
import * as vscode from "vscode"
import WorkspaceTracker from "../WorkspaceTracker"
import { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { listFiles } from "../../../services/glob/list-files"
import { getWorkspacePath } from "../../../utils/path"

// Mock functions - must be defined before vitest.mock calls
const mockOnDidCreate = vitest.fn()
const mockOnDidDelete = vitest.fn()
const mockDispose = vitest.fn()

// Store registered tab change callback
let registeredTabChangeCallback: (() => Promise<void>) | null = null

// Mock workspace path
vitest.mock("../../../utils/path", () => ({
	getWorkspacePath: vitest.fn().mockReturnValue("/test/workspace"),
	toRelativePath: vitest.fn((path, cwd) => {
		// Handle both Windows and POSIX paths by using path.relative
		const relativePath = require("path").relative(cwd, path)
		// Convert to forward slashes for consistency
		let normalizedPath = relativePath.replace(/\\/g, "/")
		// Add trailing slash if original path had one
		return path.endsWith("/") ? normalizedPath + "/" : normalizedPath
	}),
}))

// Mock watcher - must be defined after mockDispose but before vitest.mock("vscode")
const mockWatcher = {
	onDidCreate: mockOnDidCreate.mockReturnValue({ dispose: mockDispose }),
	onDidDelete: mockOnDidDelete.mockReturnValue({ dispose: mockDispose }),
	dispose: mockDispose,
}

// Mock vscode
vitest.mock("vscode", () => ({
	window: {
		tabGroups: {
			onDidChangeTabs: vitest.fn((callback) => {
				registeredTabChangeCallback = callback
				return { dispose: mockDispose }
			}),
			all: [],
		},
		onDidChangeActiveTextEditor: vitest.fn(() => ({ dispose: vitest.fn() })),
	},
	workspace: {
		workspaceFolders: [
			{
				uri: { fsPath: "/test/workspace" },
				name: "test",
				index: 0,
			},
		],
		createFileSystemWatcher: vitest.fn(() => mockWatcher),
		fs: {
			stat: vitest.fn().mockResolvedValue({ type: 1 }), // FileType.File = 1
		},
	},
	FileType: { File: 1, Directory: 2 },
	Uri: { file: vitest.fn((fsPath: string) => ({ fsPath })) },
}))

vitest.mock("../../../services/glob/list-files", () => ({
	listFiles: vitest.fn(),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("WorkspaceTracker", () => {
	let workspaceTracker: WorkspaceTracker
	let mockProvider: AlphaProvider

	beforeEach(() => {
		vitest.clearAllMocks()
		vitest.useFakeTimers()
		;(vscode.workspace.fs.stat as Mock).mockResolvedValue({ type: 1 })

		// Reset all mock implementations
		registeredTabChangeCallback = null

		// Reset workspace path mock
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")

		// Create provider mock
		mockProvider = {
			postMessageToWebview: vitest.fn().mockResolvedValue(undefined),
		} as unknown as AlphaProvider & { postMessageToWebview: Mock }

		// Create tracker instance
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Ensure the tab change callback was registered
		expect(registeredTabChangeCallback).not.toBeNull()
	})

	afterEach(() => {
		workspaceTracker.dispose()
		vitest.clearAllTimers()
		vitest.useRealTimers()
	})

	it("should initialize with workspace files", async () => {
		const mockFiles = [["/test/workspace/file1.ts", "/test/workspace/file2.ts"], false]
		;(listFiles as Mock).mockResolvedValue(mockFiles)

		await workspaceTracker.initializeFilePaths()
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: expect.arrayContaining(["file1.ts", "file2.ts"]),
			openedTabs: [],
		})
		expect((mockProvider.postMessageToWebview as Mock).mock.calls[0][0].filePaths).toHaveLength(2)
	})

	it("should handle file creation events", async () => {
		// Get the creation callback and call it
		const [[callback]] = mockOnDidCreate.mock.calls
		await callback({ fsPath: "/test/workspace/newfile.ts" })
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: ["newfile.ts"],
			openedTabs: [],
		})
	})

	it("should handle file deletion events", async () => {
		// First add a file
		const [[createCallback]] = mockOnDidCreate.mock.calls
		await createCallback({ fsPath: "/test/workspace/file.ts" })
		vitest.runAllTimers()

		// Then delete it
		const [[deleteCallback]] = mockOnDidDelete.mock.calls
		await deleteCallback({ fsPath: "/test/workspace/file.ts" })
		vitest.runAllTimers()

		// The last call should have empty filePaths
		expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})
	})

	it("should handle directory paths correctly", async () => {
		// Mock stat to return directory type
		;(vscode.workspace.fs.stat as Mock).mockResolvedValueOnce({ type: 2 }) // FileType.Directory = 2

		const [[callback]] = mockOnDidCreate.mock.calls
		await callback({ fsPath: "/test/workspace/newdir" })
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: ["newdir/"],
			openedTabs: [],
		})
		const lastCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(lastCall[0].filePaths).toHaveLength(1)
	})

	it("should respect file limits", async () => {
		// Create array of unique file paths for initial load
		const files = Array.from({ length: 1001 }, (_, i) => `/test/workspace/file${i}.ts`)
		;(listFiles as Mock).mockResolvedValue([files, false])

		await workspaceTracker.initializeFilePaths()
		vitest.runAllTimers()

		// Should only have 1000 files initially
		const expectedFiles = Array.from({ length: 1000 }, (_, i) => `file${i}.ts`).sort()
		const calls = (mockProvider.postMessageToWebview as Mock).mock.calls

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: expect.arrayContaining(expectedFiles),
			openedTabs: [],
		})
		expect(calls[0][0].filePaths).toHaveLength(1000)

		// Should allow adding up to 2000 total files
		const [[callback]] = mockOnDidCreate.mock.calls
		for (let i = 0; i < 1000; i++) {
			await callback({ fsPath: `/test/workspace/extra${i}.ts` })
		}
		vitest.runAllTimers()

		const lastCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(lastCall[0].filePaths).toHaveLength(2000)

		// Adding one more file beyond 2000 should not increase the count
		await callback({ fsPath: "/test/workspace/toomany.ts" })
		vitest.runAllTimers()

		const finalCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(finalCall[0].filePaths).toHaveLength(2000)
	})

	it("should clean up watchers and timers on dispose", () => {
		// Set up updateTimer
		const [[callback]] = mockOnDidCreate.mock.calls
		callback({ fsPath: "/test/workspace/file.ts" })

		workspaceTracker.dispose()
		expect(mockDispose).toHaveBeenCalled()
		vitest.runAllTimers() // Ensure any pending timers are cleared

		// No more updates should happen after dispose
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("should handle workspace path changes when tabs change", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// Set initial workspace path and create tracker
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Clear any initialization calls
		vitest.clearAllMocks()

		// Mock listFiles to return some files
		const mockFiles = [["/test/new-workspace/file1.ts"], false]
		;(listFiles as Mock).mockResolvedValue(mockFiles)

		// Change workspace path
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")

		// Simulate tab change event
		await registeredTabChangeCallback!()

		// Run the debounce timer for workspaceDidReset
		vitest.advanceTimersByTime(300)

		// Should clear file paths and reset workspace
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})

		// Run all remaining timers to complete initialization
		await Promise.resolve() // Wait for initializeFilePaths to complete
		vitest.runAllTimers()

		// Should initialize file paths for new workspace
		expect(listFiles).toHaveBeenCalledWith("/test/new-workspace", true, 1000)
		vitest.runAllTimers()
	})

	it("should not update file paths if workspace changes during initialization", async () => {
		const discovery = deferred<[string[], boolean]>()
		;(listFiles as Mock).mockReturnValueOnce(discovery.promise)
		const initPromise = workspaceTracker.initializeFilePaths()
		;(getWorkspacePath as Mock).mockReturnValue("/test/changed-workspace")
		discovery.resolve([["/test/workspace/file1.ts", "/test/workspace/file2.ts"], false])
		await initPromise
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("should discard a superseded initialization in the same workspace", async () => {
		const discovery = deferred<[string[], boolean]>()
		;(listFiles as Mock)
			.mockReturnValueOnce(discovery.promise)
			.mockResolvedValueOnce([["/test/workspace/current.ts"], false])
		const staleInitialization = workspaceTracker.initializeFilePaths()
		await workspaceTracker.initializeFilePaths()
		discovery.resolve([["/test/workspace/stale.ts"], false])
		await staleInitialization
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "workspaceUpdated",
			filePaths: ["current.ts"],
			openedTabs: [],
		})
	})

	it("should not publish discovery completed after disposal", async () => {
		const discovery = deferred<[string[], boolean]>()
		;(listFiles as Mock).mockReturnValueOnce(discovery.promise)
		const initialization = workspaceTracker.initializeFilePaths()
		workspaceTracker.dispose()
		discovery.resolve([["/test/workspace/file.ts"], false])
		await initialization

		expect(vitest.getTimerCount()).toBe(0)
		vitest.runAllTimers()
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("should not publish file creation completed after disposal", async () => {
		const stat = deferred<{ type: number }>()
		;(vscode.workspace.fs.stat as Mock).mockReturnValueOnce(stat.promise)
		const [[callback]] = mockOnDidCreate.mock.calls
		const creation = callback({ fsPath: "/test/workspace/file.ts" })
		workspaceTracker.dispose()
		stat.resolve({ type: 1 })
		await creation

		expect(vitest.getTimerCount()).toBe(0)
		vitest.runAllTimers()
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("should not publish file creation from a previous workspace", async () => {
		const stat = deferred<{ type: number }>()
		;(vscode.workspace.fs.stat as Mock).mockReturnValueOnce(stat.promise)
		const [[callback]] = mockOnDidCreate.mock.calls
		const creation = callback({ fsPath: "/test/workspace/stale.ts" })
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")
		;(listFiles as Mock).mockResolvedValueOnce([["/test/new-workspace/current.ts"], false])
		await registeredTabChangeCallback!()
		await vitest.advanceTimersByTimeAsync(300)
		stat.resolve({ type: 1 })
		await creation
		await vitest.runAllTimersAsync()

		expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "workspaceUpdated",
			filePaths: ["current.ts"],
			openedTabs: [],
		})
	})

	it("should discard a pending update when the workspace changes before reset", async () => {
		;(listFiles as Mock).mockResolvedValueOnce([["/test/workspace/stale.ts"], false])
		await workspaceTracker.initializeFilePaths()
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("should not resume a workspace reset after disposal", async () => {
		const published = deferred<void>()
		;(mockProvider.postMessageToWebview as Mock).mockReturnValueOnce(published.promise)
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")
		await registeredTabChangeCallback!()
		vitest.advanceTimersByTime(300)
		workspaceTracker.dispose()
		published.resolve()
		await vitest.runAllTimersAsync()

		expect(listFiles).not.toHaveBeenCalled()
		expect(vitest.getTimerCount()).toBe(0)
	})

	it("should retain a pending workspace reset when discovery is requested", async () => {
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")
		;(listFiles as Mock).mockResolvedValueOnce([["/test/new-workspace/current.ts"], false])
		await registeredTabChangeCallback!()
		await workspaceTracker.initializeFilePaths()
		await vitest.runAllTimersAsync()

		expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "workspaceUpdated",
			filePaths: ["current.ts"],
			openedTabs: [],
		})
	})

	it("should clear resetTimer when calling workspaceDidReset multiple times", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// Set initial workspace path
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")

		// Create tracker instance to set initial prevWorkSpacePath
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Change workspace path to trigger update
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")

		// Call workspaceDidReset through tab change event
		await registeredTabChangeCallback!()

		// Call again before timer completes
		await registeredTabChangeCallback!()

		// Advance timer
		vitest.advanceTimersByTime(300)

		// Should only have one call to postMessageToWebview
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
	})

	it("should handle dispose with active resetTimer", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// Mock workspace path change to trigger resetTimer
		;(getWorkspacePath as Mock).mockReturnValueOnce("/test/workspace").mockReturnValueOnce("/test/new-workspace")

		// Trigger resetTimer
		await registeredTabChangeCallback!()

		// Dispose before timer completes
		workspaceTracker.dispose()

		// Advance timer
		vitest.advanceTimersByTime(300)

		// Should have called dispose on all disposables
		expect(mockDispose).toHaveBeenCalled()

		// No postMessage should be called after dispose
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})
})
