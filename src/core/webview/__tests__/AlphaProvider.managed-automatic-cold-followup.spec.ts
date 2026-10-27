import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"

import { AlphaCodeEventName, subagentSpawnHandleSchema } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProviderTranscriptStore, readApiMessages, readTaskMessages, type ApiMessage } from "../../task-persistence"
import { Task } from "../../task/Task"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type Child = Awaited<ReturnType<Harness["spawnCompletedChild"]>>
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

function waitCall(id: string, target: string) {
	return {
		type: "tool_call" as const,
		id,
		name: "wait_agent",
		arguments: JSON.stringify({ target, until_terminal: true, timeout_ms: 10_000 }),
	}
}

function toolResults(messages: readonly ApiMessage[], toolUseId: string) {
	return messages.flatMap((message) =>
		message.role === "user" && Array.isArray(message.content)
			? message.content.filter((block) => block.type === "tool_result" && block.tool_use_id === toolUseId)
			: [],
	)
}

function waitReceipt(messages: readonly ApiMessage[], toolUseId: string) {
	const results = toolResults(messages, toolUseId)
	expect(results).toHaveLength(1)
	const result = results[0]
	if (result.type !== "tool_result") throw new Error("Expected the actual native wait result")
	expect(result.is_error).not.toBe(true)
	const texts =
		typeof result.content === "string"
			? [result.content]
			: (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
	const receipts = texts.map((text) => JSON.parse(text) as { source: string; claimId: string; eventCount: number })
	const receipt = receipts.find((value) => value.source === "managed_agent_mailbox")
	expect(receipt).toMatchObject({ source: "managed_agent_mailbox", eventCount: 1 })
	if (!receipt) throw new Error("The actual native wait did not retain its mailbox receipt")
	return receipt
}

function resultMail(fixture: Harness, taskId: string) {
	return fixture.store
		.readMailbox(fixture.root.taskId, {
			rootTaskId: fixture.root.taskId,
			afterSequence: 0,
			includeDelivered: true,
			kinds: ["result"],
			limit: 100,
		})
		.entries.filter((entry) => entry.payload?.taskId === taskId)
}

function rootBudgetUsage(fixture: Harness): { tokens: number; cost: number } {
	// Read the existing budget owner's calculation; this observation neither
	// admits work nor changes any budget, run, reservation or cleanup state.
	const read = Reflect.get(fixture.provider, "getSubagentRootUsage") as (rootTaskId: string) => {
		tokens: number
		cost: number
	}
	return read.call(fixture.provider, fixture.root.taskId)
}

function holdOwnedTermination(child: Child) {
	const release = deferred()
	const entered = deferred()
	const original = child.task.waitForTermination.bind(child.task)
	const wait = vi.spyOn(child.task, "waitForTermination").mockImplementation(async () => {
		entered.resolve()
		await release.promise
		await original()
	})
	return { taskId: child.taskId, release, entered, wait, sentinel: undefined as Promise<void> | undefined }
}

async function finishAutomaticRetentionPressure(fixture: Harness, cleanup: ReturnType<typeof holdOwnedTermination>) {
	for (const label of ["pressure-one", "pressure-two", "pressure-three"]) {
		await fixture.spawnCompletedChild(label)
	}
	await fixture.settleFinalizations({ includeResidency: false })
	// Observe the existing registry queue after ordinary finalization/termination.
	// This sentinel does not invoke admission or prune, which would mask deletion
	// of the automatic-finalization hook. Candidate cleanup already owns the queue;
	// baseline reaches this read-only sentinel without calling the existing wait.
	cleanup.sentinel = fixture.taskSessions.runOwnershipOperation(cleanup.taskId, async () => undefined)
	const observation = await Promise.race([
		cleanup.entered.promise.then(() => "automatic-cleanup"),
		cleanup.sentinel.then(() => "no-automatic-owner"),
	])
	expect(cleanup.wait).toHaveBeenCalledOnce()
	expect(observation).toBe("automatic-cleanup")
}

async function retainReasoningAdmission(fixture: Harness, child: Child) {
	const old = fixture.handlers.find((handler) => handler === child.task.api)
	if (!old) throw new Error("The completed real Task has no scripted adapter")
	const release = deferred()
	const entered = deferred()
	old.prepareModel.mockImplementationOnce(async () => {
		entered.resolve()
		await release.promise
	})
	const admission = child.task.prepareReasoningForAdmission()
	const settlement = Promise.allSettled([admission])
	await entered.promise
	const current = fixture.createReplacementHandler("retired-cold-runtime")
	child.task.updateApiConfiguration({ ...child.task.apiConfiguration, openAiModelId: current.getModel().id })
	expect(child.task.api).toBe(current)
	expect(old.dispose).not.toHaveBeenCalled()
	return { old, current, release, settlement }
}

function ownedFinalization(entry: Promise<void> | { readonly promise: Promise<void> } | undefined) {
	return entry && ("promise" in entry ? entry.promise : entry)
}

describe("AlphaProvider public automatic eviction and cold follow-up", () => {
	it("restores the same durable child only after real owned cleanup, then integrates its native wait receipt", async () => {
		const fixture = await createFixture()
		// Start the actual root before children publish their cards; its scripted
		// response is held until the child IDs and native waits have been selected.
		const firstRootTurn = fixture.queueTurn(fixture.root.taskId, "Collect the first completed report.")
		const rootCompleted = vi.fn()
		fixture.root.on(AlphaCodeEventName.TaskCompleted, rootCompleted)
		const verification = vi.spyOn(fixture.provider, "recordParentVerificationEvidence")
		fixture.root.start()
		await firstRootTurn.entered
		const target = await fixture.spawnCompletedChild("cold-followup-target")
		expect(target.task).toBeInstanceOf(Task)
		expect(target.result).toMatchObject({ status: "completed", summary: target.turn.summary, changedFiles: [] })
		const manifest = structuredClone(target.task.subagentContextManifest)
		expect(manifest?.orchestration?.ancestry).toMatchObject({ rootTaskId: fixture.root.taskId, depth: 1 })
		const originalHistory = (
			await fixture.provider.getTaskWithId(target.taskId, {
				includeApiConversationHistory: false,
			})
		).historyItem
		const originalTranscript = await readApiMessages({
			taskId: target.taskId,
			globalStoragePath: fixture.storagePath,
		})
		const passive = await fixture.provider.sendMessageToAgent(fixture.root, target.path, "PASSIVE_COLD_MAIL_MARKER")
		expect(passive.delivery).toBe("buffered")
		const passiveEntry = fixture.store
			.readMailbox(target.taskId, {
				rootTaskId: fixture.root.taskId,
				afterSequence: 0,
				includeDelivered: true,
			})
			.entries.find((entry) => entry.sequence === passive.sequence)
		expect(passiveEntry).toMatchObject({ payload: { message: "PASSIVE_COLD_MAIL_MARKER" } })
		const retained = await retainReasoningAdmission(fixture, target)
		const cleanup = holdOwnedTermination(target)
		const releaseReceipt = deferred()
		let followingSettlement: Promise<PromiseSettledResult<unknown>[]> | undefined
		try {
			await finishAutomaticRetentionPressure(fixture, cleanup)
			// First baseline failure is above: automatic real cleanup never starts.
			// No WS08-only API, held-entry wait or private prune is used to get RED.
			expect(fixture.childrenCaptured).toHaveLength(4)
			expect(fixture.provider.getLiveTask(target.taskId)).toBe(target.task)
			expect(target.task.abort).toBe(false)
			const originalMail = resultMail(fixture, target.taskId)
			expect(originalMail).toHaveLength(1)
			expect(originalMail[0].payload).toMatchObject({ summary: target.turn.summary, status: "completed" })
			const retainedUsage = rootBudgetUsage(fixture)
			expect(retainedUsage.tokens).toBe(20)
			expect(retainedUsage.cost).toBeCloseTo(0.004)
			expect(fixture.root.isCompleted()).toBe(false)
			await expect(fixture.provider.getParentCompletionDecision(fixture.root)).resolves.toMatchObject({
				allowed: false,
			})
			// Broaden actual live policy/limits after capture. Restore must retain the
			// saved authority and budget, including either optional description form.
			// The instruction adapter is fixed; its setting change is not the oracle.
			fixture.settings.customInstructions = "LIVE_SETTINGS_MUST_NOT_REPLACE_FROZEN_CHILD_AUTHORITY"
			fixture.settings.alwaysAllowWrite = true
			fixture.settings.alwaysAllowExecute = true
			fixture.settings.subagentMaxDepth = 2
			fixture.settings.maxConcurrentSubagents = 3
			fixture.settings.subagentMaxInputTokens = 500_000
			fixture.settings.subagentMaxOutputTokens = 32_000
			fixture.settings.subagentRootTokenBudget = 2_000_000
			fixture.settings.subagentRootCostBudget = 20
			const successorTurn = fixture.queueTurn(target.taskId, "Verified cold successor report.")
			let followingSettled = false
			const following = fixture.provider
				.followupAgentTask(fixture.root, target.path, "Recheck the retained report.")
				.then((handle) => {
					followingSettled = true
					return handle
				})
			followingSettlement = Promise.allSettled([following])
			// This real public policy read is serialized behind the preceding control
			// store root transaction; it observes admission without triggering prune.
			await fixture.provider.requiresExplicitAgentFollowupApproval(fixture.root, target.path)
			expect(
				(Reflect.get(fixture.provider, "agentFollowupAdmissions") as Map<string, Promise<unknown>>).has(
					target.taskId,
				),
			).toBe(true)
			expect(followingSettled).toBe(false)
			expect(successorTurn.request).toBeUndefined()
			expect(fixture.childrenCaptured.filter((task) => task.taskId === target.taskId)).toEqual([target.task])
			expect(fixture.taskSessions.getTask(target.taskId)).toBe(target.task)
			cleanup.release.resolve()
			const handle = subagentSpawnHandleSchema.parse(await following)
			await successorTurn.entered
			const successor = fixture.provider.getLiveTask(target.taskId)
			expect(successor).toBeInstanceOf(Task)
			if (!successor) throw new Error("The actual cold follow-up did not create its Task")
			expect(successor).not.toBe(target.task)
			expect(handle).toMatchObject({ taskId: target.taskId, path: target.path })
			expect(handle.runId).not.toBe(target.handle.runId)
			expect(fixture.runs.resolveRunTaskId(handle.runId)).toBe(target.taskId)
			expect(successor.subagentContextManifest).toEqual(manifest)
			expect(successor.subagentContextManifest?.runtimePolicy).toEqual(manifest?.runtimePolicy)
			expect(successor.subagentContextManifest?.orchestration?.limits).toEqual(manifest?.orchestration?.limits)
			expect(successor.subagentContextManifest?.runtimePolicy).toMatchObject({ execute: false, mutate: false })
			expect(successor.isToolAllowedForTask("exec_command")).toBe(true)
			expect(successor.isToolAllowedForTask("apply_patch")).toBe(false)
			expect(successor.isToolAllowedForTask("manage_command")).toBe(false)
			expect(successor.isToolAllowedForTask("spawn_agent")).toBe(manifest?.runtimePolicy.delegate === true)
			expect(successor.getTaskCommandDenialReason("node -e process.exit(0)", successor.cwd)).toBeDefined()
			expect(successor.taskMode).toBe(target.task.taskMode)
			expect(successor.cwd).toBe(target.task.cwd)
			expect(successor.subagentModelRoute).toEqual(target.task.subagentModelRoute)
			expect(rootBudgetUsage(fixture)).toEqual(retainedUsage)
			expect(successor.apiConversationHistory.slice(0, originalTranscript.length)).toEqual(originalTranscript)
			expect(
				successor.apiConversationHistory.some((message) => message.agent_message_id === passiveEntry?.eventId),
			).toBe(true)
			expect(resultMail(fixture, target.taskId)).toEqual(originalMail)
			expect(fixture.childrenCaptured).toHaveLength(5)
			expect(retained.old.dispose).toHaveBeenCalledOnce()
			expect(retained.current.dispose).toHaveBeenCalledOnce()
			const successorHandler = fixture.handlers.find((handler) => handler === successor.api)
			if (!successorHandler) throw new Error("The restored runtime has no owned transport")
			// This is the real predecessor reasoning-admission finalizer. Its run
			// finalization already settled before eviction; run-ID fencing has separate
			// focused coverage. Releasing this actual WS01 owner must not dispose the
			// new runtime or clear its journal/projector/session caches.
			const successorJournal = (
				Reflect.get(fixture.provider, "agentLifecycleJournals") as Map<string, unknown>
			).get(target.taskId)
			retained.release.resolve()
			const [admission] = await retained.settlement
			expect(admission.status).toBe("rejected")
			if (admission.status === "rejected") expect(admission.reason).toMatchObject({ name: "AbortError" })
			expect(retained.old.dispose).toHaveBeenCalledOnce()
			expect(successorHandler.dispose).not.toHaveBeenCalled()
			expect(fixture.taskSessions.getTask(target.taskId)).toBe(successor)
			expect(
				(Reflect.get(fixture.provider, "agentLifecycleJournals") as Map<string, unknown>).get(target.taskId),
			).toBe(successorJournal)
			expect(fixture.runs.resolveRunTaskId(handle.runId)).toBe(target.taskId)
			const secondRootTurn = fixture.queueTurn(fixture.root.taskId, "Wait for the cold successor.", [
				waitCall("wait-successor", target.taskId),
			])
			const finalRootTurn = fixture.queueTurn(
				fixture.root.taskId,
				"Integrated and verified all read-only reports.",
			)
			firstRootTurn.chunks = [waitCall("wait-original", target.taskId)]
			firstRootTurn.release()
			await secondRootTurn.entered
			const firstReceipt = waitReceipt(fixture.root.apiConversationHistory, "wait-original")
			expect(resultMail(fixture, target.taskId)[0]).toMatchObject({
				claimId: firstReceipt.claimId,
				acknowledgedAt: expect.any(Number),
			})
			const waitEntered = deferred()
			const originalWait = fixture.provider.waitForAgent.bind(fixture.provider)
			const nativeWait = vi.spyOn(fixture.provider, "waitForAgent").mockImplementation(async (...args) => {
				waitEntered.resolve()
				return originalWait(...args)
			})
			const receiptEntered = deferred()
			const originalCommit = ProviderTranscriptStore.prototype.commitAuthoritativeTranscript
			let heldReceipt = false
			vi.spyOn(ProviderTranscriptStore.prototype, "commitAuthoritativeTranscript").mockImplementation(
				async function (this: ProviderTranscriptStore, receipt, revision) {
					if (!heldReceipt && this.getTaskId() === fixture.root.taskId) {
						// Task's per-ID save queue still owns this exact completed legacy
						// write. Bind the gate to its immutable receipt bytes, never mutable
						// live history that may already contain a later queued transaction.
						const bytes = await fs.readFile(receipt.filePath)
						expect(bytes.byteLength).toBe(receipt.byteLength)
						expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.digest)
						const messages = JSON.parse(bytes.toString("utf8")) as ApiMessage[]
						if (toolResults(messages, "wait-successor").length > 0) {
							waitReceipt(messages, "wait-successor")
							heldReceipt = true
							receiptEntered.resolve()
							await releaseReceipt.promise
						}
					}
					return originalCommit.call(this, receipt, revision)
				},
			)
			secondRootTurn.release()
			await waitEntered.promise
			expect(nativeWait).toHaveBeenCalledOnce()
			await expect(fixture.provider.getParentCompletionDecision(fixture.root)).resolves.toMatchObject({
				allowed: false,
				activeDescendantCount: 1,
			})
			expect(rootCompleted).not.toHaveBeenCalled()
			const successorFinalization = ownedFinalization(
				(
					Reflect.get(fixture.provider, "subagentRunFinalizations") as Map<
						string,
						Promise<void> | { readonly promise: Promise<void> }
					>
				).get(target.taskId),
			)
			if (!successorFinalization) throw new Error("The public successor lost its owned finalization")
			successorTurn.release()
			const successorResult = await fixture.runs.waitForResult(target.taskId)
			await successorFinalization
			await receiptEntered.promise
			expect(successorResult).toMatchObject({
				status: "completed",
				summary: successorTurn.summary,
				changedFiles: [],
			})
			expect(fixture.root.isCompleted()).toBe(false)
			expect(rootCompleted).not.toHaveBeenCalled()
			await expect(fixture.provider.getParentCompletionDecision(fixture.root)).resolves.toMatchObject({
				allowed: false,
				activeDescendantCount: 0,
				unconsumedResultCount: 1,
			})
			const successorReceipt = waitReceipt(fixture.root.apiConversationHistory, "wait-successor")
			expect(fixture.root.hasRetainedWaitAgentResultClaim(successorReceipt.claimId)).toBe(true)
			expect(fixture.root.hasDurablyPersistedWaitAgentClaim(successorReceipt.claimId)).toBe(false)
			expect(resultMail(fixture, target.taskId)[1].claimId).toBe(successorReceipt.claimId)
			expect(resultMail(fixture, target.taskId)[1].acknowledgedAt).toBeUndefined()
			expect(verification).toHaveBeenCalledWith(fixture.root)
			// Review children create no Worker change sets. This calls the actual
			// evidence/decision path but does not certify nonempty Worker verification.
			expect(fixture.store.getVerificationObligations({ parentTaskId: fixture.root.taskId })).toEqual([])
			releaseReceipt.resolve()
			await finalRootTurn.entered
			finalRootTurn.release()
			await fixture.root.waitForTermination()
			expect(fixture.root.isCompleted()).toBe(true)
			expect(rootCompleted).toHaveBeenCalledOnce()
			await expect(fixture.provider.getParentCompletionDecision(fixture.root)).resolves.toMatchObject({
				allowed: true,
				blockingObligations: [],
			})
			const rootTranscript = await readApiMessages({
				taskId: fixture.root.taskId,
				globalStoragePath: fixture.storagePath,
			})
			for (const id of ["wait-original", "wait-successor"]) {
				expect(
					rootTranscript.flatMap((message) =>
						message.role === "assistant" && Array.isArray(message.content)
							? message.content.filter((block) => block.type === "tool_use" && block.id === id)
							: [],
					),
				).toHaveLength(1)
				waitReceipt(rootTranscript, id)
			}
			const terminalMail = resultMail(fixture, target.taskId)
			expect(terminalMail).toHaveLength(2)
			expect(new Set(terminalMail.map((entry) => entry.eventId)).size).toBe(2)
			expect(terminalMail.every((entry) => entry.acknowledgedAt !== undefined)).toBe(true)
			expect(terminalMail.map((entry) => entry.payload?.summary)).toEqual([
				target.turn.summary,
				successorTurn.summary,
			])
			const history = (
				await fixture.provider.getTaskWithId(target.taskId, { includeApiConversationHistory: false })
			).historyItem
			expect(history).toMatchObject({
				id: originalHistory.id,
				status: "completed",
				completionResultSummary: successorTurn.summary,
			})
			expect(history.tokensIn).toBe(4)
			expect(history.tokensOut).toBe(6)
			expect(history.totalCost).toBeCloseTo(0.002)
			expect(rootBudgetUsage(fixture).tokens).toBe(25)
			expect(rootBudgetUsage(fixture).cost).toBeCloseTo(0.005)
			const childMessages = await readTaskMessages({
				taskId: target.taskId,
				globalStoragePath: fixture.storagePath,
				requireExisting: true,
			})
			expect(
				childMessages.filter((message) => message.say === "completion_result").map((message) => message.text),
			).toEqual([target.turn.summary, successorTurn.summary])
			expect(fixture.root.alphaMessages.filter((message) => message.say === "completion_result")).toHaveLength(1)
			expect(successor.subagentContextManifest).toEqual(manifest)
		} finally {
			cleanup.release.resolve()
			releaseReceipt.resolve()
			await cleanup.sentinel
			retained.release.resolve()
			const followingSettlements = followingSettlement ? await followingSettlement : undefined
			const [admission] = await retained.settlement
			if (followingSettlements) {
				const [settlement] = followingSettlements
				expect(settlement.status).toBe("fulfilled")
				if (settlement.status === "fulfilled") {
					expect(subagentSpawnHandleSchema.parse(settlement.value).taskId).toBe(target.taskId)
				}
			}
			if (target.task.getTaskLifetimeCancellationSignal().aborted) {
				expect(admission.status).toBe("rejected")
				if (admission.status === "rejected") expect(admission.reason).toMatchObject({ name: "AbortError" })
			} else expect(admission.status).toBe("fulfilled")
		}
	})

	it("cancels queued public follow-up admissions without resetting the stopped parent's authority", async () => {
		const fixture = await createFixture()
		const target = await fixture.spawnCompletedChild("cancelled-queued-cold-target")
		const cleanup = holdOwnedTermination(target)
		let admissions: Promise<PromiseSettledResult<unknown>[]> | undefined
		let stopping: Promise<void> | undefined
		try {
			await finishAutomaticRetentionPressure(fixture, cleanup)
			const priorEvents = fixture.runs.getEvents(target.taskId)
			const priorMail = resultMail(fixture, target.taskId)
			const priorTerminal = fixture.store.getAgent(target.taskId)?.terminalResult
			const first = fixture.provider.followupAgentTask(fixture.root, target.path, "Queued follow-up one.")
			const second = fixture.provider.followupAgentTask(fixture.root, target.path, "Queued follow-up two.")
			admissions = Promise.allSettled([first, second])
			await fixture.provider.requiresExplicitAgentFollowupApproval(fixture.root, target.path)
			expect(
				(Reflect.get(fixture.provider, "agentFollowupAdmissions") as Map<string, Promise<unknown>>).has(
					target.taskId,
				),
			).toBe(true)
			expect(fixture.provider.getLiveTask(target.taskId)).toBe(target.task)
			stopping = fixture.root.abortTask()
			expect(fixture.root.abort).toBe(true)
			cleanup.release.resolve()
			await cleanup.sentinel
			await stopping
			const settlements = await admissions
			expect(settlements.map((value) => value.status)).toEqual(["rejected", "rejected"])
			for (const settlement of settlements) {
				if (settlement.status === "rejected")
					expect(settlement.reason).toMatchObject({ message: expect.stringMatching(/cancelled/i) })
			}
			await fixture.settleFinalizations({ includeResidency: true })
			expect(fixture.childrenCaptured).toHaveLength(4)
			expect(fixture.childrenCaptured.filter((task) => task.taskId === target.taskId)).toEqual([target.task])
			expect(
				fixture.runs
					.getEvents(target.taskId)
					.filter((event) => !priorEvents.some((old) => old.eventId === event.eventId)),
			).toEqual([])
			expect(resultMail(fixture, target.taskId)).toEqual(priorMail)
			expect(fixture.store.getAgent(target.taskId)?.terminalResult).toEqual(priorTerminal)
			expect(fixture.store.getAgent(target.taskId)?.status).toBe("completed")
			expect(
				fixture.store.readMailbox(target.taskId, {
					rootTaskId: fixture.root.taskId,
					afterSequence: 0,
					includeDelivered: true,
					kinds: ["followup"],
				}).entries,
			).toEqual([])
			expect(fixture.provider.getLiveTask(target.taskId)).toBeUndefined()
			expect(fixture.root.getTaskLifetimeCancellationSignal().aborted).toBe(true)
		} finally {
			if (admissions && !fixture.root.abort) stopping = fixture.root.abortTask()
			cleanup.release.resolve()
			await cleanup.sentinel
			await stopping
			if (admissions) {
				const settlements = await admissions
				for (const settlement of settlements) {
					expect(settlement.status).toBe("rejected")
					if (settlement.status === "rejected") {
						expect(settlement.reason).toMatchObject({ message: expect.stringMatching(/cancelled/i) })
					}
				}
			}
		}
	})
})
