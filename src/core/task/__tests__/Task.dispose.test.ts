import { EventEmitter } from "node:events"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AlphaCodeEventName, type ProviderSettings } from "@alpha-code/types"

import { Task } from "../Task"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { commandSessionRegistry } from "../../tools/CommandSessionRegistry"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import * as storage from "../../../utils/storage"

// Mock dependencies
vi.mock("../../webview/AlphaProvider")
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
		getTerminals: vi.fn(() => []),
	},
}))
vi.mock("../../ignore/AlphaIgnoreController")
vi.mock("../../protect/AlphaProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../tools/ToolRepetitionDetector")
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: () => ({ info: {}, id: "test-model" }),
	})),
}))

// Mock TelemetryService
vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

describe("Task dispose method", () => {
	let mockProvider: any
	let mockApiConfiguration: ProviderSettings
	let task: Task

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Mock provider
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/path" },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
		}

		// Mock API configuration
		mockApiConfiguration = {
			apiProvider: "vertex",
			apiKey: "test-key",
		} as ProviderSettings

		// Create task instance without starting it
		task = new Task({
			provider: mockProvider as AlphaProvider,
			apiConfiguration: mockApiConfiguration,
			startTask: false,
		})
	})

	afterEach(() => {
		// Clean up
		if (task && !task.abort) {
			task.dispose()
		}
	})

	test("should remove all event listeners when dispose is called", () => {
		// Add some event listeners using type assertion to bypass strict typing for testing
		const listener1 = vi.fn(() => {})
		const listener2 = vi.fn(() => {})
		const listener3 = vi.fn((taskId: string) => {})

		// Use type assertion to bypass strict event typing for testing
		;(task as any).on("TaskStarted", listener1)
		;(task as any).on("TaskAborted", listener2)
		;(task as any).on("TaskIdle", listener3)

		// Verify listeners are added
		expect(task.listenerCount("TaskStarted")).toBe(1)
		expect(task.listenerCount("TaskAborted")).toBe(1)
		expect(task.listenerCount("TaskIdle")).toBe(1)

		// Spy on removeAllListeners method
		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")

		// Call dispose
		task.dispose()

		// Verify removeAllListeners was called
		expect(removeAllListenersSpy).toHaveBeenCalledOnce()

		// Verify all listeners are removed
		expect(task.listenerCount("TaskStarted")).toBe(0)
		expect(task.listenerCount("TaskAborted")).toBe(0)
		expect(task.listenerCount("TaskIdle")).toBe(0)
	})

	test("releases unread command output ownership when its task instance is disposed", () => {
		const process = Object.assign(new EventEmitter(), {
			executionId: "settled-command",
			isSettled: true,
			hasUnretrievedOutput: () => true,
		}) as AlphaTerminalProcess
		const sessionId = commandSessionRegistry.register(task, process)
		expect(commandSessionRegistry.ownsOutput(process)).toBe(true)
		try {
			task.dispose()
			expect(commandSessionRegistry.ownsOutput(process)).toBe(false)
			expect(commandSessionRegistry.resolve(task, sessionId)).toBeUndefined()
			expect(process.hasUnretrievedOutput()).toBe(true)
		} finally {
			commandSessionRegistry.release(task, sessionId)
		}
	})

	test.each(["retained", "current"] as const)(
		"releases every remaining task resource when the %s provider disposer throws",
		(failingProvider) => {
			const currentHandler = { ...task.api, dispose: vi.fn() }
			const firstRetainedHandler = { ...task.api, dispose: vi.fn() }
			const laterRetainedHandler = { ...task.api, dispose: vi.fn() }
			const failedHandler = failingProvider === "retained" ? firstRetainedHandler : currentHandler
			const cleanupFailure = new Error("Provider cleanup failed")
			failedHandler.dispose.mockImplementation(() => {
				throw cleanupFailure
			})
			task.api = currentHandler
			task["retainedReasoningHandlers"].add(firstRetainedHandler)
			task["retainedReasoningHandlers"].add(laterRetainedHandler)

			const taskSignal = task.getTaskLifetimeCancellationSignal()
			const queueDispose = vi.spyOn(task.messageQueueService, "dispose")
			const ignoreDispose = vi.spyOn(task["alphaIgnoreController"]!, "dispose")
			const trackerDispose = vi.spyOn(task["fileContextTracker"], "dispose")
			task.on(AlphaCodeEventName.TaskAborted, vi.fn())
			const process = Object.assign(new EventEmitter(), {
				executionId: "provider-disposal-command",
				isSettled: true,
				hasUnretrievedOutput: () => true,
			}) as AlphaTerminalProcess
			const sessionId = commandSessionRegistry.register(task, process)
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				let thrown: unknown
				try {
					task.dispose({ preserveCommandOutputArtifacts: true })
				} catch (error) {
					thrown = error
				}
				expect(thrown).toBe(cleanupFailure)

				expect(firstRetainedHandler.dispose).toHaveBeenCalledOnce()
				expect(laterRetainedHandler.dispose).toHaveBeenCalledOnce()
				expect(currentHandler.dispose).toHaveBeenCalledOnce()
				expect(taskSignal.aborted).toBe(true)
				expect(queueDispose).toHaveBeenCalledOnce()
				expect(task.messageQueueService.listenerCount("stateChanged")).toBe(0)
				expect(task.eventNames()).toEqual([])
				expect(commandSessionRegistry.ownsOutput(process)).toBe(false)
				expect(commandSessionRegistry.resolve(task, sessionId)).toBeUndefined()
				expect(ignoreDispose).toHaveBeenCalledOnce()
				expect(trackerDispose).toHaveBeenCalledOnce()

				expect(() => task.dispose({ preserveCommandOutputArtifacts: true })).not.toThrow()
				expect(firstRetainedHandler.dispose).toHaveBeenCalledOnce()
				expect(laterRetainedHandler.dispose).toHaveBeenCalledOnce()
				expect(currentHandler.dispose).toHaveBeenCalledOnce()
			} finally {
				commandSessionRegistry.release(task, sessionId)
				consoleError.mockRestore()
				queueDispose.mockRestore()
				ignoreDispose.mockRestore()
				trackerDispose.mockRestore()
			}
		},
	)

	test("reports every provider cleanup failure after releasing the remaining resources", () => {
		const retainedFailure = new Error("Retained provider cleanup failed")
		const currentFailure = new Error("Current provider cleanup failed")
		const currentHandler = {
			...task.api,
			dispose: vi.fn(() => {
				throw currentFailure
			}),
		}
		const failingRetainedHandler = {
			...task.api,
			dispose: vi.fn(() => {
				throw retainedFailure
			}),
		}
		const laterRetainedHandler = { ...task.api, dispose: vi.fn() }
		task.api = currentHandler
		task["retainedReasoningHandlers"].add(failingRetainedHandler)
		task["retainedReasoningHandlers"].add(laterRetainedHandler)
		const queueDispose = vi.spyOn(task.messageQueueService, "dispose")
		const trackerDispose = vi.spyOn(task["fileContextTracker"], "dispose")
		task.on(AlphaCodeEventName.TaskAborted, vi.fn())
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			let thrown: unknown
			try {
				task.dispose({ preserveCommandOutputArtifacts: true })
			} catch (error) {
				thrown = error
			}
			expect(thrown).toBeInstanceOf(AggregateError)
			if (!(thrown instanceof AggregateError)) throw new Error("Expected all provider cleanup failures")
			expect(thrown.errors).toHaveLength(2)
			expect(thrown.errors[0]).toBe(retainedFailure)
			expect(thrown.errors[1]).toBe(currentFailure)
			expect(laterRetainedHandler.dispose).toHaveBeenCalledOnce()
			expect(queueDispose).toHaveBeenCalledOnce()
			expect(trackerDispose).toHaveBeenCalledOnce()
			expect(task.getTaskLifetimeCancellationSignal().aborted).toBe(true)
			expect(task.eventNames()).toEqual([])

			expect(() => task.dispose({ preserveCommandOutputArtifacts: true })).not.toThrow()
			expect(failingRetainedHandler.dispose).toHaveBeenCalledOnce()
			expect(laterRetainedHandler.dispose).toHaveBeenCalledOnce()
			expect(currentHandler.dispose).toHaveBeenCalledOnce()
		} finally {
			consoleError.mockRestore()
			queueDispose.mockRestore()
			trackerDispose.mockRestore()
		}
	})

	test("should handle errors when removing event listeners", () => {
		// Mock removeAllListeners to throw an error
		const originalRemoveAllListeners = task.removeAllListeners
		task.removeAllListeners = vi.fn(() => {
			throw new Error("Test error")
		})

		// Spy on console.error
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		// Call dispose - should not throw
		expect(() => task.dispose()).not.toThrow()

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalledWith("Error removing event listeners:", expect.any(Error))

		// Restore
		task.removeAllListeners = originalRemoveAllListeners
		consoleErrorSpy.mockRestore()
	})

	test("should prevent memory leaks by removing listeners before other cleanup", () => {
		// Add multiple listeners of different types using type assertion for testing
		const listeners = {
			TaskStarted: vi.fn(function () {}),
			TaskAborted: vi.fn(function () {}),
			TaskIdle: vi.fn(function (taskId: string) {}),
			TaskActive: vi.fn(function (taskId: string) {}),
			TaskAskResponded: vi.fn(function () {}),
			Message: vi.fn(function (data: { action: "created" | "updated"; message: any }) {}),
			TaskTokenUsageUpdated: vi.fn(function (taskId: string, tokenUsage: any) {}),
			TaskToolFailed: vi.fn(function (taskId: string, tool: any, error: string) {}),
			TaskUnpaused: vi.fn(function () {}),
		}

		// Add all listeners using type assertion to bypass strict typing for testing
		const taskAny = task as any
		taskAny.on("TaskStarted", listeners.TaskStarted)
		taskAny.on("TaskAborted", listeners.TaskAborted)
		taskAny.on("TaskIdle", listeners.TaskIdle)
		taskAny.on("TaskActive", listeners.TaskActive)
		taskAny.on("TaskAskResponded", listeners.TaskAskResponded)
		taskAny.on("Message", listeners.Message)
		taskAny.on("TaskTokenUsageUpdated", listeners.TaskTokenUsageUpdated)
		taskAny.on("TaskToolFailed", listeners.TaskToolFailed)
		taskAny.on("TaskUnpaused", listeners.TaskUnpaused)

		// Verify all listeners are added
		expect(task.listenerCount("TaskStarted")).toBe(1)
		expect(task.listenerCount("TaskAborted")).toBe(1)
		expect(task.listenerCount("TaskIdle")).toBe(1)
		expect(task.listenerCount("TaskActive")).toBe(1)
		expect(task.listenerCount("TaskAskResponded")).toBe(1)
		expect(task.listenerCount("Message")).toBe(1)
		expect(task.listenerCount("TaskTokenUsageUpdated")).toBe(1)
		expect(task.listenerCount("TaskToolFailed")).toBe(1)
		expect(task.listenerCount("TaskUnpaused")).toBe(1)

		// Call dispose
		task.dispose()

		// Verify all listeners are removed
		expect(task.listenerCount("TaskStarted")).toBe(0)
		expect(task.listenerCount("TaskAborted")).toBe(0)
		expect(task.listenerCount("TaskIdle")).toBe(0)
		expect(task.listenerCount("TaskActive")).toBe(0)
		expect(task.listenerCount("TaskAskResponded")).toBe(0)
		expect(task.listenerCount("Message")).toBe(0)
		expect(task.listenerCount("TaskTokenUsageUpdated")).toBe(0)
		expect(task.listenerCount("TaskToolFailed")).toBe(0)
		expect(task.listenerCount("TaskUnpaused")).toBe(0)

		// Verify total listener count is 0
		expect(task.eventNames().length).toBe(0)
	})
})

describe("Task dispose artifact storage", () => {
	test("does not recreate removed task storage when delayed output cleanup resumes", async () => {
		const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-dispose-output-"))
		const resolvedStorageRoot = path.resolve(storageRoot)
		if (
			path.dirname(resolvedStorageRoot) !== path.resolve(os.tmpdir()) ||
			!path.basename(resolvedStorageRoot).startsWith("alpha-task-dispose-output-")
		) {
			throw new Error("Refusing to remove storage outside its owned temporary root")
		}
		const provider = {
			context: { globalStorageUri: { fsPath: storageRoot } },
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
		} as unknown as AlphaProvider
		const ownedTask = new Task({
			provider,
			apiConfiguration: { apiProvider: "vertex" },
			taskId: "dispose-output-cleanup",
			taskMode: "code",
			taskApiConfigName: "Dispose fixture",
			startTask: false,
		})
		let releaseLookup!: () => void
		const lookupPermit = new Promise<void>((resolve) => {
			releaseLookup = resolve
		})
		let finishCleanup!: () => void
		const cleanupFinished = new Promise<void>((resolve) => {
			finishCleanup = resolve
		})
		let lookupHeld = false
		const nativeCreatingResolver = storage.getTaskDirectoryPath
		const nativeReadOnlyResolver = storage.resolveExistingTaskDirectoryPathReadOnly
		const holdOwnedLookup =
			(nativeResolver: typeof nativeCreatingResolver) => async (storagePath: string, taskId: string) => {
				if (storagePath === storageRoot && taskId === ownedTask.taskId && !lookupHeld) {
					lookupHeld = true
					await lookupPermit
				}
				return nativeResolver(storagePath, taskId)
			}
		const taskDirectory = storage.resolveTaskDirectoryPath(storageRoot, ownedTask.taskId)
		const outputDirectory = path.join(taskDirectory, "command-output")
		const nativeCleanup = OutputInterceptor.cleanupByIds
		const ownedCleanup = vi.fn()
		const cleanup = vi.spyOn(OutputInterceptor, "cleanupByIds").mockImplementation(async (...args) => {
			if (args[0] === outputDirectory) ownedCleanup(...args)
			try {
				await nativeCleanup(...args)
			} finally {
				if (args[0] === outputDirectory) finishCleanup()
			}
		})
		try {
			// Join constructor-owned queue I/O before isolating dispose's later lookup.
			await ownedTask.messageQueueService.ready
			await ownedTask.messageQueueService.flush()
			await expect(fs.stat(taskDirectory)).resolves.toBeDefined()
			const creatingResolver = vi
				.spyOn(storage, "getTaskDirectoryPath")
				.mockImplementation(holdOwnedLookup(nativeCreatingResolver))
			const readOnlyResolver = vi
				.spyOn(storage, "resolveExistingTaskDirectoryPathReadOnly")
				.mockImplementation(holdOwnedLookup(nativeReadOnlyResolver))
			try {
				ownedTask.dispose()
				expect(lookupHeld).toBe(true)
				expect(ownedCleanup).not.toHaveBeenCalled()
				// Goal shutdown also reads storage; join it while output cleanup stays held.
				await ownedTask.waitForTermination()
				if (
					path.dirname(resolvedStorageRoot) !== path.resolve(os.tmpdir()) ||
					!path.basename(resolvedStorageRoot).startsWith("alpha-task-dispose-output-") ||
					path.dirname(path.resolve(taskDirectory)) !== path.join(resolvedStorageRoot, "tasks") ||
					path.basename(taskDirectory) !== ownedTask.taskId
				) {
					throw new Error("Refusing to remove storage outside the owned temporary task")
				}
				await fs.rm(taskDirectory, { recursive: true, force: true })
				releaseLookup()
				await cleanupFinished
				await ownedTask.waitForTermination()
				expect(ownedCleanup).toHaveBeenCalledOnce()
				await expect(fs.stat(taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
			} finally {
				releaseLookup()
				if (lookupHeld) await cleanupFinished
				creatingResolver.mockRestore()
				readOnlyResolver.mockRestore()
			}
		} finally {
			ownedTask.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
			await ownedTask.waitForTermination()
			await ownedTask.messageQueueService.flush()
			cleanup.mockRestore()
			await fs.rm(resolvedStorageRoot, { recursive: true, force: true })
		}
	})
})
