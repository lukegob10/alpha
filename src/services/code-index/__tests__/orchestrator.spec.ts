import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexOrchestrator } from "../orchestrator"

const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

const terminalEvent = <T>() => {
	const listeners = new Set<(value: T) => void>()
	let disposed = false
	return {
		event: (listener: (value: T) => void) => {
			if (disposed) {
				return { dispose: () => undefined }
			}
			listeners.add(listener)
			return { dispose: () => listeners.delete(listener) }
		},
		fire: (value: T) => {
			for (const listener of listeners) {
				listener(value)
			}
		},
		dispose: () => {
			disposed = true
			listeners.clear()
		},
	}
}

type WatcherProgress = {
	processedInBatch: number
	totalInBatch: number
	currentFile?: string
}

type WatcherSummary = {
	processedFiles: Array<{
		path: string
		status: "success" | "skipped" | "error" | "processed_for_batching" | "local_error"
		error?: Error
	}>
	batchError?: Error
}

const attachTerminalWatcherEvents = (fileWatcher: any) => {
	const startEvent = terminalEvent<string[]>()
	const progressEvent = terminalEvent<WatcherProgress>()
	const finishEvent = terminalEvent<WatcherSummary>()
	fileWatcher.onDidStartBatchProcessing = startEvent.event
	fileWatcher.onBatchProgressUpdate = progressEvent.event
	fileWatcher.onDidFinishBatchProcessing = finishEvent.event
	return { startEvent, progressEvent, finishEvent }
}

// Mock vscode workspace so startIndexing passes workspace check
vi.mock("vscode", () => {
	const path = require("path")
	const testWorkspacePath = path.join(path.sep, "test", "workspace")
	return {
		window: {
			activeTextEditor: null,
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: testWorkspacePath },
					name: "test",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn().mockReturnValue({
				onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				dispose: vi.fn(),
			}),
		},
		RelativePattern: vi.fn().mockImplementation((base: string, pattern: string) => ({ base, pattern })),
	}
})

// Mock TelemetryService
vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

// Mock i18n translator used in orchestrator messages
vi.mock("../../i18n", () => ({
	t: (key: string, params?: any) => {
		if (key === "embeddings:orchestrator.failedDuringInitialScan" && params?.errorMessage) {
			return `Failed during initial scan: ${params.errorMessage}`
		}
		return key
	},
}))

describe("CodeIndexOrchestrator - error path cleanup gating", () => {
	const workspacePath = "/test/workspace"

	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let scanner: any
	let fileWatcher: any

	beforeEach(() => {
		vi.clearAllMocks()

		configManager = {
			isFeatureConfigured: true,
		}

		// Minimal state manager that tracks state transitions
		let currentState = "Standby"
		stateManager = {
			get state() {
				return currentState
			},
			setSystemState: vi.fn().mockImplementation((state: string, _msg: string) => {
				currentState = state
			}),
			reportFileQueueProgress: vi.fn(),
			reportBlockIndexingProgress: vi.fn(),
		}

		cacheManager = {
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
		}

		vectorStore = {
			initialize: vi.fn(),
			hasIndexedData: vi.fn(),
			markIndexingIncomplete: vi.fn(),
			markIndexingComplete: vi.fn(),
			clearCollection: vi.fn().mockResolvedValue(undefined),
		}

		scanner = {
			scanDirectory: vi.fn(),
		}

		fileWatcher = {
			initialize: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn(),
			onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
		}
	})

	it("should not call clearCollection() or clear cache when initialize() fails (indexing not started)", async () => {
		// Arrange: fail at initialize()
		vectorStore.initialize.mockRejectedValue(new Error("Qdrant unreachable"))

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		// Act
		await orchestrator.startIndexing()

		// Assert
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()

		// Error state should be set
		expect(stateManager.setSystemState).toHaveBeenCalled()
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})

	it("should call clearCollection() and clear cache when an error occurs after initialize() succeeds (indexing started)", async () => {
		// Arrange: initialize succeeds; fail soon after to enter error path with indexingStarted=true
		vectorStore.initialize.mockResolvedValue(false) // existing collection
		vectorStore.hasIndexedData.mockResolvedValue(false) // force full scan path
		vectorStore.markIndexingIncomplete.mockRejectedValue(new Error("mark incomplete failure"))

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		// Act
		await orchestrator.startIndexing()

		// Assert: cleanup gated behind indexingStarted should have happened
		expect(vectorStore.clearCollection).toHaveBeenCalledTimes(1)
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)

		// Error state should be set
		expect(stateManager.setSystemState).toHaveBeenCalled()
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})

	it("preserves an existing index and reports incremental scan errors", async () => {
		const incrementalError = new Error("incremental delete failed")
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(true)
		vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
		scanner.scanDirectory.mockImplementation(async (_dir: string, onError: (error: Error) => void) => {
			onError(incrementalError)
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		})
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		await orchestrator.startIndexing()

		expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		expect(fileWatcher.initialize).not.toHaveBeenCalled()
		expect(stateManager.state).toBe("Error")
	})
})

describe("CodeIndexOrchestrator - stopIndexing", () => {
	const workspacePath = "/test/workspace"

	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let scanner: any
	let fileWatcher: any

	beforeEach(() => {
		vi.clearAllMocks()

		configManager = {
			isFeatureConfigured: true,
		}

		let currentState = "Standby"
		stateManager = {
			get state() {
				return currentState
			},
			setSystemState: vi.fn().mockImplementation((state: string, _msg: string) => {
				currentState = state
			}),
			reportFileQueueProgress: vi.fn(),
			reportBlockIndexingProgress: vi.fn(),
		}

		cacheManager = {
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
		}

		vectorStore = {
			initialize: vi.fn().mockResolvedValue(false),
			hasIndexedData: vi.fn().mockResolvedValue(false),
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			deleteCollection: vi.fn().mockResolvedValue(undefined),
		}

		scanner = {
			scanDirectory: vi.fn(),
		}

		fileWatcher = {
			initialize: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn(),
			onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
			whenIdle: vi.fn().mockResolvedValue(undefined),
		}
	})

	it("should abort indexing when stopIndexing() is called", async () => {
		// Make scanner hang until aborted
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				// Wait for abort signal
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		// Start indexing (async, don't await)
		const indexingPromise = orchestrator.startIndexing()

		// Give it a tick to begin
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Stop indexing
		orchestrator.stopIndexing()

		// Wait for indexing to complete
		await indexingPromise

		// State should be Standby (not Error)
		const setStateCalls = stateManager.setSystemState.mock.calls
		const lastCall = setStateCalls[setStateCalls.length - 1]
		expect(lastCall[0]).toBe("Standby")
	})

	it("should set state to Standby after abort, not Error", async () => {
		// Make scanner throw AbortError when signal is aborted
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				throw new DOMException("Indexing aborted", "AbortError")
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		const indexingPromise = orchestrator.startIndexing()
		await new Promise((resolve) => setTimeout(resolve, 10))

		orchestrator.stopIndexing()
		await indexingPromise

		// Should NOT have set Error state — abort is handled gracefully
		const errorCalls = stateManager.setSystemState.mock.calls.filter((call: any[]) => call[0] === "Error")
		expect(errorCalls).toHaveLength(0)

		// Should NOT have cleared collection on abort
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
	})

	it("should preserve partial index data after stop", async () => {
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				return { stats: { processed: 5, skipped: 0 }, totalBlockCount: 5 }
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		const indexingPromise = orchestrator.startIndexing()
		await new Promise((resolve) => setTimeout(resolve, 10))

		orchestrator.stopIndexing()
		await indexingPromise

		// Cache should NOT be cleared on user-initiated stop
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		// Collection should NOT be cleared on user-initiated stop
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
	})

	it("aborts and settles an active scan before clearing its collection", async () => {
		const scanStarted = deferred<AbortSignal>()
		const releaseScan = deferred<void>()
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				scanStarted.resolve(signal!)
				await releaseScan.promise
				return { stats: { processed: 1, skipped: 0 }, totalBlockCount: 1 }
			},
		)
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		const indexing = orchestrator.startIndexing()
		const signal = await scanStarted.promise
		const clearing = orchestrator.clearIndexData()
		await Promise.resolve()
		const deletedBeforeScanSettled = vectorStore.deleteCollection.mock.calls.length

		releaseScan.resolve(undefined)
		await Promise.all([indexing, clearing])

		expect(signal.aborted).toBe(true)
		expect(deletedBeforeScanSettled).toBe(0)
		expect(vectorStore.deleteCollection).toHaveBeenCalledTimes(1)
		expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
	})

	it("does not expose a second start when only the watcher is stopped during a scan", async () => {
		const scanStarted = deferred<void>()
		const releaseScan = deferred<void>()
		scanner.scanDirectory.mockImplementation(async () => {
			scanStarted.resolve(undefined)
			await releaseScan.promise
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		})
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		const firstStart = orchestrator.startIndexing()
		await scanStarted.promise
		orchestrator.stopWatcher()
		const secondStart = orchestrator.startIndexing()
		for (let i = 0; i < 5; i++) {
			await Promise.resolve()
		}
		const scanCallsBeforeRelease = scanner.scanDirectory.mock.calls.length

		releaseScan.resolve(undefined)
		await Promise.all([firstStart, secondStart])

		expect(scanCallsBeforeRelease).toBe(1)
	})

	it("keeps a watcher batch with local file errors out of the Indexed state", async () => {
		let progressHandler!: (progress: {
			processedInBatch: number
			totalInBatch: number
			currentFile?: string
		}) => void
		let finishHandler!: (summary: {
			processedFiles: Array<{ path: string; status: string; error?: Error }>
			batchError?: Error
		}) => void
		fileWatcher.onBatchProgressUpdate.mockImplementation((handler: typeof progressHandler) => {
			progressHandler = handler
			return { dispose: vi.fn() }
		})
		fileWatcher.onDidFinishBatchProcessing.mockImplementation((handler: typeof finishHandler) => {
			finishHandler = handler
			return { dispose: vi.fn() }
		})
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)
		await orchestrator.startIndexing()

		progressHandler({ processedInBatch: 0, totalInBatch: 1, currentFile: "broken.ts" })
		finishHandler({
			processedFiles: [{ path: "broken.ts", status: "local_error", error: new Error("parse failed") }],
		})
		progressHandler({ processedInBatch: 1, totalInBatch: 1 })

		expect(stateManager.state).toBe("Error")
	})

	it("delivers watcher failures after stop and restart", async () => {
		const { startEvent, progressEvent, finishEvent } = attachTerminalWatcherEvents(fileWatcher)
		fileWatcher.stop = vi.fn()
		fileWatcher.dispose = vi.fn(() => {
			startEvent.dispose()
			progressEvent.dispose()
			finishEvent.dispose()
		})
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		await orchestrator.startIndexing()
		orchestrator.stopIndexing()
		await orchestrator.whenIdle()
		await orchestrator.startIndexing()
		finishEvent.fire({
			processedFiles: [{ path: "broken.ts", status: "local_error", error: new Error("parse failed") }],
		})

		expect(fileWatcher.initialize).toHaveBeenCalledTimes(2)
		expect(stateManager.state).toBe("Error")
	})

	it("replaces watcher subscriptions when start is repeated", async () => {
		const { finishEvent } = attachTerminalWatcherEvents(fileWatcher)
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		await orchestrator.startIndexing()
		await orchestrator.startIndexing()
		const errorCallsBeforeBatch = stateManager.setSystemState.mock.calls.filter(
			([state]: [string]) => state === "Error",
		).length
		finishEvent.fire({
			processedFiles: [{ path: "broken.ts", status: "local_error", error: new Error("parse failed") }],
		})
		const errorCallsAfterBatch = stateManager.setSystemState.mock.calls.filter(
			([state]: [string]) => state === "Error",
		).length

		expect(errorCallsAfterBatch - errorCallsBeforeBatch).toBe(1)
	})
})
