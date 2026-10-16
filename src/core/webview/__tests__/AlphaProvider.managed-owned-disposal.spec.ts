import * as fs from "node:fs/promises"
import * as path from "node:path"

import { AlphaCodeEventName } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createManagedPublicLifecycleHarness } from "./managedPublicLifecycleHarness"

import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import { getTaskDirectoryPath } from "../../../utils/storage"
import type { AgentLifecycleJournal } from "../../agent/lifecycle/AgentLifecycleJournal"
import { Task } from "../../task/Task"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type Child = Awaited<ReturnType<Harness["spawnCompletedChild"]>>

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const fixtures: Harness[] = []

afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

async function createFixture() {
	const fixture = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	fixtures.push(fixture)
	return fixture
}

/**
 * Exercise the supported completed-child admission API, independently of provider follow-up.
 * prepareReasoningForAdmission owns the old handler while updateApiConfiguration retires it.
 * No retained-handler set, request lease, or disposal state is seeded by this fixture.
 */
async function retainOldHandlerThroughPublicAdmission(fixture: Harness, child: Child) {
	const old = fixture.handlers.find((handler) => handler === child.task.api)
	expect(old).toBeDefined()
	if (!old) throw new Error("The real child has no registered scripted provider adapter")
	const entered = barrier()
	const release = barrier()
	const previousAdmissions = old.prepareModel.mock.calls.length
	old.prepareModel.mockImplementationOnce(async () => {
		entered.resolve()
		await release.promise
	})
	const admission = child.task.prepareReasoningForAdmission()
	// Observe rejection immediately; the original settlement is asserted after disposal.
	const settlement = Promise.allSettled([admission])
	expect(old.prepareModel).toHaveBeenCalledTimes(previousAdmissions + 1)
	await entered.promise
	const current = fixture.createReplacementHandler("owned-disposal-current")
	child.task.updateApiConfiguration({
		...child.task.apiConfiguration,
		openAiModelId: current.getModel().id,
	})
	expect(child.task.api).toBe(current)
	expect(old.dispose).not.toHaveBeenCalled()
	expect(current.dispose).not.toHaveBeenCalled()
	return { old, current, release, settlement }
}

async function expectLateAdmissionCancelled(
	retained: Awaited<ReturnType<typeof retainOldHandlerThroughPublicAdmission>>,
) {
	retained.release.resolve()
	const [settlement] = await retained.settlement
	expect(settlement.status).toBe("rejected")
	if (settlement.status === "rejected") expect(settlement.reason).toMatchObject({ name: "AbortError" })
	expect(retained.old.dispose).toHaveBeenCalledOnce()
	expect(retained.current.dispose).toHaveBeenCalledOnce()
}

/** Four serial Review children exceed the ordinary three-terminal-runtime retention cap. */
async function finishRetentionPressure(fixture: Harness) {
	for (const label of ["pressure-one", "pressure-two", "pressure-three"]) {
		await fixture.spawnCompletedChild(label)
	}
	// Join the actual finalization owners, without joining a deliberately held residency operation.
	await fixture.settleFinalizations({ includeResidency: false })
}

async function createRetainedArtifact(fixture: Harness, child: Child) {
	const taskDirectory = await getTaskDirectoryPath(fixture.storagePath, child.taskId)
	const directory = path.join(taskDirectory, "command-output")
	const artifact = path.join(directory, "cmd-13901.txt")
	const contents = "Retained output fixture referenced by the durable child transcript.\n"
	await fs.mkdir(directory, { recursive: true })
	await fs.writeFile(artifact, contents, "utf8")
	await child.task.say("command_output", "Artifact ID: cmd-13901.txt", undefined, false, undefined, undefined, {
		isNonInteractive: true,
		commandExecutionId: "13901",
	})
	return { directory, artifact, contents }
}

async function observeChildJournal(fixture: Harness, child: Child) {
	const journals = Reflect.get(fixture.provider, "agentLifecycleJournals") as Map<
		string,
		Promise<AgentLifecycleJournal>
	>
	const pending = journals.get(child.taskId)
	expect(pending).toBeDefined()
	if (!pending) throw new Error("The real child did not create its lifecycle journal")
	return { journals, close: vi.spyOn(await pending, "close") }
}

async function expectDurableCompletion(fixture: Harness, child: Child, summary: string) {
	const { historyItem } = await fixture.provider.getTaskWithId(child.taskId, { includeApiConversationHistory: false })
	expect(historyItem).toMatchObject({ id: child.taskId, status: "completed", completionResultSummary: summary })
	expect(
		fixture.root.clineMessages.some((message) =>
			message.subagentGroup?.agents.some((agent) => agent.taskId === child.taskId && agent.summary === summary),
		),
	).toBe(true)
}

describe("AlphaProvider automatic owned Task disposal with WS01 handler ownership", () => {
	it("joins owned persistence before automatic disposal and keeps later public controls idempotent", async () => {
		const fixture = await createFixture()
		const child = await fixture.spawnCompletedChild("owned-disposal-target")
		expect(child.task).toBeInstanceOf(Task)
		const terminal = structuredClone(fixture.store.getAgent(child.taskId)?.terminalResult)
		expect(terminal?.summary).toBe(child.turn.summary)
		const retained = await retainOldHandlerThroughPublicAdmission(fixture, child)
		const artifact = await createRetainedArtifact(fixture, child)
		const cleanupArtifact = vi.spyOn(OutputInterceptor, "cleanup")
		const cleanupOwnedArtifacts = vi.spyOn(OutputInterceptor, "cleanupByIds")
		const journal = await observeChildJournal(fixture, child)
		const disposal = vi.spyOn(child.task, "dispose")
		const aborted = vi.fn()
		child.task.on(AlphaCodeEventName.TaskAborted, aborted)
		const termination = barrier()
		const goal = barrier()
		const api = barrier()
		const apiEntered = barrier()
		const apiSettled = barrier()
		const ui = barrier()
		const cleanupEntered = barrier()
		// Extend existing owned promises; each original join/persistence operation still runs.
		const originalTermination = child.task.waitForTermination()
		await originalTermination
		Reflect.set(
			child.task,
			"taskTerminationPromise",
			originalTermination.then(() => termination.promise),
		)
		const originalGoal = Reflect.get(child.task, "goalShutdownPromise") as Promise<void> | undefined
		Reflect.set(
			child.task,
			"goalShutdownPromise",
			Promise.resolve(originalGoal).then(() => goal.promise),
		)
		const originalUi = Reflect.get(child.task, "alphaMessagesSaveQueue") as Promise<void>
		Reflect.set(
			child.task,
			"alphaMessagesSaveQueue",
			originalUi.then(() => ui.promise),
		)
		const nativeWait = child.task.waitForTermination.bind(child.task)
		const wait = vi.spyOn(child.task, "waitForTermination").mockImplementation(() => {
			cleanupEntered.resolve()
			return nativeWait()
		})
		const flush = child.task.flushApiConversationHistoryPersistence.bind(child.task)
		vi.spyOn(child.task, "flushApiConversationHistoryPersistence").mockImplementation(async () => {
			apiEntered.resolve()
			await api.promise
			await flush()
			apiSettled.resolve()
		})
		let closeSettled = false
		let closing: Promise<unknown> | undefined
		let closingSettlement: Promise<PromiseSettledResult<unknown>[]> | undefined
		let queueObservation: Promise<void> | undefined
		try {
			await finishRetentionPressure(fixture)
			// Existing identity ownership is a passive queue fence, not another admission or a prune call.
			// Finalization schedules automatic cleanup before its waiter resumes; reaching target termination
			// requires only Promise/ownership yields. Real persistence is joined after this behavioral oracle.
			queueObservation = fixture.taskSessions.runOwnershipOperation(child.taskId, async () => undefined)
			await Promise.race([
				cleanupEntered.promise.then(() => "cleanup"),
				queueObservation.then(() => "ownership-queue"),
			])
			// Behavioral RED uses an existing method: baseline retains the old Task and never starts its cleanup.
			// Assert before waiting on any candidate-only gate, so baseline cannot hang or fail for a missing API.
			expect(wait).toHaveBeenCalledOnce()
			expect(fixture.provider.getLiveTask(child.taskId)).toBe(child.task)
			expect(fixture.taskSessions.getTask(child.taskId)).toBe(child.task)
			expect(disposal).not.toHaveBeenCalled()
			expect(retained.old.dispose).not.toHaveBeenCalled()
			expect(retained.current.dispose).not.toHaveBeenCalled()
			closing = fixture.provider.closeAgent(fixture.root, child.path).then((value) => {
				closeSettled = true
				return value
			})
			closingSettlement = Promise.allSettled([closing])
			termination.resolve()
			await originalTermination
			expect(closeSettled).toBe(false)
			expect(fixture.provider.getLiveTask(child.taskId)).toBe(child.task)
			expect(disposal).not.toHaveBeenCalled()
			goal.resolve()
			await apiEntered.promise
			expect(closeSettled).toBe(false)
			expect(fixture.taskSessions.getTask(child.taskId)).toBe(child.task)
			expect(disposal).not.toHaveBeenCalled()
			api.resolve()
			await apiSettled.promise
			expect(fixture.provider.getLiveTask(child.taskId)).toBe(child.task)
			expect(disposal).not.toHaveBeenCalled()
			expect(journal.close).not.toHaveBeenCalled()
			ui.resolve()
			await fixture.settleFinalizations({ includeResidency: true })
			await expect(closing).resolves.toMatchObject({ taskId: child.taskId, status: "completed" })
			expect(fixture.provider.getLiveTask(child.taskId)).toBeUndefined()
			expect(fixture.taskSessions.getTask(child.taskId)).toBeUndefined()
			expect(disposal.mock.calls).toEqual([[{ preserveCommandOutputArtifacts: true }]])
			expect(journal.close).toHaveBeenCalledOnce()
			expect(journal.journals.has(child.taskId)).toBe(false)
			expect(child.task.eventNames()).toEqual([])
			expect(aborted).not.toHaveBeenCalled()
			await expectLateAdmissionCancelled(retained)
			await expectDurableCompletion(fixture, child, child.turn.summary)
			await fixture.provider.cancelTask(child.taskId)
			await fixture.provider.cancelTask(child.taskId)
			await fixture.provider.closeTask(child.taskId)
			await fixture.provider.closeTask(child.taskId)
			await fixture.provider.dispose()
			await fixture.provider.dispose()
			expect(disposal).toHaveBeenCalledOnce()
			expect(retained.old.dispose).toHaveBeenCalledOnce()
			expect(retained.current.dispose).toHaveBeenCalledOnce()
			expect(journal.close).toHaveBeenCalledOnce()
			expect(aborted).not.toHaveBeenCalled()
			expect(cleanupArtifact.mock.calls.filter(([directory]) => directory === artifact.directory)).toEqual([])
			expect(cleanupOwnedArtifacts.mock.calls.filter(([directory]) => directory === artifact.directory)).toEqual(
				[],
			)
			expect(await fs.readFile(artifact.artifact, "utf8")).toBe(artifact.contents)
		} finally {
			termination.resolve()
			goal.resolve()
			api.resolve()
			ui.resolve()
			retained.release.resolve()
			await queueObservation
			if (closingSettlement) {
				const [settlement] = await closingSettlement
				expect(settlement.status).toBe("fulfilled")
			}
			const [settlement] = await retained.settlement
			if (child.task.getTaskLifetimeCancellationSignal().aborted) {
				expect(settlement.status).toBe("rejected")
				if (settlement.status === "rejected") expect(settlement.reason).toMatchObject({ name: "AbortError" })
			} else expect(settlement.status).toBe("fulfilled")
		}
	})

	it("keeps failed automatic disposal owned until public close retries each handler once", async () => {
		const fixture = await createFixture()
		const child = await fixture.spawnCompletedChild("failed-owned-disposal-target")
		expect(child.task).toBeInstanceOf(Task)
		const terminal = structuredClone(fixture.store.getAgent(child.taskId)?.terminalResult)
		expect(terminal?.summary).toBe(child.turn.summary)
		const retained = await retainOldHandlerThroughPublicAdmission(fixture, child)
		const artifact = await createRetainedArtifact(fixture, child)
		const cleanupArtifact = vi.spyOn(OutputInterceptor, "cleanup")
		const cleanupOwnedArtifacts = vi.spyOn(OutputInterceptor, "cleanupByIds")
		const journal = await observeChildJournal(fixture, child)
		const disposal = vi.spyOn(child.task, "dispose")
		const aborted = vi.fn()
		child.task.on(AlphaCodeEventName.TaskAborted, aborted)
		const failure = new Error("Owned provider adapter disposal failed once")
		const cleanupEntered = barrier()
		const disposalEntered = barrier()
		const nativeWait = child.task.waitForTermination.bind(child.task)
		const wait = vi.spyOn(child.task, "waitForTermination").mockImplementation(() => {
			cleanupEntered.resolve()
			return nativeWait()
		})
		retained.old.dispose.mockImplementationOnce(() => {
			disposalEntered.resolve()
			throw failure
		})
		let queueObservation: Promise<void> | undefined
		try {
			await finishRetentionPressure(fixture)
			queueObservation = fixture.taskSessions.runOwnershipOperation(child.taskId, async () => undefined)
			await Promise.race([
				cleanupEntered.promise.then(() => "cleanup"),
				queueObservation.then(() => "ownership-queue"),
			])
			// Baseline has the same existing method and queue, but never starts automatic cleanup.
			expect(wait).toHaveBeenCalledOnce()
			// Actual API/UI/canonical persistence may perform native I/O before dispose; join its entry explicitly.
			await disposalEntered.promise
			expect(disposal).toHaveBeenCalledOnce()
			const evictions = Reflect.get(fixture.provider, "subagentResidencyEvictions") as Map<
				string,
				Promise<unknown>
			>
			const eviction = evictions.get(child.taskId)
			expect(eviction).toBeDefined()
			if (!eviction) throw new Error("Failed automatic cleanup lost its pinned ownership operation")
			const [settlement] = await Promise.allSettled([eviction])
			expect(settlement).toEqual({ status: "rejected", reason: failure })
			expect(retained.old.dispose).toHaveBeenCalledOnce()
			expect(retained.current.dispose).not.toHaveBeenCalled()
			expect(journal.close).not.toHaveBeenCalled()
			expect(journal.journals.has(child.taskId)).toBe(true)
			expect(fixture.provider.getLiveTask(child.taskId)).toBe(child.task)
			expect(fixture.taskSessions.getTask(child.taskId)).toBe(child.task)
			expect(fixture.store.getAgent(child.taskId)?.terminalResult).toEqual(terminal)
			await expect(fixture.provider.listAgents(fixture.root)).resolves.toMatchObject({
				agents: expect.arrayContaining([
					expect.objectContaining({ taskId: child.taskId, path: child.path, status: "completed" }),
				]),
			})
			await expect(fixture.provider.closeAgent(fixture.root, child.path)).resolves.toMatchObject({
				taskId: child.taskId,
				status: "completed",
			})
			expect(fixture.provider.getLiveTask(child.taskId)).toBeUndefined()
			expect(fixture.taskSessions.getTask(child.taskId)).toBeUndefined()
			expect(evictions.has(child.taskId)).toBe(false)
			expect(disposal).toHaveBeenCalledTimes(2)
			expect(retained.old.dispose).toHaveBeenCalledOnce()
			expect(retained.current.dispose).toHaveBeenCalledOnce()
			expect(child.task.eventNames()).toEqual([])
			expect(aborted).not.toHaveBeenCalled()
			await expectLateAdmissionCancelled(retained)
			await expectDurableCompletion(fixture, child, child.turn.summary)
			await fixture.provider.cancelTask(child.taskId)
			await fixture.provider.cancelTask(child.taskId)
			await fixture.provider.closeTask(child.taskId)
			await fixture.provider.closeTask(child.taskId)
			await fixture.provider.dispose()
			await fixture.provider.dispose()
			expect(disposal).toHaveBeenCalledTimes(2)
			expect(retained.old.dispose).toHaveBeenCalledOnce()
			expect(retained.current.dispose).toHaveBeenCalledOnce()
			expect(journal.close).toHaveBeenCalledOnce()
			expect(aborted).not.toHaveBeenCalled()
			expect(cleanupArtifact.mock.calls.filter(([directory]) => directory === artifact.directory)).toEqual([])
			expect(cleanupOwnedArtifacts.mock.calls.filter(([directory]) => directory === artifact.directory)).toEqual(
				[],
			)
			expect(await fs.readFile(artifact.artifact, "utf8")).toBe(artifact.contents)
		} finally {
			// A baseline assertion can end the case before the automatic fault is ever reached.
			// Remove only that unused adapter fault so teardown cannot replace the behavioral RED.
			if (disposal.mock.calls.length === 0) retained.old.dispose.mockReset()
			retained.release.resolve()
			await queueObservation
			const [settlement] = await retained.settlement
			if (child.task.getTaskLifetimeCancellationSignal().aborted) {
				expect(settlement.status).toBe("rejected")
				if (settlement.status === "rejected") expect(settlement.reason).toMatchObject({ name: "AbortError" })
			} else expect(settlement.status).toBe("fulfilled")
		}
	})
})
