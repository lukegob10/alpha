import { createManagedPublicLifecycleHarness, deferred } from "../../webview/__tests__/managedPublicLifecycleHarness"

import { afterEach, describe, expect, it, vi } from "vitest"

import { BaseTerminalProcess } from "../../../integrations/terminal/BaseTerminalProcess"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { commandSessionRegistry } from "../../tools/CommandSessionRegistry"
import { Task } from "../Task"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type Child = Awaited<ReturnType<Harness["spawnCompletedChild"]>>
const fixtures: Harness[] = []
const releases: Array<() => void> = []
const finalizations: Promise<unknown>[] = []
const restorations: Array<() => void> = []
const detached: Task[] = []

afterEach(async () => {
	for (const release of releases.splice(0)) release()
	await Promise.allSettled(finalizations.splice(0))
	for (const restore of restorations.splice(0).reverse()) restore()
	vi.restoreAllMocks()
	for (const task of detached.splice(0)) {
		task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
		await task.waitForTermination()
	}
	for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

/** No shell is launched. Native passive finalization and registry ownership remain production code. */
class DetachedOutputProcess extends BaseTerminalProcess {
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

async function completed(label: string) {
	const fixture = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	fixtures.push(fixture)
	const child = await fixture.spawnCompletedChild(label)
	expect(child.task).toBeInstanceOf(Task)
	expect(child.result?.status).toBe("completed")
	return { fixture, child }
}

async function bindDetachedOutput(task: Task, label: string, knownArchive: boolean) {
	const process = new DetachedOutputProcess(`${task.taskId}:${label}:physical`)
	const entered = deferred()
	const release = deferred()
	releases.push(release.resolve)
	let closed = false
	const finalizer = vi.fn(async () => {
		entered.resolve()
		await release.promise
		closed = true
	})
	process.setOutputFinalizer(finalizer)
	if (knownArchive) {
		commandSessionRegistry.trackTaskOutput(task, process, process.executionId!, {
			archiveExecutionId: "1000",
			isClosed: () => closed,
		})
	} else {
		// The legacy public bridge has a genuine passive barrier but no archive identity.
		commandSessionRegistry.register(task, process)
	}
	process.emit("completed", "")
	const finalization = process.finalizeOutput()
	finalizations.push(finalization)
	await entered.promise
	const [original] = commandSessionRegistry.capturePendingTaskOutput(task)
	if (!original) throw new Error("The original Task output snapshot lost its detached finalization")
	expect(original.process).toBe(process)
	expect(original.executionId).toBe(process.executionId)
	expect(process.isSettled).toBe(true)
	expect(process.hasUnretrievedOutput()).toBe(false)
	expect(process.hasActiveOutputReceipt()).toBe(false)
	expect(Reflect.get(task, "terminalProcess")).not.toBe(process)
	expect(
		[
			...TerminalRegistry.getTerminals(true, task.taskId),
			...TerminalRegistry.getTerminals(false, task.taskId),
		].some((terminal) => terminal.process === process || terminal.getProcessesWithOutput?.().includes(process)),
	).toBe(false)
	return {
		process,
		original,
		finalizer,
		closed: () => closed,
		finish: async () => {
			release.resolve()
			await finalization
			await original.completion
		},
	}
}

function replacementTask(fixture: Harness, child: Child) {
	const handler = fixture.createReplacementHandler(`detached-output-replacement-${child.taskId}`)
	const task = new Task({
		provider: fixture.provider,
		apiConfiguration: { ...child.task.apiConfiguration, openAiModelId: handler.getModel().id },
		taskId: child.taskId,
		task: "Create a stopped exact-ID replacement without starting a loop.",
		startTask: false,
		taskMode: "code",
		taskKind: "subagent",
		subagentRole: "review",
		initialStatus: "completed",
		workspacePath: child.task.cwd,
		enableCheckpoints: false,
		rootTask: fixture.root,
		parentTask: fixture.root,
	})
	detached.push(task)
	return { task, handler }
}

function replaceField(task: Task, name: string, descriptor: PropertyDescriptor) {
	const previous = Object.getOwnPropertyDescriptor(task, name)
	Object.defineProperty(task, name, { configurable: true, ...descriptor })
	restorations.push(() => {
		if (previous) Object.defineProperty(task, name, previous)
		else Reflect.deleteProperty(task, name)
	})
}

describe("managed public unload respects detached original output ownership", () => {
	it("rejects unload while a detached archive is pending, then disposes only after its natural finalizer closes", async () => {
		const { fixture, child } = await completed("detached-pending-archive")
		const output = await bindDetachedOutput(child.task, "pending", true)
		const dispose = vi.spyOn(child.task, "dispose")
		const handler = fixture.handlers.find((value) => value === child.task.api)
		if (!handler) throw new Error("Actual child has no scripted provider adapter")
		expect(output.original.isCleanupSafe()).toBe(false)
		const eligible = child.task.canUnloadSubagentRuntime()
		const [result] = await Promise.allSettled([child.task.unloadSubagentRuntime()])
		// The baseline has already traversed actual public unload before this first assertion.
		expect(eligible).toBe(false)
		expect(result.status).toBe("rejected")
		expect(dispose).not.toHaveBeenCalled()
		expect(handler.dispose).not.toHaveBeenCalled()
		expect(output.closed()).toBe(false)
		expect(output.process.abort).not.toHaveBeenCalled()
		await output.finish()
		expect(output.original.isCleanupSafe()).toBe(true)
		expect(child.task.canUnloadSubagentRuntime()).toBe(true)
		await expect(child.task.unloadSubagentRuntime()).resolves.toBeUndefined()
		expect(dispose).toHaveBeenCalledExactlyOnceWith({ preserveCommandOutputArtifacts: true })
		expect(handler.dispose).toHaveBeenCalledOnce()
		expect(output.finalizer).toHaveBeenCalledOnce()
	})

	it("keeps an unknown legacy archive unsafe after genuine output completion and empty terminal/output queues", async () => {
		const { child } = await completed("detached-unknown-archive")
		const output = await bindDetachedOutput(child.task, "unknown", false)
		await output.finish()
		expect(output.process.isOutputFinalized).toBe(true)
		expect(output.original.archiveExecutionId).toBeUndefined()
		expect(output.original.isCleanupSafe()).toBe(false)
		expect(commandSessionRegistry.capturePendingTaskOutput(child.task)).toContain(output.original)
		const dispose = vi.spyOn(child.task, "dispose")
		const eligible = child.task.canUnloadSubagentRuntime()
		const [result] = await Promise.allSettled([child.task.unloadSubagentRuntime()])
		expect(eligible).toBe(false)
		expect(result.status).toBe("rejected")
		expect(dispose).not.toHaveBeenCalled()
		expect(child.task.abort).toBe(false)
		expect(child.task.abandoned).toBe(false)
	})

	it("does not charge original A's pending archive to a real same-task-ID replacement B", async () => {
		const { fixture, child } = await completed("detached-original-task-isolation")
		const output = await bindDetachedOutput(child.task, "original-owner", true)
		const oldDispose = vi.spyOn(child.task, "dispose")
		const replacement = replacementTask(fixture, child)
		expect(replacement.task).not.toBe(child.task)
		expect(replacement.task.taskId).toBe(child.taskId)
		expect(commandSessionRegistry.capturePendingTaskOutput(replacement.task)).toEqual([])
		const eligible = replacement.task.canUnloadSubagentRuntime()
		const result = await Promise.allSettled([replacement.task.unloadSubagentRuntime()])
		expect(eligible).toBe(true)
		expect(result).toEqual([{ status: "fulfilled", value: undefined }])
		expect(replacement.handler.dispose).toHaveBeenCalledOnce()
		expect(oldDispose).not.toHaveBeenCalled()
		expect(commandSessionRegistry.capturePendingTaskOutput(child.task)).toContain(output.original)
		expect(output.original.isCleanupSafe()).toBe(false)
		expect(output.closed()).toBe(false)
		expect(output.process.abort).not.toHaveBeenCalled()
		await output.finish()
	})

	it.each(["initial", "final"] as const)(
		"checks native ownership after the %s eligibility callback before reading any B join",
		async (phase) => {
			const { fixture, child } = await completed(`eligibility-reentry-${phase}`)
			const task = child.task
			const lookup = TerminalRegistry.getTerminals.bind(TerminalRegistry)
			const handler = fixture.createReplacementHandler(`eligibility-B-${child.taskId}`)
			const lifetime = new AbortController()
			const reads: string[] = []
			const settledB = Promise.resolve()
			const dispose = vi.spyOn(task, "dispose")
			let scans = 0
			let installed = false
			vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((busy, taskId) => {
				if (busy && taskId === task.taskId && ++scans === (phase === "initial" ? 1 : 2)) {
					installed = true
					task.updateApiConfiguration({ ...task.apiConfiguration, openAiModelId: handler.getModel().id })
					for (const [name, value] of Object.entries({
						currentAgentStep: {
							turnId: "B-turn",
							stepId: "B-step",
							requestId: "B-request",
							attemptId: "B-attempt",
						},
						agentRunId: "B-run",
						agentTurnId: "B-turn",
						taskCancellationController: lifetime,
						abort: false,
						abandoned: false,
					}))
						replaceField(task, name, { value, writable: true })
					for (const name of [
						"taskTerminationPromise",
						"ownedLifecyclePromise",
						"canonicalLifecycleQueue",
						"alphaMessagesSaveQueue",
						"goalShutdownPromise",
					]) {
						replaceField(task, name, {
							get: () => {
								reads.push(name)
								return settledB
							},
						})
					}
				}
				return lookup(busy, taskId)
			})
			const [result] = await Promise.allSettled([task.unloadSubagentRuntime()])
			expect(installed).toBe(true)
			expect(reads).toEqual([])
			expect(result.status).toBe("rejected")
			expect(dispose).not.toHaveBeenCalled()
			expect(handler.dispose).not.toHaveBeenCalled()
			expect(lifetime.signal.aborted).toBe(false)
			expect(task.abort).toBe(false)
			expect(task.abandoned).toBe(false)
		},
	)
})
