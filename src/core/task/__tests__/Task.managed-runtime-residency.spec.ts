import { afterEach, describe, expect, it, vi } from "vitest"

import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import * as taskStorage from "../../../utils/storage"
import { commandSessionRegistry } from "../../tools/CommandSessionRegistry"
import { Task } from "../Task"

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const createIdleChild = () => {
	const fields = {
		taskId: "resident-child",
		instanceId: "resident-instance",
		taskKind: "subagent",
		initialStatus: "completed",
		abort: false,
		abandoned: false,
		didComplete: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isStreaming: false,
		isWaitingForFirstChunk: false,
		queuedInput: false,
		isCurrentApiConversationHistoryOwner: () => true,
		messageQueueService: {
			hasUnconsumedInput: () => fields.queuedInput,
			dispose: vi.fn(),
		},
		pendingWaitAgentResultClaims: new Map(),
		userMessageContent: [],
		commandExecutionEvidence: new Map(),
		diffViewProvider: { isEditing: false },
		canonicalLifecycleQueue: Promise.resolve(),
		alphaMessagesSaveQueue: Promise.resolve(),
		goalShutdownPromise: Promise.resolve(),
		flushApiConversationHistoryPersistence: vi.fn(async () => undefined),
		dispose: vi.fn(),
		abortTask: vi.fn(),
	}
	return { child: Object.assign(Object.create(Task.prototype), fields) as Task, fields }
}

afterEach(() => vi.restoreAllMocks())

describe("Task managed runtime residency eligibility", () => {
	it.each(["completed", "blocked", "failed", "cancelled", "timed_out", "interrupted"])(
		"allows a stopped %s child without changing its terminal outcome",
		async (status) => {
			vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
			const { child, fields } = createIdleChild()
			Reflect.set(child, "initialStatus", status)

			expect(child.canUnloadSubagentRuntime()).toBe(true)
			await child.unloadSubagentRuntime()

			expect(Reflect.get(child, "initialStatus")).toBe(status)
			expect(fields.abortTask).not.toHaveBeenCalled()
			expect(fields.dispose).toHaveBeenCalledExactlyOnceWith({ preserveCommandOutputArtifacts: true })
		},
	)

	it.each([
		["primary task", { taskKind: "primary" }],
		["nonterminal saved status", { initialStatus: "active" }],
		["active task loop", { isTaskLoopActive: true }],
		["active turn engine", { isAgentTurnEngineActive: true }],
		["streaming response", { isStreaming: true }],
		["waiting for first response", { isWaitingForFirstChunk: true }],
		["inflight compaction", { contextCondenseAbortController: new AbortController() }],
		["pending ask", { activeAsk: {} }],
		["pending tool approval", { activeToolApprovalRequest: {} }],
		["pending steering", { pendingSteerMessage: {} }],
		["steering awaiting persistence", { steerMessageAwaitingPersistence: true }],
		["unsettled command", { commandExecutionEvidence: new Map([["call", { status: "running" }]]) }],
		["retained wait claim", { pendingWaitAgentResultClaims: new Map([["claim", {}]]) }],
		[
			"uncommitted tool result",
			{ userMessageContent: [{ type: "tool_result", tool_use_id: "call", content: "result" }] },
		],
		["open edit", { diffViewProvider: { isEditing: true } }],
		["unsettled terminal process", { terminalProcess: { isSettled: false } }],
		["pending terminal output finalization", { terminalProcess: { isSettled: true, isOutputFinalized: false } }],
		[
			"terminal output receipt in flight",
			{ terminalProcess: { isSettled: true, isOutputFinalized: true, hasActiveOutputReceipt: () => true } },
		],
	] as const)("retains a runtime with %s", (_name, overrides) => {
		vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
		const { child, fields } = createIdleChild()
		Object.assign(child, overrides)

		expect(child.canUnloadSubagentRuntime()).toBe(false)
		expect(fields.dispose).not.toHaveBeenCalled()
	})

	it("retains unconsumed user input and background terminals", () => {
		const terminals = vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
		const { child, fields } = createIdleChild()
		fields.queuedInput = true
		expect(child.canUnloadSubagentRuntime()).toBe(false)
		fields.queuedInput = false
		terminals.mockReturnValue([{ running: true }] as unknown as ReturnType<typeof TerminalRegistry.getTerminals>)
		expect(child.canUnloadSubagentRuntime()).toBe(false)
	})

	it("retains a stopped owned terminal until its final output and receipt finish", () => {
		const process = {
			isSettled: true,
			isOutputFinalized: false,
			receiptActive: false,
			hasActiveOutputReceipt(): boolean {
				return this.receiptActive
			},
		}
		const idleTerminals = [{ running: false, process }] as unknown as ReturnType<
			typeof TerminalRegistry.getTerminals
		>
		vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((busy) => (busy ? [] : idleTerminals))
		const { child } = createIdleChild()

		expect(child.canUnloadSubagentRuntime()).toBe(false)
		process.isOutputFinalized = true
		process.receiptActive = true
		expect(child.canUnloadSubagentRuntime()).toBe(false)
		process.receiptActive = false
		expect(child.canUnloadSubagentRuntime()).toBe(true)
	})

	it("checks queued output processes even when the terminal has no current process", () => {
		const queued = { isSettled: true, isOutputFinalized: false }
		const idle = [{ running: false, getProcessesWithOutput: () => [queued] }] as unknown as ReturnType<
			typeof TerminalRegistry.getTerminals
		>
		vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((busy) => (busy ? [] : idle))
		const { child } = createIdleChild()

		expect(child.canUnloadSubagentRuntime()).toBe(false)
		queued.isOutputFinalized = true
		expect(child.canUnloadSubagentRuntime()).toBe(true)
	})
})

describe("Task managed runtime unload boundary", () => {
	it("joins termination and serialized transcript writes before disposal, then joins goal cleanup", async () => {
		vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
		const { child, fields } = createIdleChild()
		const termination = deferred()
		const canonical = deferred()
		const api = deferred()
		const apiStarted = deferred()
		const alpha = deferred()
		const disposed = deferred()
		const goalStopped = deferred()
		Reflect.set(child, "taskTerminationPromise", termination.promise)
		Reflect.set(child, "canonicalLifecycleQueue", canonical.promise)
		Reflect.set(child, "alphaMessagesSaveQueue", alpha.promise)
		fields.flushApiConversationHistoryPersistence.mockImplementation(async () => {
			apiStarted.resolve()
			await api.promise
		})
		fields.dispose.mockImplementation(() => {
			Reflect.set(child, "goalShutdownPromise", goalStopped.promise)
			disposed.resolve()
		})
		let settled = false
		const unloading = child.unloadSubagentRuntime().then(() => {
			settled = true
		})
		expect(fields.dispose).not.toHaveBeenCalled()
		termination.resolve()
		canonical.resolve()
		await apiStarted.promise
		expect(fields.dispose).not.toHaveBeenCalled()
		api.resolve()
		alpha.resolve()
		await disposed.promise

		expect(fields.dispose).toHaveBeenCalledExactlyOnceWith({ preserveCommandOutputArtifacts: true })
		expect(settled).toBe(false)
		expect(child.abort).toBe(true)
		expect(child.abandoned).toBe(true)
		expect(Reflect.get(child, "initialStatus")).toBe("completed")
		goalStopped.resolve()
		await unloading
		expect(settled).toBe(true)
		expect(fields.abortTask).not.toHaveBeenCalled()
	})

	it("vetoes disposal when input arrives while terminal persistence is settling", async () => {
		vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
		const { child, fields } = createIdleChild()
		fields.flushApiConversationHistoryPersistence.mockImplementation(async () => {
			fields.queuedInput = true
		})

		await expect(child.unloadSubagentRuntime()).rejects.toThrow("changed before unloading")
		expect(fields.dispose).not.toHaveBeenCalled()
		expect(child.abort).toBe(false)
		expect(child.abandoned).toBe(false)
	})

	it("retains the runtime when serialized persistence fails", async () => {
		vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
		const { child, fields } = createIdleChild()
		fields.flushApiConversationHistoryPersistence.mockRejectedValue(new Error("transcript write failed"))

		await expect(child.unloadSubagentRuntime()).rejects.toThrow("transcript write failed")
		expect(fields.dispose).not.toHaveBeenCalled()
		expect(fields.abortTask).not.toHaveBeenCalled()
		expect(child.abort).toBe(false)
		expect(child.abandoned).toBe(false)
	})

	it("coalesces repeated unload calls into one owned disposal", async () => {
		vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
		const { child, fields } = createIdleChild()
		const termination = deferred()
		Reflect.set(child, "taskTerminationPromise", termination.promise)

		const first = child.unloadSubagentRuntime()
		const second = child.unloadSubagentRuntime()
		expect(second).toBe(first)
		termination.resolve()
		await first
		await second
		expect(fields.dispose).toHaveBeenCalledOnce()
	})

	it("allows a failed persistence boundary to be retried before disposal", async () => {
		vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
		const { child, fields } = createIdleChild()
		fields.flushApiConversationHistoryPersistence.mockRejectedValueOnce(new Error("retryable persistence failure"))

		await expect(child.unloadSubagentRuntime()).rejects.toThrow("retryable persistence failure")
		expect(fields.dispose).not.toHaveBeenCalled()
		await child.unloadSubagentRuntime()
		expect(fields.dispose).toHaveBeenCalledOnce()
	})

	it("preserves durable command artifacts through the actual dispose branch used for eviction", async () => {
		const { child } = createIdleChild()
		Reflect.deleteProperty(child, "dispose")
		Object.assign(child, {
			alphaMessages: [],
			apiConversationHistory: [],
			debouncedEmitTokenUsage: { cancel: vi.fn() },
			stopGoalForTaskCancellation: vi.fn(async () => undefined),
			retainedReasoningHandlers: new Set(),
			api: { dispose: vi.fn() },
			releaseSubagentReviewBarrierIfSettled: vi.fn(),
			invalidateStreamingPreviewEpoch: vi.fn(),
			taskCancellationController: new AbortController(),
			cancelCurrentRequest: vi.fn(),
			removeAllListeners: vi.fn(),
			fileContextTracker: { dispose: vi.fn() },
		})
		vi.spyOn(TerminalRegistry, "releaseTerminalsForTask").mockImplementation(() => undefined)
		vi.spyOn(commandSessionRegistry, "releaseForTask").mockImplementation(() => undefined)
		const storage = vi.spyOn(taskStorage, "getTaskDirectoryPath")
		const cleanup = vi.spyOn(OutputInterceptor, "cleanup").mockResolvedValue(undefined)
		const cleanupByIds = vi.spyOn(OutputInterceptor, "cleanupByIds").mockResolvedValue(undefined)
		vi.spyOn(console, "log").mockImplementation(() => undefined)

		child.dispose({ preserveCommandOutputArtifacts: true })
		await Promise.resolve()

		expect(storage).not.toHaveBeenCalled()
		expect(cleanup).not.toHaveBeenCalled()
		expect(cleanupByIds).not.toHaveBeenCalled()
		expect(Reflect.get(child, "initialStatus")).toBe("completed")
	})
})
