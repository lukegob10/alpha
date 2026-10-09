// npx vitest services/code-index/processors/__tests__/file-watcher.spec.ts

import * as vscode from "vscode"
import { createHash } from "crypto"

import { FileWatcher } from "../file-watcher"

const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

// Mock TelemetryService
vi.mock("../../../../../packages/telemetry/src/TelemetryService", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

// Mock dependencies
vi.mock("../../cache-manager")
vi.mock("../../../core/ignore/AlphaIgnoreController", () => ({
	AlphaIgnoreController: vi.fn().mockImplementation(() => ({
		validateAccess: vi.fn().mockReturnValue(true),
	})),
}))
vi.mock("ignore")
vi.mock("../parser", () => ({
	codeParser: {
		parseFile: vi.fn().mockResolvedValue([]),
	},
}))
vi.mock("../../../glob/ignore-utils", () => ({
	isPathInIgnoredDirectory: vi.fn().mockReturnValue(false),
}))

// Mock vscode module
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(),
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
		fs: {
			stat: vi.fn().mockResolvedValue({ size: 1000 }),
			readFile: vi.fn().mockResolvedValue(Buffer.from("test content")),
		},
	},
	RelativePattern: vi.fn().mockImplementation((base, pattern) => ({ base, pattern })),
	Uri: {
		file: vi.fn().mockImplementation((path) => ({ fsPath: path })),
	},
	EventEmitter: vi.fn().mockImplementation(() => ({
		event: vi.fn(),
		fire: vi.fn(),
		dispose: vi.fn(),
	})),
	ExtensionContext: vi.fn(),
}))

describe("FileWatcher", () => {
	let fileWatcher: FileWatcher
	let mockWatcher: any
	let mockOnDidCreate: any
	let mockOnDidChange: any
	let mockOnDidDelete: any
	let mockContext: any
	let mockCacheManager: any
	let mockEmbedder: any
	let mockVectorStore: any
	let mockIgnoreInstance: any

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Create mock event handlers
		mockOnDidCreate = vi.fn()
		mockOnDidChange = vi.fn()
		mockOnDidDelete = vi.fn()

		// Create mock watcher
		mockWatcher = {
			onDidCreate: vi.fn().mockImplementation((handler) => {
				mockOnDidCreate = handler
				return { dispose: vi.fn() }
			}),
			onDidChange: vi.fn().mockImplementation((handler) => {
				mockOnDidChange = handler
				return { dispose: vi.fn() }
			}),
			onDidDelete: vi.fn().mockImplementation((handler) => {
				mockOnDidDelete = handler
				return { dispose: vi.fn() }
			}),
			dispose: vi.fn(),
		}

		// Mock createFileSystemWatcher to return our mock watcher
		vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(mockWatcher)

		// Create mock dependencies
		mockContext = {
			subscriptions: [],
		}

		mockCacheManager = {
			getHash: vi.fn(),
			updateHash: vi.fn(),
			deleteHash: vi.fn(),
		}

		mockEmbedder = {
			createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
			embedderInfo: { name: "vertex" },
		}

		mockVectorStore = {
			getPointsByFilePath: vi.fn().mockResolvedValue([]),
			replaceFilePoints: vi.fn(async (filePath: string, points: unknown[]) => {
				if (points.length) await mockVectorStore.upsertPoints(points)
				else await mockVectorStore.deletePointsByMultipleFilePaths([filePath])
			}),
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByFilePath: vi.fn().mockResolvedValue(undefined),
			deletePointsByMultipleFilePaths: vi.fn().mockResolvedValue(undefined),
		}

		mockIgnoreInstance = {
			ignores: vi.fn().mockReturnValue(false),
		}

		fileWatcher = new FileWatcher(
			"/mock/workspace",
			mockContext,
			mockCacheManager,
			mockEmbedder,
			mockVectorStore,
			mockIgnoreInstance,
		)
	})

	describe("file filtering", () => {
		it("should ignore files in hidden directories on create events", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			// Spy on the vector store to see which files are actually processed
			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			// Simulate file creation events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.git/config", shouldProcess: false },
				{ path: "/mock/workspace/.hidden/file.ts", shouldProcess: false },
				{ path: "/mock/workspace/src/.next/static/file.js", shouldProcess: false },
				{ path: "/mock/workspace/node_modules/package/index.js", shouldProcess: false },
				{ path: "/mock/workspace/normal/file.js", shouldProcess: true },
			]

			// Trigger file creation events
			for (const { path } of testCases) {
				await mockOnDidCreate({ fsPath: path })
			}

			// Wait for batch processing
			await new Promise((resolve) => setTimeout(resolve, 600))

			// Check that files in hidden directories were not processed
			expect(processedFiles).not.toContain("src/.next/static/file.js")
			expect(processedFiles).not.toContain(".git/config")
			expect(processedFiles).not.toContain(".hidden/file.ts")
		})

		it("should ignore files in hidden directories on change events", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			// Track which files are processed
			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			// Simulate file change events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.vscode/settings.json", shouldProcess: false },
				{ path: "/mock/workspace/src/.cache/data.json", shouldProcess: false },
				{ path: "/mock/workspace/dist/bundle.js", shouldProcess: false },
			]

			// Trigger file change events
			for (const { path } of testCases) {
				await mockOnDidChange({ fsPath: path })
			}

			// Wait for batch processing
			await new Promise((resolve) => setTimeout(resolve, 600))

			// Check that files in hidden directories were not processed
			expect(processedFiles).not.toContain(".vscode/settings.json")
			expect(processedFiles).not.toContain("src/.cache/data.json")
		})

		it("should ignore files in hidden directories on delete events", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			// Track which files are deleted
			const deletedFiles: string[] = []
			mockVectorStore.deletePointsByFilePath.mockImplementation(async (filePath: string) => {
				deletedFiles.push(filePath)
			})

			// Simulate file deletion events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.git/objects/abc123", shouldProcess: false },
				{ path: "/mock/workspace/.DS_Store", shouldProcess: false },
				{ path: "/mock/workspace/build/.cache/temp.js", shouldProcess: false },
			]

			// Trigger file deletion events
			for (const { path } of testCases) {
				await mockOnDidDelete({ fsPath: path })
			}

			// Wait for batch processing
			await new Promise((resolve) => setTimeout(resolve, 600))

			// Check that files in hidden directories were not processed
			expect(deletedFiles).not.toContain(".git/objects/abc123")
			expect(deletedFiles).not.toContain(".DS_Store")
			expect(deletedFiles).not.toContain("build/.cache/temp.js")
		})

		it("should handle nested hidden directories correctly", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			// Track which files are processed
			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			// Test deeply nested hidden directories
			const testCases = [
				{ path: "/mock/workspace/src/components/Button.tsx", shouldProcess: true },
				{ path: "/mock/workspace/src/.hidden/components/Button.tsx", shouldProcess: false },
				{ path: "/mock/workspace/.hidden/src/components/Button.tsx", shouldProcess: false },
				{ path: "/mock/workspace/src/components/.hidden/Button.tsx", shouldProcess: false },
			]

			// Trigger file creation events
			for (const { path } of testCases) {
				await mockOnDidCreate({ fsPath: path })
			}

			// Wait for batch processing
			await new Promise((resolve) => setTimeout(resolve, 600))

			// Check that files in hidden directories were not processed
			expect(processedFiles).not.toContain("src/.hidden/components/Button.tsx")
			expect(processedFiles).not.toContain(".hidden/src/components/Button.tsx")
			expect(processedFiles).not.toContain("src/components/.hidden/Button.tsx")
		})
	})

	describe("lifecycle", () => {
		it("does not replace an initialized native watcher", async () => {
			const callsBeforeInitialize = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.length
			await fileWatcher.initialize()
			await fileWatcher.initialize()

			expect(vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.length - callsBeforeInitialize).toBe(
				1,
			)
			expect(mockWatcher.dispose).not.toHaveBeenCalled()
		})

		it("should dispose of the watcher when disposed", async () => {
			await fileWatcher.initialize()
			fileWatcher.dispose()

			expect(mockWatcher.dispose).toHaveBeenCalled()
		})

		it("recreates the native watcher after a restartable stop", async () => {
			const callsBeforeInitialize = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.length
			await fileWatcher.initialize()

			fileWatcher.stop()
			await fileWatcher.initialize()

			expect(vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.length - callsBeforeInitialize).toBe(
				2,
			)
			expect(mockWatcher.dispose).toHaveBeenCalledTimes(1)
		})

		it("waits for accepted batches before restarting", async () => {
			const callsBeforeInitialize = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.length
			await fileWatcher.initialize()
			fileWatcher.stop()
			const batch = deferred<void>()
			;(fileWatcher as unknown as { batchProcessingTail: Promise<void> }).batchProcessingTail = batch.promise

			const restart = fileWatcher.initialize()
			await Promise.resolve()
			expect(vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.length - callsBeforeInitialize).toBe(
				1,
			)

			batch.resolve(undefined)
			await restart
			expect(vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.length - callsBeforeInitialize).toBe(
				2,
			)
		})

		it("rejects initialization after terminal disposal", async () => {
			await fileWatcher.initialize()
			fileWatcher.dispose()

			await expect(fileWatcher.initialize()).rejects.toThrow(/disposed/i)
		})
	})

	describe("batch ordering", () => {
		it("finishes an earlier change batch before processing a later delete", async () => {
			const filePath = "/mock/workspace/src/file.ts"
			const uri = { fsPath: filePath } as vscode.Uri
			const upsertStarted = deferred<void>()
			const releaseUpsert = deferred<void>()
			const operations: string[] = []
			const internals = fileWatcher as unknown as {
				accumulatedEvents: Map<string, { uri: vscode.Uri; type: "create" | "change" | "delete" }>
				triggerBatchProcessing(): Promise<void>
			}
			vi.spyOn(fileWatcher, "processFile").mockResolvedValue({
				path: filePath,
				status: "processed_for_batching",
				newHash: "new-hash",
				pointsToUpsert: [
					{
						id: "point-a",
						vector: [0.1],
						payload: { filePath: "src/file.ts", codeChunk: "code", startLine: 1, endLine: 1 },
					},
				],
			})
			mockVectorStore.deletePointsByMultipleFilePaths.mockImplementation(async () => {
				operations.push("delete")
			})
			mockVectorStore.upsertPoints.mockImplementationOnce(async () => {
				operations.push("upsert-start")
				upsertStarted.resolve(undefined)
				await releaseUpsert.promise
				operations.push("upsert-end")
			})
			mockCacheManager.updateHash.mockImplementation(() => operations.push("cache-update"))
			mockCacheManager.deleteHash.mockImplementation(() => operations.push("cache-delete"))

			internals.accumulatedEvents.set(filePath, { uri, type: "change" })
			const changeBatch = internals.triggerBatchProcessing()
			await upsertStarted.promise

			internals.accumulatedEvents.set(filePath, { uri, type: "delete" })
			const deleteBatch = internals.triggerBatchProcessing()
			await Promise.resolve()
			const operationsBeforeRelease = [...operations]

			releaseUpsert.resolve(undefined)
			await Promise.all([changeBatch, deleteBatch])
			await fileWatcher.whenIdle()

			expect(operationsBeforeRelease).toEqual(["upsert-start"])
			expect(operations).toEqual(["upsert-start", "upsert-end", "cache-update", "delete", "cache-delete"])
		})
	})
	it("decodes VS Code Uint8Array snapshots as UTF-8 before parsing and hashing", async () => {
		const { codeParser } = await import("../parser")
		const content = "export const label = '数据😀'"
		vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(new TextEncoder().encode(content))
		mockCacheManager.getHash.mockReturnValue(undefined)
		await fileWatcher.processFile("/mock/workspace/state.ts")
		expect(codeParser.parseFile).toHaveBeenCalledWith(
			"/mock/workspace/state.ts",
			expect.objectContaining({ content }),
		)
	})

	describe("incremental indexing regressions", () => {
		afterEach(() => {
			fileWatcher.dispose()
			vi.useRealTimers()
		})
		it("exposes only the newest bounded pending paths and removes them after reconciliation", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()
			for (let index = 0; index < 70; index++)
				await mockOnDidChange({ fsPath: `/mock/workspace/src/file${index}.ts` })
			const pending = fileWatcher.getPendingFilePaths(1000)
			expect(pending).toHaveLength(64)
			expect(pending[0]).toBe("/mock/workspace/src/file69.ts")
			expect(pending).not.toContain("/mock/workspace/src/file0.ts")
			await fileWatcher.whenIdle()
			expect(fileWatcher.getPendingFilePaths(64)).toEqual([])
		})

		it("keeps queued files in an active batch available for current-source search", async () => {
			vi.useFakeTimers()
			const entered = deferred<void>()
			const release = deferred<void>()
			let started = 0
			vi.spyOn(fileWatcher, "processFile").mockImplementation(async (filePath) => {
				if (++started === 10) entered.resolve(undefined)
				await release.promise
				return { path: filePath, status: "skipped", reason: "File has not changed" }
			})
			await fileWatcher.initialize()
			const paths = Array.from({ length: 70 }, (_, index) => `/mock/workspace/src/file${index}.ts`)
			for (const fsPath of paths) await mockOnDidChange({ fsPath })
			const run = fileWatcher.whenIdle()
			await entered.promise
			const pending = fileWatcher.getPendingFilePaths(64)
			release.resolve(undefined)
			await run

			expect(pending).toEqual([...paths].reverse().slice(0, 64))
			expect(fileWatcher.getPendingFilePaths(64)).toEqual([])
		})

		it("preserves the index for a duplicate change notification with unchanged content", async () => {
			vi.useFakeTimers()
			mockCacheManager.getHash.mockReturnValue(createHash("sha256").update("test content").digest("hex"))
			await fileWatcher.initialize()
			await mockOnDidChange({ fsPath: "/mock/workspace/src/file.ts" })
			await vi.advanceTimersByTimeAsync(500)
			await fileWatcher.whenIdle()
			expect(mockVectorStore.deletePointsByMultipleFilePaths).not.toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
		})

		it("groups an edit burst until quiet, bounded by the first event's deadline", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()
			const processFile = vi.spyOn(fileWatcher, "processFile")
			for (let index = 0; index < 10; index++) {
				await mockOnDidChange({ fsPath: `/mock/workspace/src/file${index}.ts` })
				await vi.advanceTimersByTimeAsync(100)
			}
			expect(processFile).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(400)
			expect(processFile).toHaveBeenCalledTimes(10)
			await fileWatcher.whenIdle()
			processFile.mockClear()
			for (let index = 0; index < 20; index++) {
				await mockOnDidChange({ fsPath: `/mock/workspace/src/repeated.ts` })
				await vi.advanceTimersByTimeAsync(100)
			}
			expect(processFile).toHaveBeenCalledOnce()
		})

		it("does not replace existing chunks when an embedding request fails", async () => {
			vi.useFakeTimers()
			const { codeParser } = await import("../parser")
			vi.mocked(codeParser.parseFile).mockResolvedValueOnce([
				{
					file_path: "/mock/workspace/src/file.ts",
					identifier: "f",
					type: "code_chunk",
					start_line: 1,
					end_line: 1,
					content: "code",
					fileHash: "new",
					segmentHash: "segment",
				},
			])
			mockEmbedder.createEmbeddings.mockRejectedValueOnce(new Error("provider unavailable"))
			await fileWatcher.initialize()
			await mockOnDidChange({ fsPath: "/mock/workspace/src/file.ts" })
			await vi.advanceTimersByTimeAsync(500)
			await fileWatcher.whenIdle()
			expect(mockVectorStore.deletePointsByMultipleFilePaths).not.toHaveBeenCalled()
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
		})

		it("commits the hash for a file that becomes empty and removes its old chunks", async () => {
			vi.useFakeTimers()
			vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(new Uint8Array())
			const { codeParser } = await import("../parser")
			vi.mocked(codeParser.parseFile).mockResolvedValueOnce([])
			await fileWatcher.initialize()
			await mockOnDidChange({ fsPath: "/mock/workspace/src/file.ts" })
			await fileWatcher.whenIdle()
			expect(mockVectorStore.replaceFilePoints).toHaveBeenCalledWith("/mock/workspace/src/file.ts", [])
			expect(mockCacheManager.updateHash).toHaveBeenCalledWith(
				"/mock/workspace/src/file.ts",
				createHash("sha256").update("").digest("hex"),
			)
		})

		it("cancels an unresponsive provider on Stop and prevents late commits", async () => {
			vi.useFakeTimers()
			const entered = deferred<void>()
			const response = deferred<{ embeddings: number[][] }>()
			const { codeParser } = await import("../parser")
			vi.mocked(codeParser.parseFile).mockResolvedValueOnce([
				{
					file_path: "/mock/workspace/src/file.ts",
					identifier: "f",
					type: "code",
					start_line: 1,
					end_line: 1,
					content: "source",
					fileHash: "hash",
					segmentHash: "segment",
				},
			])
			let signal: AbortSignal | undefined
			mockEmbedder.createEmbeddings.mockImplementationOnce(
				(_texts: string[], _model: unknown, _purpose: unknown, cancellation: AbortSignal) => {
					signal = cancellation
					entered.resolve(undefined)
					return response.promise
				},
			)
			await fileWatcher.initialize()
			await mockOnDidChange({ fsPath: "/mock/workspace/src/file.ts" })
			const run = fileWatcher.whenIdle()
			await entered.promise
			fileWatcher.stop()
			await run
			expect(signal?.aborted).toBe(true)
			response.resolve({ embeddings: [[1, 0, 0]] })
			await Promise.resolve()
			expect(mockVectorStore.replaceFilePoints).not.toHaveBeenCalled()
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
		})

		it("coalesces rapid edits behind an active write and reads only the latest pending version", async () => {
			vi.useFakeTimers()
			const entered = deferred<void>()
			const release = deferred<void>()
			mockVectorStore.replaceFilePoints.mockImplementationOnce(async () => {
				entered.resolve(undefined)
				await release.promise
			})
			const versions: string[] = []
			let version = "first"
			vi.spyOn(fileWatcher, "processFile").mockImplementation(async (filePath) => {
				versions.push(version)
				return { path: filePath, status: "processed_for_batching", newHash: version, pointsToUpsert: [] }
			})
			await fileWatcher.initialize()
			const uri = { fsPath: "/mock/workspace/src/file.ts" }
			await mockOnDidChange(uri)
			const run = fileWatcher.whenIdle()
			await entered.promise
			for (let index = 0; index < 100; index++) {
				version = `edit-${index}`
				await mockOnDidChange(uri)
				await vi.advanceTimersByTimeAsync(500)
			}
			release.resolve(undefined)
			await run
			expect(versions).toEqual(["first", "edit-99"])
			expect(mockCacheManager.updateHash).toHaveBeenLastCalledWith(uri.fsPath, "edit-99")
		})

		it("supersedes a queued delete before a worker starts when the file is recreated", async () => {
			vi.useFakeTimers()
			const entered = deferred<void>()
			const release = deferred<void>()
			const recreated = "/mock/workspace/src/recreated.ts"
			let started = 0
			const process = vi.spyOn(fileWatcher, "processFile").mockImplementation(async (filePath) => {
				if (filePath === recreated)
					return { path: filePath, status: "local_error", error: new Error("provider unavailable") }
				if (++started === 10) entered.resolve(undefined)
				await release.promise
				return { path: filePath, status: "skipped", reason: "File has not changed" }
			})
			await fileWatcher.initialize()
			for (let index = 0; index < 10; index++)
				await mockOnDidChange({ fsPath: `/mock/workspace/src/blocked-${index}.ts` })
			await mockOnDidDelete({ fsPath: recreated })
			const run = fileWatcher.whenIdle()
			await entered.promise
			await mockOnDidCreate({ fsPath: recreated })
			release.resolve(undefined)
			await run

			expect(process).toHaveBeenCalledWith(recreated, expect.any(AbortSignal), expect.any(Function))
			expect(mockVectorStore.replaceFilePoints).not.toHaveBeenCalled()
			expect(mockCacheManager.deleteHash).not.toHaveBeenCalled()
		})

		it("retains saved edits while the initial scan owns the index", async () => {
			vi.useFakeTimers()
			const process = vi.spyOn(fileWatcher, "processFile")
			await fileWatcher.initialize({ deferProcessing: true })
			await mockOnDidChange({ fsPath: "/mock/workspace/src/file.ts" })
			await vi.advanceTimersByTimeAsync(5000)
			await fileWatcher.whenIdle()
			expect(process).not.toHaveBeenCalled()
			fileWatcher.resumeProcessing()
			await fileWatcher.whenIdle()
			expect(process).toHaveBeenCalledOnce()
		})

		it("settles an active replacement before Clear/restart can retire it", async () => {
			vi.useFakeTimers()
			const entered = deferred<void>()
			const release = deferred<void>()
			mockVectorStore.replaceFilePoints.mockImplementationOnce(async () => {
				entered.resolve(undefined)
				await release.promise
			})
			await fileWatcher.initialize()
			await mockOnDidDelete({ fsPath: "/mock/workspace/src/file.ts" })
			const run = fileWatcher.whenIdle()
			await entered.promise
			fileWatcher.stop()
			let idle = false
			const settled = run.then(() => {
				idle = true
			})
			await Promise.resolve()
			expect(idle).toBe(false)
			release.resolve(undefined)
			await settled
			expect(mockCacheManager.deleteHash).toHaveBeenCalledOnce()
		})
	})
})
