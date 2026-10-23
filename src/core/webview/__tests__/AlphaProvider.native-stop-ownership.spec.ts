import { EventEmitter } from "node:events"

import { AlphaCodeEventName } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Task } from "../../task/Task"
import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type CancellationReceipt = Readonly<{ abort: Promise<void>; termination: Promise<void>; isCurrent(): boolean }>
type NativeEntry = { performAbortTask(...args: unknown[]): Promise<void> }
type NativeStop = { beginTaskCancellation(isAbandoned?: boolean): CancellationReceipt }

const fixtures: Harness[] = []
const releases: Array<() => void> = []
const pending: Promise<unknown>[] = []

afterEach(async () => {
	for (const release of releases.splice(0)) release()
	try {
		await Promise.allSettled(pending.splice(0))
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

async function fixture() {
	const value = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	fixtures.push(value)
	return value
}

async function startOriginal(harness: Harness) {
	const turn = harness.queueTurn(harness.root.taskId, "Original Stop owner")
	releases.push(turn.release)
	harness.root.start()
	await turn.entered
	const step = Reflect.get(harness.root, "currentAgentStep")
	if (!step || !turn.request?.signal) throw new Error("The real Task did not enter its scripted request")
	expect(turn.request.requestId).toBe(step.requestId)
	expect(turn.request.attemptId).toBe(step.attemptId)
	return { task: harness.root, turn, step }
}

/** Pass through an existing native entry; no new API is required to reach the first regression oracle. */
function observeNativeEntry(task: Task) {
	const entered = deferred<unknown>()
	const target = task as unknown as NativeEntry
	const perform = target.performAbortTask
	const entries: unknown[] = []
	vi.spyOn(target, "performAbortTask").mockImplementation((...args) => {
		const step = Reflect.get(task, "currentAgentStep")
		entries.push(step)
		entered.resolve(step)
		return Reflect.apply(perform, task, args)
	})
	return { entered: entered.promise, entries }
}

function observeReceiptIfAvailable(task: Task) {
	const target = task as unknown as Partial<NativeStop>
	const begin = target.beginTaskCancellation
	const receipts: CancellationReceipt[] = []
	if (typeof begin === "function") {
		vi.spyOn(target as NativeStop, "beginTaskCancellation").mockImplementation((abandoned) => {
			const receipt = begin.call(task, abandoned)
			receipts.push(receipt)
			return receipt
		})
	}
	return receipts
}

function ownedProcess(task: Task, name: string) {
	const entered = deferred()
	const release = deferred()
	releases.push(release.resolve)
	const process = Object.assign(new EventEmitter(), {
		executionId: name,
		isSettled: false,
		abort: vi.fn(async () => {
			entered.resolve()
			await release.promise
			process.isSettled = true
			process.emit("completed")
		}),
	})
	Reflect.set(task, "terminalProcess", process)
	task.beginCommandExecution(`${name}_call`, name, "Controlled adapter command")
	return { process, entered: entered.promise, release: release.resolve }
}

/** A is a real running Task. The abort listener installs controlled B owner fields on that same object. */
function callbackReplacement(task: Task, step: Record<string, unknown>) {
	const originalWait = task.beginAgentWait()
	const keys = [
		"taskCancellationController",
		"currentRequestAbortController",
		"agentWaitAbortController",
		"stepInterruptionController",
		"contextCondenseAbortController",
		"postTurnCompactionAbortController",
		"backgroundUsageDrainAbortController",
	] as const
	const original = Object.fromEntries(
		keys.map((key) => {
			const controller = Reflect.get(task, key) as AbortController | undefined
			if (controller) return [key, controller]
			const installed = new AbortController()
			Reflect.set(task, key, installed)
			return [key, installed]
		}),
	) as Record<(typeof keys)[number], AbortController>
	const replacement = Object.fromEntries(keys.map((key) => [key, new AbortController()])) as typeof original
	const replacementLifetime = deferred()
	releases.push(replacementLifetime.resolve)
	const process = Object.assign(new EventEmitter(), {
		executionId: "replacement_command",
		isSettled: false,
		abort: vi.fn(async () => {
			process.isSettled = true
			process.emit("completed")
		}),
	})
	let installed = false
	const install = () => {
		if (installed) return
		installed = true
		Object.assign(task, replacement, {
			currentAgentStep: {
				...step,
				turnId: "replacement_turn",
				stepId: "replacement_step",
				requestId: "replacement_request",
				attemptId: "replacement_attempt",
			},
			agentRunId: "replacement_run",
			agentTurnId: "replacement_turn",
			terminalProcess: process,
			ownedLifecyclePromise: replacementLifetime.promise,
			taskTerminationPromise: replacementLifetime.promise,
			abortTaskPromise: undefined,
			abandoned: false,
			abort: false,
			abortReason: undefined,
		})
	}
	originalWait.signal.addEventListener("abort", install, { once: true })
	const expectPreserved = () => {
		expect(installed).toBe(true)
		for (const [key, controller] of Object.entries(replacement)) {
			expect(controller.signal.aborted, key).toBe(false)
			expect(Reflect.get(task, key), key).toBe(controller)
		}
		expect(task.abandoned).toBe(false)
		expect(task.abort).toBe(false)
		expect(process.abort).not.toHaveBeenCalled()
	}
	return {
		original,
		replacement,
		installed: () => installed,
		expectPreserved,
		lifecycle: replacementLifetime.promise,
		release: replacementLifetime.resolve,
		dispose: originalWait.dispose,
		install,
	}
}

describe("AlphaProvider native Stop caller ownership", () => {
	it("ignores a Stop addressed to an earlier turn before entering native cancellation", async () => {
		const harness = await fixture()
		const { task, turn } = await startOriginal(harness)
		const cancel = vi.spyOn(task, "beginTaskCancellation")
		const dispose = vi.spyOn(task, "dispose")
		const rehydrate = vi.spyOn(harness.provider, "createTaskWithHistoryItem")
		await harness.provider.cancelTask(task.taskId, "webview_stop", "earlier-turn")
		expect(cancel).not.toHaveBeenCalled()
		expect(dispose).not.toHaveBeenCalled()
		expect(rehydrate).not.toHaveBeenCalled()
		expect(turn.request?.signal?.aborted).toBe(false)
		expect(harness.provider.getLiveTask(task.taskId)).toBe(task)
	})

	it("captures A before the first abort callback and joins A without cancelling, abandoning, closing or rehydrating B", async () => {
		const harness = await fixture()
		const { task, step } = await startOriginal(harness)
		const command = ownedProcess(task, "original_command")
		const entry = observeNativeEntry(task)
		const receipts = observeReceiptIfAvailable(task)
		const replacement = callbackReplacement(task, step)
		const dispose = vi.spyOn(task, "dispose")
		const aborted = vi.fn()
		task.on(AlphaCodeEventName.TaskAborted, aborted)
		const rehydrate = vi.spyOn(harness.provider, "createTaskWithHistoryItem")
		const closing = vi.spyOn(harness.provider, "closeTask")
		let settled = false
		const stop = harness.provider.cancelTask(task.taskId, "webview_stop")
		pending.push(stop)
		void stop.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		try {
			// The old public provider deterministically enters native abort with B here.
			expect(await entry.entered).toBe(step)
			if (!receipts[0]) throw new Error("Native receipt unavailable after the existing-entry oracle passed")
			expect(receipts[0].termination).not.toBe(replacement.lifecycle)
			expect(receipts[0].isCurrent()).toBe(false)
			await command.entered
			expect(settled).toBe(false)
			replacement.expectPreserved()
			for (const controller of Object.values(replacement.original)) expect(controller.signal.aborted).toBe(true)
			command.release()
			await stop
			replacement.expectPreserved()
			expect(harness.provider.getLiveTask(task.taskId)).toBe(task)
			expect(dispose).not.toHaveBeenCalled()
			expect(aborted).not.toHaveBeenCalled()
			expect(closing).not.toHaveBeenCalled()
			expect(rehydrate).not.toHaveBeenCalled()
		} finally {
			replacement.dispose()
			command.release()
			replacement.release()
		}
	})

	it("rehydrates an unchanged native owner only after its actual command and termination joins", async () => {
		const harness = await fixture()
		const { task, step } = await startOriginal(harness)
		const command = ownedProcess(task, "unchanged_command")
		const entry = observeNativeEntry(task)
		const receipts = observeReceiptIfAvailable(task)
		const rehydrate = vi.spyOn(harness.provider, "createTaskWithHistoryItem")
		const stop = harness.provider.cancelTask(task.taskId, "webview_stop")
		pending.push(stop)
		expect(await entry.entered).toBe(step)
		await command.entered
		expect(rehydrate).not.toHaveBeenCalled()
		command.release()
		await stop
		expect(rehydrate).toHaveBeenCalledOnce()
		expect(harness.provider.getLiveTask(task.taskId)).not.toBe(task)
		if (receipts.length) {
			expect(Object.isFrozen(receipts[0])).toBe(true)
			await expect(receipts[0].termination).resolves.toBeUndefined()
		}
	})

	it("keeps legacy request cancellation, abandonment and explicit lifecycle/persistence joins", async () => {
		const harness = await fixture()
		const joinEntered = deferred()
		const join = deferred()
		const persistEntered = deferred()
		const persistence = deferred()
		releases.push(join.resolve, persistence.resolve)
		const order: string[] = []
		const legacy = {
			taskId: "legacy_stop",
			instanceId: "legacy_instance",
			abandoned: false,
			cancelCurrentRequest: vi.fn(() => {
				order.push("cancel")
			}),
			abortTask: vi.fn(async () => {
				order.push("abort")
			}),
			lifecycleRuntime: {
				join: vi.fn(async () => {
					joinEntered.resolve()
					await join.promise
				}),
				waitForPersistence: vi.fn(async () => {
					persistEntered.resolve()
					await persistence.promise
				}),
			},
		}
		const getLive = harness.provider.getLiveTask.bind(harness.provider)
		vi.spyOn(harness.provider, "getLiveTask").mockImplementation((id) =>
			id === legacy.taskId ? (legacy as unknown as Task) : getLive(id),
		)
		vi.spyOn(harness.provider, "getTaskWithId").mockImplementation(
			async () =>
				({
					historyItem: {
						id: legacy.taskId,
						number: 1,
						ts: 1,
						task: "legacy",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				}) as Awaited<ReturnType<Harness["provider"]["getTaskWithId"]>>,
		)
		const rehydrate = vi.spyOn(harness.provider, "createTaskWithHistoryItem").mockResolvedValue(harness.root)
		const stop = harness.provider.cancelTask(legacy.taskId, "webview_stop")
		pending.push(stop)
		await joinEntered.promise
		expect(order).toEqual(["cancel", "abort"])
		expect(legacy.abandoned).toBe(true)
		expect(rehydrate).not.toHaveBeenCalled()
		join.resolve()
		await persistEntered.promise
		expect(rehydrate).not.toHaveBeenCalled()
		persistence.resolve()
		await stop
		expect(rehydrate).toHaveBeenCalledOnce()
	})

	it.each(["history readiness", "owned restore queue", "mailbox receipt"] as const)(
		"keeps callback-installed B intact when the original Stop restore waits at %s",
		async (phase) => {
			const harness = await fixture()
			const { task, step } = await startOriginal(harness)
			const fallbackTurn = harness.queueTurn(task.taskId, "Unexpected baseline restoration cleanup")
			releases.push(fallbackTurn.release)
			const entry = observeNativeEntry(task)
			const replacement = callbackReplacement(task, step)
			const held = deferred()
			const entered = deferred()
			releases.push(held.resolve)
			// This case hands ownership off during restoration, after original cancellation completes.
			replacement.original.agentWaitAbortController.signal.removeEventListener("abort", replacement.install)
			const nativeRestore = harness.provider.createTaskWithHistoryItem.bind(harness.provider)
			let queue: Promise<void> | undefined
			vi.spyOn(harness.provider, "createTaskWithHistoryItem").mockImplementation(async (history, options) => {
				if (phase === "history readiness") {
					Reflect.set(harness.provider, "taskHistoryStoreReady", held.promise)
				} else if (phase === "owned restore queue") {
					queue = harness.taskSessions.runOwnershipOperation(task.taskId, async () => {
						entered.resolve()
						await held.promise
					})
					pending.push(queue)
				} else {
					const actual = harness.store.retryPendingMailboxClaimSettlements.bind(harness.store)
					vi.spyOn(harness.store, "retryPendingMailboxClaimSettlements").mockImplementationOnce(
						async (...args) => {
							entered.resolve()
							await held.promise
							return actual(...args)
						},
					)
				}
				const restoring = nativeRestore(history, options)
				if (phase === "history readiness") entered.resolve()
				return restoring
			})
			const stop = harness.provider.cancelTask(task.taskId, "webview_stop")
			pending.push(stop)
			expect(await entry.entered).toBe(step)
			await entered.promise
			replacement.install()
			const dispose = vi.spyOn(task, "dispose")
			const mutation = deferred<string>()
			const actualAbort = task.abortTask.bind(task)
			const abort = vi.spyOn(task, "abortTask").mockImplementation((...args) => {
				mutation.resolve("abort")
				return actualAbort(...args)
			})
			const actualReplace = harness.taskSessions.replaceTask.bind(harness.taskSessions)
			vi.spyOn(harness.taskSessions, "replaceTask").mockImplementation((...args) => {
				mutation.resolve("replace")
				return actualReplace(...args)
			})
			const sessionClose = vi.spyOn(harness.taskSessions, "unregister")
			held.resolve()
			const next = await Promise.race([
				mutation.promise,
				stop.then(
					() => "stop",
					() => "failure",
				),
			])
			// The baseline reaches an existing B mutation before it could wait on B.
			expect(next).toBe("stop")
			await stop
			if (queue) await queue
			replacement.expectPreserved()
			expect(harness.provider.getLiveTask(task.taskId)).toBe(task)
			expect(abort).not.toHaveBeenCalled()
			expect(dispose).not.toHaveBeenCalled()
			expect(sessionClose).not.toHaveBeenCalled()
			replacement.dispose()
			replacement.release()
		},
	)

	it("joins a held actual old-child finalizer after A hands ownership to B", async () => {
		const harness = await fixture()
		const { task, step } = await startOriginal(harness)
		const child = await harness.spawnChild("stop_owned_child")
		releases.push(child.turn.release)
		const entered = deferred()
		const held = deferred()
		releases.push(held.resolve)
		const actualFlush = child.task.flushApiConversationHistoryPersistence.bind(child.task)
		vi.spyOn(child.task, "flushApiConversationHistoryPersistence").mockImplementation(
			async (...args: Parameters<Task["flushApiConversationHistoryPersistence"]>) => {
				await actualFlush(...args)
				entered.resolve()
				await held.promise
			},
		)
		const entry = observeNativeEntry(task)
		const receipts = observeReceiptIfAvailable(task)
		const replacement = callbackReplacement(task, step)
		let settled = false
		const stop = harness.provider.cancelTask(task.taskId, "webview_stop")
		pending.push(stop)
		void stop.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		expect(await entry.entered).toBe(step)
		await entered.promise
		if (!receipts[0]) throw new Error("Native receipt unavailable after the existing-entry oracle passed")
		await receipts[0].termination
		expect(settled).toBe(false)
		replacement.expectPreserved()
		held.resolve()
		await child.finalization
		await stop
		replacement.expectPreserved()
		expect(child.task.getTaskLifetimeCancellationSignal().aborted).toBe(true)
		replacement.dispose()
		replacement.release()
	})

	it.each(["mode admission", "control commit"] as const)(
		"joins a pending public launch at %s before returning from Stop after B replaces A",
		async (phase) => {
			const harness = await fixture()
			const { task, step } = await startOriginal(harness)
			const prepared = await harness.provider.prepareSubagentGroup(task, [
				{
					task_name: "pending_stop_child",
					objective: "Review the pending admission without changing files.",
					agent_kind: "review",
					fork_turns: "none",
					expected_output: ["A verified report"],
				},
			])
			const taskId = prepared.envelopes[0].id
			const held = deferred()
			const admitted = deferred()
			releases.push(held.resolve)
			const method =
				phase === "mode admission"
					? "assertPreparedSubagentGroupAllowedInCurrentMode"
					: "ensurePreparedSubagentControlRecords"
			const target = harness.provider as unknown as Record<
				typeof method,
				(...args: unknown[]) => Promise<unknown>
			>
			const actual = target[method]
			vi.spyOn(target, method).mockImplementationOnce(async (...args) => {
				const result = await Reflect.apply(actual, harness.provider, args)
				admitted.resolve()
				await held.promise
				return result
			})
			const entry = observeNativeEntry(task)
			const receipts = observeReceiptIfAvailable(task)
			const replacement = callbackReplacement(task, step)
			const created = vi.fn()
			harness.provider.on(AlphaCodeEventName.TaskCreated, created)
			const launching = harness.provider.launchPreparedSubagentGroup(
				task,
				prepared,
				replacement.original.taskCancellationController.signal,
			)
			const launched = Promise.allSettled([launching])
			pending.push(launching)
			await admitted.promise
			let settled = false
			const stop = harness.provider.cancelTask(task.taskId, "webview_stop")
			pending.push(stop)
			void stop.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)
			expect(await entry.entered).toBe(step)
			if (!receipts[0]) throw new Error("Native receipt unavailable after the existing-entry oracle passed")
			await receipts[0].termination
			expect(settled).toBe(false)
			replacement.expectPreserved()
			expect(created).not.toHaveBeenCalled()
			held.resolve()
			const [outcome] = await launched
			expect(outcome.status).toBe("rejected")
			if (outcome.status === "rejected")
				expect(outcome.reason).toBe(replacement.original.taskCancellationController.signal.reason)
			await stop
			replacement.expectPreserved()
			expect(created).not.toHaveBeenCalled()
			expect(harness.provider.getLiveTask(taskId)).toBeUndefined()
			if (phase === "control commit") expect(harness.store.getAgent(taskId)?.status).toBe("cancelled")
			expect(
				(Reflect.get(harness.provider, "preparedSubagentGroups") as Map<string, unknown>).has(
					prepared.group.groupId,
				),
			).toBe(false)
			replacement.dispose()
			replacement.release()
		},
	)

	it.each([new Error("Controlled original admission persistence failure"), undefined, null])(
		"retains pending-admission cleanup rejection %s after joining A",
		async (failure) => {
			const harness = await fixture()
			const { task, step } = await startOriginal(harness)
			const sibling = await harness.spawnChild("cleanup_held_sibling")
			releases.push(sibling.turn.release)
			const siblingEntered = deferred()
			const siblingHeld = deferred()
			releases.push(siblingHeld.resolve)
			const actualFlush = sibling.task.flushApiConversationHistoryPersistence.bind(sibling.task)
			vi.spyOn(sibling.task, "flushApiConversationHistoryPersistence").mockImplementation(
				async (...args: Parameters<Task["flushApiConversationHistoryPersistence"]>) => {
					await actualFlush(...args)
					siblingEntered.resolve()
					await siblingHeld.promise
				},
			)
			const prepared = await harness.provider.prepareSubagentGroup(task, [
				{
					task_name: "failed_cleanup_child",
					objective: "Review the held admission without changing files.",
					agent_kind: "review",
					fork_turns: "none",
					expected_output: ["A verified report"],
				},
			])
			const held = deferred()
			const admitted = deferred()
			releases.push(held.resolve)
			const target = harness.provider as unknown as {
				ensurePreparedSubagentControlRecords(...args: unknown[]): Promise<unknown>
			}
			const actual = target.ensurePreparedSubagentControlRecords
			vi.spyOn(target, "ensurePreparedSubagentControlRecords").mockImplementationOnce(async (...args) => {
				const result = await Reflect.apply(actual, harness.provider, args)
				admitted.resolve()
				await held.promise
				return result
			})
			const entry = observeNativeEntry(task)
			const receipts = observeReceiptIfAvailable(task)
			const replacement = callbackReplacement(task, step)
			const launching = harness.provider.launchPreparedSubagentGroup(
				task,
				prepared,
				replacement.original.taskCancellationController.signal,
			)
			const launched = Promise.allSettled([launching])
			pending.push(launching)
			await admitted.promise
			const update = harness.store.updateAgentStatus.bind(harness.store)
			let injected = false
			vi.spyOn(harness.store, "updateAgentStatus").mockImplementation(async (...args) => {
				if (args[0] === prepared.envelopes[0].id && !injected) {
					injected = true
					throw failure
				}
				return update(...args)
			})
			let settled = false
			const stop = harness.provider.cancelTask(task.taskId, "webview_stop")
			const stopped = Promise.allSettled([stop])
			void stop.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)
			pending.push(stop)
			expect(await entry.entered).toBe(step)
			if (!receipts[0]) throw new Error("Native receipt unavailable after the existing-entry oracle passed")
			await receipts[0].termination
			await siblingEntered.promise
			held.resolve()
			const [launchOutcome] = await launched
			expect(settled).toBe(false)
			siblingHeld.resolve()
			await sibling.finalization
			const [stopOutcome] = await stopped
			expect(launchOutcome.status).toBe("rejected")
			expect(stopOutcome.status).toBe("rejected")
			if (launchOutcome.status === "rejected") expect(launchOutcome.reason).toBe(failure)
			if (stopOutcome.status === "rejected") expect(stopOutcome.reason).toBe(failure)
			replacement.expectPreserved()
			expect(harness.provider.getLiveTask(prepared.envelopes[0].id)).toBeUndefined()
			replacement.dispose()
			replacement.release()

			// The injected rollback failure leaves a pending durable control row.
			// Shutdown must report that owned cleanup failure even after A -> B.
			await expect(harness.provider.dispose()).rejects.toBe(failure)
			const finalizations = Reflect.get(harness.provider, "subagentRunFinalizations") as Map<
				string,
				{ promise: Promise<void> }
			>
			const taskId = prepared.envelopes[0].id
			const receipt = finalizations.get(taskId)
			expect(receipt).toBeDefined()
			if (!receipt) throw new Error("The failed admission lost its cleanup ownership")
			const [settlement] = await Promise.allSettled([receipt.promise])
			expect(settlement).toEqual({ status: "rejected", reason: failure })
			const completedAt = Date.now()
			await harness.store.updateAgentStatus(
				taskId,
				"cancelled",
				{
					at: completedAt,
					terminalResult: { status: "cancelled", stopReason: "parent_cancelled", completedAt },
				},
				task.taskId,
			)
			// Only the now-repaired, fully joined fixture fault may release its pin.
			expect(finalizations.get(taskId)).toBe(receipt)
			finalizations.delete(taskId)
		},
	)

	it("joins both captured A children after the first cancel journal await hands ownership to B without reading B's later manager channel", async () => {
		const harness = await fixture()
		const { task, step } = await startOriginal(harness)
		const children = [await harness.spawnChild("descendant_first"), await harness.spawnChild("descendant_later")]
		for (const child of children) releases.push(child.turn.release)
		const order = harness.store
			.listDescendants(task.taskId, task.taskId)
			.filter((record) => ["pending", "running", "cancelling"].includes(record.status))
			.sort((left, right) => right.path.split("/").length - left.path.split("/").length)
		const first = children.find((child) => child.taskId === order[0]?.taskId)
		const later = children.find((child) => child.taskId === order[1]?.taskId)
		if (!first || !later) throw new Error("The real provider did not admit both original descendants")
		const heldCleanup = new Map(
			children.map((child) => {
				const entered = deferred()
				const held = deferred()
				releases.push(held.resolve)
				const actual = child.task.flushApiConversationHistoryPersistence.bind(child.task)
				vi.spyOn(child.task, "flushApiConversationHistoryPersistence").mockImplementation(
					async (...args: Parameters<Task["flushApiConversationHistoryPersistence"]>) => {
						await actual(...args)
						entered.resolve()
						await held.promise
					},
				)
				return [child.taskId, { entered: entered.promise, release: held.resolve }] as const
			}),
		)
		const replacement = callbackReplacement(task, step)
		replacement.original.agentWaitAbortController.signal.removeEventListener("abort", replacement.install)
		const laterStep = Reflect.get(later.task, "currentAgentStep")
		if (!laterStep) throw new Error("The later real child did not enter its scripted request")
		const childReplacement = callbackReplacement(later.task, laterStep)
		childReplacement.original.agentWaitAbortController.signal.removeEventListener("abort", childReplacement.install)
		const entry = observeNativeEntry(task)
		let handedOff = false
		const lateManagerReads: string[] = []
		const lateManagerCancels: string[] = []
		const actualWait = harness.runs.waitForResult.bind(harness.runs)
		const laterChannel = Promise.resolve({ taskId: later.taskId, status: "cancelled" }) as NonNullable<
			ReturnType<typeof harness.runs.waitForResult>
		>
		vi.spyOn(harness.runs, "waitForResult").mockImplementation((id) => {
			if (handedOff && id === later.taskId) {
				lateManagerReads.push(id)
				return laterChannel
			}
			return actualWait(id)
		})
		const actualCancel = harness.runs.cancel.bind(harness.runs)
		vi.spyOn(harness.runs, "cancel").mockImplementation((id, ...args) => {
			if (handedOff && id === later.taskId) lateManagerCancels.push(id)
			return actualCancel(id, ...args)
		})
		const enteredJournal = deferred()
		const heldJournal = deferred()
		releases.push(heldJournal.resolve)
		const actualAppend = harness.store.appendEvent.bind(harness.store)
		let journalHeld = false
		vi.spyOn(harness.store, "appendEvent").mockImplementation(async (event) => {
			const result = await actualAppend(event)
			if (!journalHeld && event.name === "cancel_requested" && event.recipient === first.taskId) {
				journalHeld = true
				enteredJournal.resolve()
				await heldJournal.promise
			}
			return result
		})
		// This fixture isolates descendant ownership; the other cases exercise actual Stop restoration.
		const actualHistory = harness.provider.getTaskWithId.bind(harness.provider)
		vi.spyOn(harness.provider, "getTaskWithId").mockImplementation((id, ...args) => {
			if (id === task.taskId) return Promise.reject(new Error("Controlled unavailable Stop history"))
			return actualHistory(id, ...args)
		})
		let settled = false
		const stop = harness.provider.cancelTask(task.taskId, "webview_stop")
		pending.push(stop)
		void stop.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		expect(await entry.entered).toBe(step)
		await enteredJournal.promise
		await Promise.all([...heldCleanup.values()].map((cleanup) => cleanup.entered))
		handedOff = true
		replacement.install()
		childReplacement.install()
		heldJournal.resolve()
		heldCleanup.get(first.taskId)!.release()
		await first.finalization
		expect(settled).toBe(false)
		// Other cases hold B through return; here releasing the synthetic lifetime
		// lets the old generic waiter reach the manager-read assertion deterministically.
		replacement.release()
		childReplacement.release()
		heldCleanup.get(later.taskId)!.release()
		await later.finalization
		const [outcome] = await Promise.allSettled([stop])
		expect(lateManagerReads).toEqual([])
		expect(lateManagerCancels).toEqual([])
		expect(outcome.status).toBe("fulfilled")
		replacement.expectPreserved()
		childReplacement.expectPreserved()
		replacement.dispose()
		replacement.release()
		childReplacement.dispose()
		childReplacement.release()
	})

	it("rejects an already-aborted public admission without constructing a child or retaining its slots", async () => {
		const harness = await fixture()
		const prepared = await harness.provider.prepareSubagentGroup(harness.root, [
			{
				task_name: "already_aborted_child",
				objective: "Review the cancelled admission without changing files.",
				agent_kind: "review",
				fork_turns: "none",
				expected_output: ["A verified report"],
			},
		])
		const controller = new AbortController()
		const reason = new Error("Original admission cancelled before entry")
		controller.abort(reason)
		const created = vi.fn()
		harness.provider.on(AlphaCodeEventName.TaskCreated, created)
		await expect(
			harness.provider.launchPreparedSubagentGroup(harness.root, prepared, controller.signal),
		).rejects.toBe(reason)
		expect(created).not.toHaveBeenCalled()
		expect(harness.provider.getLiveTask(prepared.envelopes[0].id)).toBeUndefined()
		expect(
			(Reflect.get(harness.provider, "preparedSubagentGroups") as Map<string, unknown>).has(
				prepared.group.groupId,
			),
		).toBe(false)
	})

	it("enters managed child native Stop with A before a child abort callback installs B", async () => {
		const harness = await fixture()
		const original = await startOriginal(harness)
		const child = await harness.spawnChild("managed_native_stop")
		releases.push(child.turn.release)
		const childStep = Reflect.get(child.task, "currentAgentStep")
		if (!childStep) throw new Error("Actual child did not own its scripted step")
		const parentEntry = observeNativeEntry(original.task)
		const childEntry = observeNativeEntry(child.task)
		const parentReplacement = callbackReplacement(original.task, original.step)
		const childReplacement = callbackReplacement(child.task, childStep)
		const childReceipts = observeReceiptIfAvailable(child.task)
		const stop = harness.provider.cancelTask(original.task.taskId, "webview_stop")
		pending.push(stop)
		expect(await parentEntry.entered).toBe(original.step)
		expect(await childEntry.entered).toBe(childStep)
		await child.finalization
		await stop
		parentReplacement.expectPreserved()
		childReplacement.expectPreserved()
		expect(childReceipts.length).toBeGreaterThan(0)
		parentReplacement.dispose()
		parentReplacement.release()
		childReplacement.dispose()
		childReplacement.release()
	})

	it("refuses a reused public admission without releasing the held original operation or its preparation", async () => {
		const harness = await fixture()
		const prepared = await harness.provider.prepareSubagentGroup(harness.root, [
			{
				task_name: "reused_held_child",
				objective: "Review the original held admission without changing files.",
				agent_kind: "review",
				fork_turns: "none",
				expected_output: ["A verified report"],
			},
		])
		const taskId = prepared.envelopes[0].id
		const turn = harness.queueTurn(taskId, "Original admission remains authoritative")
		releases.push(turn.release)
		const entered = deferred()
		const held = deferred()
		releases.push(held.resolve)
		const target = harness.provider as unknown as {
			assertPreparedSubagentGroupAllowedInCurrentMode(...args: unknown[]): Promise<unknown>
		}
		const actual = target.assertPreparedSubagentGroupAllowedInCurrentMode
		vi.spyOn(target, "assertPreparedSubagentGroupAllowedInCurrentMode").mockImplementationOnce(async (...args) => {
			const result = await Reflect.apply(actual, harness.provider, args)
			entered.resolve()
			await held.promise
			return result
		})
		const originalSignal = harness.root.getTaskLifetimeCancellationSignal()
		const first = harness.provider.launchPreparedSubagentGroup(harness.root, prepared, originalSignal)
		pending.push(first)
		await entered.promise
		const records = Reflect.get(harness.provider, "subagentRunFinalizations") as Map<string, unknown>
		const before = records.get(taskId)
		const messages = structuredClone(harness.root.clineMessages)
		const reservations = Reflect.get(harness.provider, "reservedSubagentSlots") as Map<string, unknown>
		const reservation = reservations.get(prepared.group.groupId)
		await expect(
			harness.provider.launchPreparedSubagentGroup(harness.root, prepared, originalSignal),
		).rejects.toThrow("previous sub-agent admission")
		// SpawnAgentTool performs this cleanup after a rejected launch; it has no A operation token.
		await harness.provider.cancelPreparedSubagentGroup(harness.root, prepared, "Refused duplicate cleanup")
		expect(records.get(taskId)).toBe(before)
		expect(before).toBeDefined()
		expect(
			(Reflect.get(harness.provider, "preparedSubagentGroups") as Map<string, unknown>).get(
				prepared.group.groupId,
			),
		).toBe(prepared)
		expect(reservations.get(prepared.group.groupId)).toBe(reservation)
		expect(harness.root.clineMessages).toEqual(messages)
		expect(originalSignal.aborted).toBe(false)
		held.resolve()
		const handle = await first
		await turn.entered
		turn.release()
		const result = await harness.runs.waitForResult(handle.taskId)
		await harness.settleFinalizations()
		expect(result).toMatchObject({ status: "completed", summary: turn.summary })
	})

	it.each([false, true])(
		"cancels and joins a held public group admission with replacement callback %s",
		async (replace) => {
			const harness = await fixture()
			const { task, step } = await startOriginal(harness)
			const prepared = await harness.provider.prepareSubagentGroup(task, [
				{
					task_name: "pending_group_cancel",
					objective: "Review the held group admission without changing files.",
					agent_kind: "review",
					fork_turns: "none",
					expected_output: ["A verified report"],
				},
			])
			// If the baseline incorrectly launches after the first status oracle fails,
			// cleanup still has a finite scripted request instead of an unknown producer.
			const fallbackTurn = harness.queueTurn(prepared.envelopes[0].id, "Unexpected baseline launch cleanup")
			releases.push(fallbackTurn.release)
			const held = deferred()
			const entered = deferred()
			releases.push(held.resolve)
			const target = harness.provider as unknown as {
				ensurePreparedSubagentControlRecords(...args: unknown[]): Promise<unknown>
			}
			const actual = target.ensurePreparedSubagentControlRecords
			vi.spyOn(target, "ensurePreparedSubagentControlRecords").mockImplementationOnce(async (...args) => {
				const result = await Reflect.apply(actual, harness.provider, args)
				entered.resolve()
				await held.promise
				return result
			})
			const originalSignal = task.getTaskLifetimeCancellationSignal()
			const launching = harness.provider.launchPreparedSubagentGroup(task, prepared, originalSignal)
			const launched = Promise.allSettled([launching])
			pending.push(launching)
			await entered.promise
			const record = (
				Reflect.get(harness.provider, "subagentRunFinalizations") as Map<
					string,
					{ readonly admissionController?: AbortController }
				>
			).get(prepared.envelopes[0].id)
			const replacement = replace ? callbackReplacement(task, step) : undefined
			if (replacement && record?.admissionController) {
				record.admissionController.signal.addEventListener("abort", replacement.install, { once: true })
			}
			const created = vi.fn()
			harness.provider.on(AlphaCodeEventName.TaskCreated, created)
			let settled = false
			const cancelling = harness.provider.cancelSubagentGroup(task.taskId, prepared.group.groupId)
			pending.push(cancelling)
			void cancelling.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)
			// Existing public state is the first oracle; no new method/property is required to fail it on baseline.
			expect(prepared.group.status).toBe("cancelling")
			expect(settled).toBe(false)
			expect(record?.admissionController?.signal.aborted).toBe(true)
			if (replacement) replacement.expectPreserved()
			held.resolve()
			const [outcome] = await launched
			expect(outcome.status).toBe("rejected")
			if (outcome.status === "rejected") expect(outcome.reason).toBe(record?.admissionController?.signal.reason)
			await cancelling
			expect(prepared.group.status).toBe("cancelled")
			expect(created).not.toHaveBeenCalled()
			expect(harness.store.getAgent(prepared.envelopes[0].id)?.status).toBe("cancelled")
			expect(originalSignal.aborted).toBe(false)
			if (replacement) {
				replacement.expectPreserved()
				replacement.dispose()
				replacement.release()
			}
		},
	)
})
