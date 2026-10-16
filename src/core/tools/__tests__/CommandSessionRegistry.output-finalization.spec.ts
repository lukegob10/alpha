import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CommandSessionRegistry } from "../CommandSessionRegistry"
import type { Task } from "../../task/Task"
import { BaseTerminalProcess } from "../../../integrations/terminal/BaseTerminalProcess"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((fulfilled, rejected) => {
		resolve = fulfilled
		reject = rejected
	})
	return { promise, resolve, reject }
}

function outcome(promise: Promise<void>) {
	return promise.then(
		() => ({ status: "fulfilled" as const }),
		(reason: unknown) => ({ status: "rejected" as const, reason }),
	)
}

function expectExactRejection(result: Awaited<ReturnType<typeof outcome>>, reason: unknown) {
	expect(result.status).toBe("rejected")
	if (result.status === "rejected") expect(result.reason).toBe(reason)
}

class OutputProcess extends BaseTerminalProcess {
	readonly abort = vi.fn()

	constructor(executionId: string) {
		super()
		this.executionId = executionId
	}

	async run(): Promise<void> {}

	continue(): void {
		this.emit("continue")
	}

	hasUnretrievedOutput(): boolean {
		return this.lastRetrievedIndex < this.fullOutput.length
	}

	protected getUnretrievedOutputRange(maxCharacters: number) {
		const endIndex = this.safeOutputRangeEnd(
			Math.min(this.fullOutput.length, this.lastRetrievedIndex + maxCharacters),
		)
		return { output: this.fullOutput.slice(this.lastRetrievedIndex, endIndex), endIndex }
	}
}

function task(taskId = "same-task-id"): Task {
	return { taskId } as Task
}

function track(
	registry: CommandSessionRegistry,
	owner: Task,
	process: OutputProcess,
	executionId: string,
	archiveExecutionId = "1000",
	isClosed = () => true,
) {
	registry.trackTaskOutput(owner, process, executionId, { archiveExecutionId, isClosed })
}

beforeEach(() => {
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
})

afterEach(() => vi.restoreAllMocks())

// These new-API controls are GREEN-only. Existing public runCommand/Task Stop
// regressions in the companion files provide assertion-based pre-fix oracles.
describe("original Task output finalization ownership", () => {
	it("tracks an unpublished archive without claiming stdout or starting finalization", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("physical:first")
		const closeEntered = deferred<void>()
		const releaseClose = deferred<void>()
		const finalizer = vi.fn(async () => {
			closeEntered.resolve()
			await releaseClose.promise
		})
		process.setOutputFinalizer(finalizer)
		const finalize = vi.spyOn(process, "finalizeOutput")
		const terminalLookup = vi.mocked(TerminalRegistry.getTerminals)
		terminalLookup.mockClear()
		try {
			track(registry, owner, process, "physical:first")
			track(registry, owner, process, "physical:first")
			const snapshot = registry.capturePendingTaskOutput(owner)
			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]).toMatchObject({ executionId: "physical:first", process })
			expect(Object.isFrozen(snapshot)).toBe(true)
			expect(Object.isFrozen(snapshot[0])).toBe(true)
			expect(registry.ownsOutput(process)).toBe(false)
			expect(snapshot[0]!.isCleanupSafe()).toBe(false)
			expect(finalizer).not.toHaveBeenCalled()
			expect(finalize).not.toHaveBeenCalled()
			expect(process.abort).not.toHaveBeenCalled()
			expect(terminalLookup).not.toHaveBeenCalled()
			const actualFinalization = process.finalizeOutput()
			const observed = outcome(snapshot[0]!.completion)
			await closeEntered.promise
			expect(process.isOutputFinalized).toBe(false)
			releaseClose.resolve()
			await actualFinalization
			expect(await observed).toEqual({ status: "fulfilled" })
			expect(snapshot[0]!.isCleanupSafe()).toBe(true)
			expect(finalizer).toHaveBeenCalledOnce()
		} finally {
			releaseClose.resolve()
			await outcome(process.finalizeOutput())
			registry.releaseForTask(owner)
		}
	})

	it("keeps ownership on the original Task object when another instance has the same task ID", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const replacement = task()
		const original = new OutputProcess("physical:original")
		const replacementProcess = new OutputProcess("physical:replacement")
		try {
			track(registry, owner, original, "physical:original", "1000")
			track(registry, replacement, replacementProcess, "physical:replacement", "1001")
			const captured = registry.capturePendingTaskOutput(owner)
			expect(captured.map((entry) => entry.process)).toEqual([original])
			expect(registry.capturePendingTaskOutput(replacement).map((entry) => entry.process)).toEqual([
				replacementProcess,
			])
			registry.releaseForTask(owner)
			expect(registry.capturePendingTaskOutput(owner)[0]!.completion).toBe(captured[0]!.completion)
			expect(registry.capturePendingTaskOutput(replacement)[0]!.process).toBe(replacementProcess)
			await original.finalizeOutput()
			await captured[0]!.completion
			expect(replacementProcess.isOutputFinalized).toBe(false)
		} finally {
			await Promise.all([outcome(original.finalizeOutput()), outcome(replacementProcess.finalizeOutput())])
			registry.releaseForTask(owner)
			registry.releaseForTask(replacement)
		}
	})

	it("revokes public polling while a released session retains its unfinished archive", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("physical:published")
		process.emit("completed", "")
		const releaseClose = deferred<void>()
		process.setOutputFinalizer(() => releaseClose.promise)
		try {
			track(registry, owner, process, "physical:published")
			const pending = registry.capturePendingTaskOutput(owner)[0]!
			const sessionId = registry.register(owner, process)
			expect(registry.ownsOutput(process)).toBe(true)
			expect(registry.resolve(owner, sessionId)?.process).toBe(process)
			registry.release(owner, sessionId)
			expect(registry.ownsOutput(process)).toBe(false)
			expect(registry.resolve(owner, sessionId)).toBeUndefined()
			expect(registry.capturePendingTaskOutput(owner)[0]!.completion).toBe(pending.completion)
			// A delayed background publisher cannot reclaim this original session.
			expect(() => registry.register(owner, process)).toThrow()
			expect(registry.ownsOutput(process)).toBe(false)
			expect(registry.resolve(owner, sessionId)).toBeUndefined()
			releaseClose.resolve()
			await process.finalizeOutput()
			await pending.completion
		} finally {
			releaseClose.resolve()
			await outcome(process.finalizeOutput())
			registry.releaseForTask(owner)
		}
	})

	it("captures a physically completed archive with no unread output or terminal reference", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("physical:exited")
		const releaseClose = deferred<void>()
		process.setOutputFinalizer(() => releaseClose.promise)
		track(registry, owner, process, "physical:exited")
		process.emit("shell_execution_complete", { exitCode: 0 })
		process.emit("completed", "")
		const finalizing = process.finalizeOutput()
		try {
			expect(process.hasUnretrievedOutput()).toBe(false)
			expect(process.isSettled).toBe(true)
			expect(process.isOutputFinalized).toBe(false)
			const captured = registry.capturePendingTaskOutput(owner)
			expect(captured).toHaveLength(1)
			expect(captured[0]!.process).toBe(process)
			registry.releaseForTask(owner)
			expect(registry.capturePendingTaskOutput(owner)[0]!.completion).toBe(captured[0]!.completion)
			expect(() => registry.register(owner, process)).toThrow()
			expect(registry.ownsOutput(process)).toBe(false)
			releaseClose.resolve()
			await finalizing
			await captured[0]!.completion
			expect(process.abort).not.toHaveBeenCalled()
		} finally {
			releaseClose.resolve()
			await outcome(finalizing)
			registry.releaseForTask(owner)
		}
	})

	it.each([
		["undefined", undefined],
		["null", null],
		["Error", new Error("synthetic archive failure")],
	] as const)(
		"preserves an archive rejection with %s while retaining the original snapshot",
		async (_label, reason) => {
			const registry = new CommandSessionRegistry()
			const owner = task()
			const process = new OutputProcess("physical:reject")
			const closeEntered = deferred<void>()
			const releaseClose = deferred<void>()
			process.setOutputFinalizer(async () => {
				closeEntered.resolve()
				await releaseClose.promise
			})
			track(registry, owner, process, "physical:reject")
			const captured = registry.capturePendingTaskOutput(owner)[0]!
			const observed = outcome(captured.completion)
			const actual = outcome(process.finalizeOutput())
			try {
				await closeEntered.promise
				registry.releaseForTask(owner)
				releaseClose.reject(reason)
				expectExactRejection(await actual, reason)
				expectExactRejection(await observed, reason)
				expect(captured.executionId).toBe("physical:reject")
				expect(captured.process).toBe(process)
				expect(process.outputArtifactId).toBeUndefined()
				// A rejected attempt alone does not prove that an underlying fd closed.
			} finally {
				releaseClose.resolve()
				await actual
				await observed
				registry.releaseForTask(owner)
			}
		},
	)

	it("retains the immutable original barrier when a mutable execution ID changes", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("physical:original")
		const releaseClose = deferred<void>()
		process.setOutputFinalizer(() => releaseClose.promise)
		const thenAccessed = vi.fn(() => {
			throw new Error("A process thenable is not an output finalization barrier")
		})
		Object.defineProperty(process, "then", { configurable: true, get: thenAccessed })
		track(registry, owner, process, "physical:original")
		const captured = registry.capturePendingTaskOutput(owner)[0]!
		try {
			process.executionId = "physical:replacement"
			registry.releaseForTask(owner)
			const afterMutation = registry.capturePendingTaskOutput(owner)[0]!
			expect(afterMutation.executionId).toBe("physical:original")
			expect(afterMutation.executionId).not.toBe(process.executionId)
			expect(afterMutation.completion).toBe(captured.completion)
			expect(afterMutation.process).toBe(process)
			expect(thenAccessed).not.toHaveBeenCalled()
			expect(process.abort).not.toHaveBeenCalled()
			const actual = process.finalizeOutput()
			releaseClose.resolve()
			await actual
			await captured.completion
			expect(thenAccessed).not.toHaveBeenCalled()
			expect(captured.isCleanupSafe()).toBe(false)
			expect(registry.capturePendingTaskOutput(owner)[0]!.completion).toBe(captured.completion)
		} finally {
			releaseClose.resolve()
			await outcome(process.finalizeOutput())
			registry.releaseForTask(owner)
		}
	})

	it("bridges an existing Base session without guessing its unknown archive filename", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("1000:physical-uuid")
		process.emit("completed", "")
		const releaseClose = deferred<void>()
		process.setOutputFinalizer(() => releaseClose.promise)
		try {
			const sessionId = registry.register(owner, process)
			const captured = registry.capturePendingTaskOutput(owner)
			expect(captured).toHaveLength(1)
			expect(captured[0]!.executionId).toBe("1000:physical-uuid")
			expect(captured[0]!.archiveExecutionId).toBeUndefined()
			expect(captured[0]!.isCleanupSafe()).toBe(false)
			expect(process.outputArtifactId).toBeUndefined()
			registry.release(owner, sessionId)
			expect(registry.ownsOutput(process)).toBe(false)
			releaseClose.resolve()
			await process.finalizeOutput()
			await captured[0]!.completion
			// Successful closure cannot manufacture the absent row/archive identity.
			expect(captured[0]!.isCleanupSafe()).toBe(false)
			expect(registry.capturePendingTaskOutput(owner)[0]!.completion).toBe(captured[0]!.completion)
			registry.releaseForTask(owner)
			expect(registry.capturePendingTaskOutput(owner)[0]!.archiveExecutionId).toBeUndefined()
			expect(registry.capturePendingTaskOutput(owner)[0]!.isCleanupSafe()).toBe(false)
		} finally {
			releaseClose.resolve()
			await outcome(process.finalizeOutput())
			registry.releaseForTask(owner)
		}
	})

	it("keeps failed unconfirmed closure unsafe despite finalized flags and public release", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("1000:physical-uuid")
		const releaseClose = deferred<void>()
		let sinkClosed = false
		let closeObservationFails = false
		process.setOutputFinalizer(() => releaseClose.promise)
		track(registry, owner, process, "1000:physical-uuid", "1000", () => {
			if (closeObservationFails) throw new Error("synthetic sink-close observation failure")
			return sinkClosed
		})
		const captured = registry.capturePendingTaskOutput(owner)[0]!
		const observed = outcome(captured.completion)
		const actual = outcome(process.finalizeOutput())
		try {
			expect(captured.archiveExecutionId).toBe("1000")
			expect(captured.archiveExecutionId).not.toBe(captured.executionId)
			expect(captured.isCleanupSafe()).toBe(false)
			releaseClose.reject(undefined)
			expect(await actual).toEqual({ status: "rejected", reason: undefined })
			expect(await observed).toEqual({ status: "rejected", reason: undefined })
			expect(process.isOutputFinalized).toBe(true)
			expect(captured.isCleanupSafe()).toBe(false)
			registry.releaseForTask(owner)
			expect(registry.capturePendingTaskOutput(owner)[0]!.completion).toBe(captured.completion)
			expect(captured.isCleanupSafe()).toBe(false)
			expect(process.outputArtifactId).toBeUndefined()
			// Explicit real-sink closure is independent proof; the failure stays exact.
			sinkClosed = true
			expect(captured.isCleanupSafe()).toBe(true)
			closeObservationFails = true
			expect(captured.isCleanupSafe()).toBe(false)
			expect(await outcome(captured.completion)).toEqual({ status: "rejected", reason: undefined })
		} finally {
			releaseClose.resolve()
			await actual
			await observed
			registry.releaseForTask(owner)
		}
	})

	it("permits late public registration after natural private completion without explicit revocation", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("1000:naturally-completed")
		process.emit("completed", "")
		try {
			track(registry, owner, process, "1000:naturally-completed", "1000")
			const captured = registry.capturePendingTaskOutput(owner)[0]!
			await process.finalizeOutput()
			await captured.completion
			expect(captured.isCleanupSafe()).toBe(true)
			expect(registry.capturePendingTaskOutput(owner)).toHaveLength(0)
			const sessionId = registry.register(owner, process)
			expect(sessionId).toBe(1)
			expect(registry.resolve(owner, sessionId)?.process).toBe(process)
			expect(registry.ownsOutput(process)).toBe(true)
			registry.release(owner, sessionId)
			expect(() => registry.register(owner, process)).toThrow()
			expect(registry.ownsOutput(process)).toBe(false)
		} finally {
			await outcome(process.finalizeOutput())
			registry.releaseForTask(owner)
		}
	})

	it("denies late public registration of a naturally retired execution after Task release", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("1000:retired-before-release")
		const closeEntered = deferred<void>()
		const releaseClose = deferred<void>()
		let sinkClosed = false
		process.setOutputFinalizer(async () => {
			closeEntered.resolve()
			await releaseClose.promise
			sinkClosed = true
		})
		process.emit("completed", "")
		try {
			track(registry, owner, process, "1000:retired-before-release", "1000", () => sinkClosed)
			const captured = registry.capturePendingTaskOutput(owner)[0]!
			const finalizing = process.finalizeOutput()
			await closeEntered.promise
			expect(captured.isCleanupSafe()).toBe(false)
			releaseClose.resolve()
			await finalizing
			await captured.completion
			expect(captured.isCleanupSafe()).toBe(true)
			// Prove the private record has retired before Task-wide release. The
			// revocation must outlive that record without retaining its archive.
			expect(registry.capturePendingTaskOutput(owner)).toHaveLength(0)
			expect(registry.ownsOutput(process)).toBe(false)
			registry.releaseForTask(owner)
			expect(() => registry.register(owner, process)).toThrow()
			expect(registry.ownsOutput(process)).toBe(false)
		} finally {
			releaseClose.resolve()
			await outcome(process.finalizeOutput())
			registry.releaseForTask(owner)
		}
	})

	it("captures the original sink-close capability instead of a replaceable options property", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const process = new OutputProcess("1000:physical-uuid")
		let originalSinkClosed = false
		const archive = { archiveExecutionId: "1000", isClosed: () => originalSinkClosed }
		try {
			registry.trackTaskOutput(owner, process, "1000:physical-uuid", archive)
			const captured = registry.capturePendingTaskOutput(owner)[0]!
			archive.archiveExecutionId = "1001"
			archive.isClosed = () => true
			await process.finalizeOutput()
			await captured.completion
			expect(captured.archiveExecutionId).toBe("1000")
			expect(captured.isCleanupSafe()).toBe(false)
			expect(registry.capturePendingTaskOutput(owner)[0]!.completion).toBe(captured.completion)
			originalSinkClosed = true
			expect(captured.isCleanupSafe()).toBe(true)
		} finally {
			originalSinkClosed = true
			await outcome(process.finalizeOutput())
			registry.releaseForTask(owner)
		}
	})

	it("admits a new physical command on the same Task without resurrecting its released predecessor", async () => {
		const registry = new CommandSessionRegistry()
		const owner = task()
		const original = new OutputProcess("1000:original")
		const replacement = new OutputProcess("1001:later-retained-lifecycle")
		original.emit("completed", "")
		replacement.emit("completed", "")
		try {
			track(registry, owner, original, "1000:original", "1000")
			const originalSession = registry.register(owner, original)
			registry.releaseForTask(owner)
			expect(() => registry.register(owner, original)).toThrow()
			track(registry, owner, replacement, "1001:later-retained-lifecycle", "1001")
			const replacementSession = registry.register(owner, replacement)
			expect(replacementSession).not.toBe(originalSession)
			expect(registry.resolve(owner, replacementSession)?.process).toBe(replacement)
			expect(registry.resolve(owner, originalSession)).toBeUndefined()
			expect(registry.ownsOutput(original)).toBe(false)
			expect(registry.ownsOutput(replacement)).toBe(true)
			await original.finalizeOutput()
			expect(() => registry.register(owner, original)).toThrow()
			expect(registry.ownsOutput(replacement)).toBe(true)
		} finally {
			await Promise.all([outcome(original.finalizeOutput()), outcome(replacement.finalizeOutput())])
			registry.releaseForTask(owner)
		}
	})
})
