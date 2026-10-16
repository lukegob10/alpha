import { createManagedPublicLifecycleHarness, deferred } from "../../webview/__tests__/managedPublicLifecycleHarness"

import { AlphaCodeEventName } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import {
	createTaskSessionApprovalKey,
	grantTaskSessionApproval,
	hasTaskSessionApproval,
} from "../../auto-approval/taskSessionApprovalGrants"
import { readApiMessages, readTaskMessages } from "../../task-persistence"
import { Task } from "../Task"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type Child = Awaited<ReturnType<Harness["spawnCompletedChild"]>>
const fixtures: Harness[] = []
const releases: Array<() => void> = []
const restorations: Array<() => void> = []
const detached: Task[] = []
const pending: Promise<unknown>[] = []

afterEach(async () => {
	for (const release of releases.splice(0)) release()
	await Promise.allSettled(pending.splice(0))
	for (const restore of restorations.splice(0).reverse()) restore()
	vi.restoreAllMocks()
	for (const task of detached.splice(0)) {
		task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
		await task.waitForTermination()
		await task.messageQueueService.flush()
	}
	for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

async function completed(label: string) {
	const fixture = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	fixtures.push(fixture)
	const child = await fixture.spawnCompletedChild(label)
	expect(child.task).toBeInstanceOf(Task)
	expect(child.result?.status).toBe("completed")
	return { fixture, child }
}

function replaceField(task: Task, name: string, descriptor: PropertyDescriptor) {
	const previous = Object.getOwnPropertyDescriptor(task, name)
	Object.defineProperty(task, name, { configurable: true, ...descriptor })
	restorations.push(() => {
		if (previous) Object.defineProperty(task, name, previous)
		else Reflect.deleteProperty(task, name)
	})
}

/** The constructor/loop/ownership guard/dispose remain production code. Only A's join is controlled. */
function holdBoundary(task: Task, boundary: "termination" | "canonical" | "api" | "alpha") {
	const entered = deferred()
	const release = deferred()
	releases.push(release.resolve)
	if (boundary === "termination") {
		replaceField(task, "taskTerminationPromise", { value: release.promise, writable: true })
		entered.resolve()
	} else if (boundary === "api") {
		const flush = task.flushApiConversationHistoryPersistence
		vi.spyOn(task, "flushApiConversationHistoryPersistence").mockImplementation(async (...args) => {
			entered.resolve()
			await release.promise
			await Reflect.apply(flush, task, args)
		})
	} else {
		const field = boundary === "canonical" ? "canonicalLifecycleQueue" : "alphaMessagesSaveQueue"
		replaceField(task, field, {
			get: () => {
				entered.resolve()
				return release.promise
			},
		})
	}
	return { entered: entered.promise, release: release.resolve }
}

/** Controlled B fields model an admitted same-object step; there is no fake ownership predicate. */
function installSameInstanceB(fixture: Harness, task: Task) {
	const controller = new AbortController()
	const handler = fixture.createReplacementHandler(`ws08-unload-replacement-${task.taskId}`)
	task.updateApiConfiguration({ ...task.apiConfiguration, openAiModelId: handler.getModel().id })
	const oldStep = Reflect.get(task, "currentAgentStep")
	for (const [field, value] of Object.entries({
		currentAgentStep: {
			...oldStep,
			turnId: "B-turn",
			stepId: "B-step",
			requestId: "B-request",
			attemptId: "B-attempt",
		},
		agentRunId: "B-run",
		agentTurnId: "B-turn",
		taskCancellationController: controller,
		abort: false,
		abandoned: false,
	}))
		replaceField(task, field, { value, writable: true })
	const reads: string[] = []
	const settledReplacementQueue = Promise.resolve()
	for (const field of [
		"ownedLifecyclePromise",
		"canonicalLifecycleQueue",
		"alphaMessagesSaveQueue",
		"goalShutdownPromise",
	]) {
		replaceField(task, field, {
			get: () => {
				reads.push(field)
				return settledReplacementQueue
			},
		})
	}
	return { controller, handler, reads }
}

function startUnload(task: Task) {
	const operation = task.unloadSubagentRuntime()
	const settlement = Promise.allSettled([operation])
	pending.push(settlement)
	return { operation, settlement }
}

function replacementTask(fixture: Harness, child: Child) {
	const handler = fixture.createReplacementHandler(`ws08-distinct-replacement-${child.taskId}`)
	const task = new Task({
		provider: fixture.provider,
		apiConfiguration: { ...child.task.apiConfiguration, openAiModelId: handler.getModel().id },
		taskId: child.taskId,
		task: "Construct an idle replacement owner without starting a loop.",
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

describe("managed unload uses its originating native owner", () => {
	it("runs the real public unload/dispose path for an unchanged stopped child and preserves its terminal transcript", async () => {
		const { fixture, child } = await completed("unchanged-unload-owner")
		const task = child.task
		const beforeApi = await readApiMessages({ taskId: child.taskId, globalStoragePath: fixture.storagePath })
		const beforeUi = await readTaskMessages({ taskId: child.taskId, globalStoragePath: fixture.storagePath })
		const handler = fixture.handlers.find((value) => value === task.api)
		if (!handler) throw new Error("Actual completed Task has no scripted provider adapter")
		const dispose = vi.spyOn(task, "dispose")
		const aborted = vi.fn()
		task.on(AlphaCodeEventName.TaskAborted, aborted)
		const boundary = holdBoundary(task, "canonical")
		expect(task.canUnloadSubagentRuntime()).toBe(true)
		const unload = startUnload(task)
		await boundary.entered
		expect(dispose).not.toHaveBeenCalled()
		expect(handler.dispose).not.toHaveBeenCalled()
		boundary.release()
		await expect(unload.operation).resolves.toBeUndefined()
		expect(dispose).toHaveBeenCalledExactlyOnceWith({ preserveCommandOutputArtifacts: true })
		expect(handler.dispose).toHaveBeenCalledOnce()
		expect(task.getTaskLifetimeCancellationSignal().aborted).toBe(true)
		expect(aborted).not.toHaveBeenCalled()
		expect(task.eventNames()).toEqual([])
		expect(await readApiMessages({ taskId: child.taskId, globalStoragePath: fixture.storagePath })).toEqual(
			beforeApi,
		)
		expect(await readTaskMessages({ taskId: child.taskId, globalStoragePath: fixture.storagePath })).toEqual(
			beforeUi,
		)
	})

	it.each(["termination", "canonical", "api", "alpha"] as const)(
		"does not read or dispose same-instance B after A's %s join",
		async (phase) => {
			const { fixture, child } = await completed(`same-instance-${phase}`)
			const task = child.task
			const dispose = vi.spyOn(task, "dispose")
			const boundary = holdBoundary(task, phase)
			const unload = startUnload(task)
			await boundary.entered
			const replacement = installSameInstanceB(fixture, task)
			boundary.release()
			const [result] = await unload.settlement
			// First behavioral oracle: a completed old join cannot adopt any B queue or goal.
			expect(replacement.reads).toEqual([])
			expect(result.status).toBe("rejected")
			if (result.status === "rejected")
				expect(result.reason).toMatchObject({ message: expect.stringContaining("ownership changed") })
			expect(dispose).not.toHaveBeenCalled()
			expect(replacement.handler.dispose).not.toHaveBeenCalled()
			expect(replacement.controller.signal.aborted).toBe(false)
			expect(task.abort).toBe(false)
			expect(task.abandoned).toBe(false)
		},
	)

	it("does not adopt B lifecycle or goal when A had no cancellation termination receipt", async () => {
		const { fixture, child } = await completed("owned-loop-no-cancel-receipt")
		const task = child.task
		const lifecycle = deferred()
		releases.push(lifecycle.resolve)
		replaceField(task, "taskTerminationPromise", { value: undefined, writable: true })
		replaceField(task, "ownedLifecyclePromise", { value: lifecycle.promise, writable: true })
		replaceField(task, "goalShutdownPromise", { value: Promise.resolve(), writable: true })
		const dispose = vi.spyOn(task, "dispose")
		const unload = startUnload(task)
		const replacement = installSameInstanceB(fixture, task)
		lifecycle.resolve()
		const [result] = await unload.settlement
		expect(replacement.reads).toEqual([])
		expect(result.status).toBe("rejected")
		expect(dispose).not.toHaveBeenCalled()
		expect(replacement.handler.dispose).not.toHaveBeenCalled()
		expect(replacement.controller.signal.aborted).toBe(false)
	})

	it("rejects stale transcript-owner eligibility before scanning task-ID terminal resources", async () => {
		const { fixture, child } = await completed("stale-eligibility")
		const replacement = replacementTask(fixture, child)
		expect(replacement.task).not.toBe(child.task)
		expect(replacement.task.taskId).toBe(child.taskId)
		const scan = vi.spyOn(TerminalRegistry, "getTerminals")
		expect(child.task.canUnloadSubagentRuntime()).toBe(false)
		expect(scan).not.toHaveBeenCalled()
	})

	it("releases old local services with both preservation flags after a real different-instance owner claims the ID", async () => {
		const { fixture, child } = await completed("different-instance-handoff")
		const boundary = holdBoundary(child.task, "termination")
		const originalHandler = fixture.handlers.find((value) => value === child.task.api)
		if (!originalHandler) throw new Error("Actual old Task has no scripted provider adapter")
		const dispose = vi.spyOn(child.task, "dispose")
		const unload = startUnload(child.task)
		const replacement = replacementTask(fixture, child)
		const key = createTaskSessionApprovalKey({
			taskId: replacement.task.taskId,
			toolName: "execute_command",
			askType: "command",
			description: "Owned replacement command",
			argumentsValue: { command: "git status --short" },
			cwd: replacement.task.cwd,
		})
		if (!key) throw new Error("Replacement approval fixture did not produce an exact request key")
		expect(
			grantTaskSessionApproval(
				key,
				replacement.task.taskId,
				replacement.task.getTaskLifetimeCancellationSignal(),
			),
		).toBe(true)
		const releaseShared = vi.spyOn(TerminalRegistry, "releaseTerminalsForTask")
		boundary.release()
		const [result] = await unload.settlement
		// Observe actual shared approval state, rather than only asserting the dispose arguments.
		expect(hasTaskSessionApproval(key)).toBe(true)
		expect(releaseShared).not.toHaveBeenCalledWith(replacement.task.taskId)
		expect(result.status).toBe("rejected")
		expect(dispose).toHaveBeenCalledExactlyOnceWith({
			preserveSharedTaskResources: true,
			preserveCommandOutputArtifacts: true,
		})
		expect(originalHandler.dispose).toHaveBeenCalledOnce()
		expect(replacement.handler.dispose).not.toHaveBeenCalled()
		expect(replacement.task.getTaskLifetimeCancellationSignal().aborted).toBe(false)
	})

	it("keeps public promise coalescing and permits retry after an owned persistence failure", async () => {
		const { child } = await completed("owned-unload-retry")
		const boundary = holdBoundary(child.task, "termination")
		const dispose = vi.spyOn(child.task, "dispose")
		const flush = child.task.flushApiConversationHistoryPersistence
		const failure = new Error("controlled owned persistence failure")
		vi.spyOn(child.task, "flushApiConversationHistoryPersistence").mockRejectedValueOnce(failure)
		const unload = startUnload(child.task)
		expect(child.task.unloadSubagentRuntime()).toBe(unload.operation)
		boundary.release()
		expect((await unload.settlement)[0]).toEqual({ status: "rejected", reason: failure })
		expect(dispose).not.toHaveBeenCalled()
		vi.spyOn(child.task, "flushApiConversationHistoryPersistence").mockImplementation((...args) =>
			Reflect.apply(flush, child.task, args),
		)
		await expect(child.task.unloadSubagentRuntime()).resolves.toBeUndefined()
		expect(dispose).toHaveBeenCalledOnce()
	})
})
