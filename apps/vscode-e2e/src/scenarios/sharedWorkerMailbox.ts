import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import type {
	AlphaCodeAPI,
	AlphaCodeSettings,
	AgentMailboxEntry,
	AgentRecord,
	AgentControlState,
	SubagentGroupState,
	SubagentSpawnHandle,
} from "@alpha-code/types"
import {
	publish,
	failureCode,
	failureSite,
	readOptional,
	record,
	waitUntil,
	type PairManifest,
	type HostIdentity,
} from "../evidence/sharedStorageProtocol"
import {
	resultIdentity,
	validateWorkerIdentity,
	validateWorkerResult,
	type WorkerIdentity,
	type WorkerResultIdentity,
} from "../evidence/sharedWorkerMailbox"

const execFile = promisify(execFileCallback)
interface WorkerTask {
	taskId: string
	getTaskLifetimeCancellationSignal(): AbortSignal
	waitForTermination(): Promise<void>
}
interface WorkerStore {
	getAgent(target: string, rootTaskId: string): AgentRecord | undefined
	getSnapshot(): AgentControlState
	getUnacknowledgedMailboxEntries(
		recipient: string,
		options: { rootTaskId: string; kinds: ["result"] },
	): AgentMailboxEntry[]
	claimMailbox(
		recipient: string,
		options: { rootTaskId: string; channel: "wait"; claimId: string; kinds: ["result"]; payloadTaskIds: string[] },
	): Promise<{ entries: AgentMailboxEntry[] }>
	acknowledgeMailboxClaim(recipient: string, claimId: string, rootTaskId: string): Promise<unknown>
}
export interface SharedWorkerProvider {
	agentControlStore: WorkerStore
	getLiveTask(taskId: string): WorkerTask | undefined
	prepareSubagentGroup(
		parent: WorkerTask,
		drafts: unknown[],
	): Promise<{ group: SubagentGroupState; requiresExplicitApproval?: boolean }>
	launchPreparedSubagentGroup(
		parent: WorkerTask,
		prepared: { group: SubagentGroupState; requiresExplicitApproval?: boolean },
		signal: AbortSignal,
	): Promise<SubagentSpawnHandle>
	interruptAgent(parent: WorkerTask, target: string): Promise<unknown>
	requiresExplicitAgentFollowupApproval(parent: WorkerTask, target: string): Promise<boolean>
	followupAgentTask(parent: WorkerTask, target: string, message: string): Promise<unknown>
	cancelAgent(parent: WorkerTask, target: string): Promise<unknown>
	closeAgent(parent: WorkerTask, target: string): Promise<unknown>
	removeTaskFromStack(options: { taskId: string; requireAbortSuccess: true }): Promise<void>
}

/** Close the owned root without cancelTask's user-facing profile rehydration. */
export async function stopSharedWorkerRoot(
	provider: Pick<SharedWorkerProvider, "removeTaskFromStack">,
	parent: WorkerTask,
) {
	await provider.removeTaskFromStack({ taskId: parent.taskId, requireAbortSuccess: true })
	await parent.waitForTermination()
}
interface RequestObservation {
	aborted: boolean
	settled: boolean
}
type Chunk =
	| { type: "text"; text: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }
/** Holds actual provider requests using their own cancellation signals; no fake mailbox events. */
export class SharedWorkerAI {
	removeFromCache?: () => void
	readonly requests = new Map<string, RequestObservation[]>()
	private readonly children = new Set<string>()
	private readonly releases = new Set<() => void>()
	constructor(readonly id: string) {}
	registerWorker(taskId: string) {
		this.children.add(taskId)
	}
	async *createMessage(
		_system: string,
		_messages: unknown[],
		metadata?: { taskId?: string; signal?: AbortSignal },
	): AsyncGenerator<Chunk> {
		const taskId = metadata?.taskId
		const signal = metadata?.signal
		assert.ok(taskId && signal, "Shared Worker fixture requires task identity and cancellation signal")
		const observations = this.requests.get(taskId) ?? []
		const observation = { aborted: false, settled: false }
		observations.push(observation)
		this.requests.set(taskId, observations)
		assert.ok(
			observations.length <= (this.children.has(taskId) ? 2 : 1),
			"Unexpected shared Worker provider request",
		)
		const onAbort = () => {
			observation.aborted = true
		}
		signal.addEventListener("abort", onAbort, { once: true })
		try {
			if (signal.aborted) {
				onAbort()
				signal.throwIfAborted()
			}
			if (this.children.has(taskId) && observations.length === 2) {
				yield {
					type: "text",
					text: "The same Worker completed its follow-up without changing the fixture baseline.",
				}
			} else {
				yield { type: "text", text: "Shared Worker fixture request held at its observable barrier." }
				await new Promise<void>((resolve) => {
					const release = () => {
						this.releases.delete(release)
						signal.removeEventListener("abort", release)
						resolve()
					}
					this.releases.add(release)
					if (signal.aborted) {
						onAbort()
						release()
					} else signal.addEventListener("abort", release, { once: true })
				})
				signal.throwIfAborted()
			}
			yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
		} finally {
			observation.settled = true
			signal.removeEventListener("abort", onAbort)
		}
	}
	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 128000,
				maxTokens: 8192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}
	async countTokens(content: unknown[]) {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}
	async completePrompt() {
		return ""
	}
	dispose() {
		for (const release of this.releases) release()
		this.releases.clear()
	}
}
async function prepareWorkspace(workspace: string) {
	await fs.mkdir(path.join(workspace, ".alpha-shared-worker"), { recursive: true })
	await fs.writeFile(
		path.join(workspace, ".alpha-shared-worker", "baseline.txt"),
		"Shared Worker fixture baseline.\n",
	)
	try {
		await execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: workspace, windowsHide: true })
	} catch {
		await execFile("git", ["init"], { cwd: workspace, windowsHide: true })
	}
	await execFile("git", ["add", "-f", "--", ".alpha-shared-worker"], { cwd: workspace, windowsHide: true })
	const staged = await execFile("git", ["diff", "--cached", "--name-only"], { cwd: workspace, windowsHide: true })
	if (staged.stdout.trim())
		await execFile(
			"git",
			[
				"-c",
				"user.name=Alpha E2E",
				"-c",
				"user.email=alpha-e2e@local.invalid",
				"commit",
				"-m",
				"Shared Worker fixture baseline",
			],
			{ cwd: workspace, windowsHide: true },
		)
}

export async function exerciseSharedWorkerMailbox(options: {
	api: AlphaCodeAPI
	provider: SharedWorkerProvider
	manifest: PairManifest
	identity: HostIdentity
	directory: string
	waitPhase: (name: string) => Promise<void>
}) {
	const { api, provider, manifest, identity, directory, waitPhase } = options
	assert.equal(manifest.sharedWorkerMailbox, 1)
	await waitPhase("worker-start")
	await prepareWorkspace(manifest.roles[identity.role].workspace)
	const model = new SharedWorkerAI(`shared-worker-${manifest.nonce}-${identity.role}`)
	const previous = api.getConfiguration()
	const configuration: AlphaCodeSettings = {
		...previous,
		apiProvider: "fake-ai",
		fakeAi: model,
		mode: "code",
		disabledTools: [],
		autoApprovalEnabled: true,
		alwaysAllowSubagents: true,
		alwaysAllowSubtasks: false,
		alwaysAllowFollowupQuestions: false,
		// Worker auto-admission requires read/write authority within this owned fixture scope.
		alwaysAllowReadOnly: true,
		alwaysAllowWrite: true,
		alwaysAllowExecute: false,
		mcpEnabled: false,
		requestDelaySeconds: 0,
		writeDelayMs: 0,
		enableCheckpoints: false,
		maxConcurrentTasks: 2,
		maxConcurrentSubagents: 1,
		subagentDelegationPolicy: "proactive",
		subagentMaxDepth: 1,
		subagentRoleTimeoutsMs: { worker: 180000 },
		subagentRootTokenBudget: null,
		subagentRootCostBudget: null,
	}
	let parent: WorkerTask | undefined
	let stopped = false
	let failure: unknown
	let phase = "configuration"
	const until = (check: () => Promise<boolean> | boolean, code: string) =>
		waitUntil(async () => check(), manifest.deadline, code)
	try {
		await api.setConfiguration(configuration)
		const rootTaskId = await api.startNewTask({
			configuration,
			text: "Hold this root while its explicitly authorized proactive Worker is tested across the two owned hosts.",
		})
		phase = "worker_launch"
		await until(() => model.requests.has(rootTaskId), "worker_root_not_entered")
		parent = provider.getLiveTask(rootTaskId)
		assert.ok(parent)
		const prepared = await provider.prepareSubagentGroup(parent, [
			{
				task_name: `shared_worker_${identity.role}`,
				fork_turns: "none",
				agent_kind: "worker",
				objective: "Hold for parent interruption or completion without changing the baseline.",
				write_scope: [".alpha-shared-worker"],
			},
		])
		assert.notEqual(prepared.requiresExplicitApproval, true, "Proactive fixture must not fabricate approval")
		const workerTaskId = prepared.group.agents[0]?.taskId
		assert.ok(workerTaskId)
		model.registerWorker(workerTaskId)
		const handle = await provider.launchPreparedSubagentGroup(
			parent,
			prepared,
			parent.getTaskLifetimeCancellationSignal(),
		)
		assert.equal(handle.taskId, workerTaskId)
		await until(
			() =>
				model.requests.has(workerTaskId) &&
				provider.agentControlStore.getAgent(workerTaskId, rootTaskId)?.status === "running",
			"worker_not_entered",
		)
		const worker = provider.getLiveTask(workerTaskId)
		assert.ok(worker)
		const initialRecord = provider.agentControlStore.getAgent(workerTaskId, rootTaskId)
		assert.ok(initialRecord)
		assert.equal(initialRecord.status, "running")
		assert.equal(initialRecord.role, "worker")
		assert.equal(initialRecord.parentTaskId, rootTaskId)
		const own: WorkerIdentity = { ...identity, rootTaskId, workerTaskId, workerPath: initialRecord.path }
		const receipt = { ...own, sharedWorkerMailbox: 1 }
		await publish(directory, `worker-ready-${identity.role}.json`, receipt)
		await waitPhase("worker-interrupt")
		phase = "interruption_and_followup"
		let interruptedEventId: string | undefined
		let result: WorkerResultIdentity
		if (identity.role === "a") {
			await provider.interruptAgent(parent, workerTaskId)
			await until(
				() =>
					provider.agentControlStore.getAgent(workerTaskId, rootTaskId)?.status === "interrupted" &&
					model.requests.get(workerTaskId)?.[0]?.aborted === true,
				"worker_interrupt_failed",
			)
			await worker.waitForTermination()
			const interrupted = provider.agentControlStore
				.getUnacknowledgedMailboxEntries(rootTaskId, { rootTaskId, kinds: ["result"] })
				.filter((entry) => entry.payload?.taskId === workerTaskId)
			assert.equal(interrupted.length, 1)
			assert.equal(interrupted[0]!.senderTaskId, workerTaskId)
			assert.equal(interrupted[0]!.recipientTaskId, rootTaskId)
			interruptedEventId = interrupted[0]!.eventId
			const interruptionClaim = `${manifest.nonce}-worker-interruption`
			const consumed = await provider.agentControlStore.claimMailbox(rootTaskId, {
				rootTaskId,
				channel: "wait",
				claimId: interruptionClaim,
				kinds: ["result"],
				payloadTaskIds: [workerTaskId],
			})
			assert.deepEqual(
				consumed.entries.map((entry) => entry.eventId),
				[interruptedEventId],
			)
			await provider.agentControlStore.acknowledgeMailboxClaim(rootTaskId, interruptionClaim, rootTaskId)
			assert.equal(await provider.requiresExplicitAgentFollowupApproval(parent, workerTaskId), false)
			const followup = record(
				await provider.followupAgentTask(
					parent,
					workerTaskId,
					"Complete the same Worker task without changing the baseline.",
				),
			)
			assert.equal(followup.taskId, workerTaskId)
			await until(
				() =>
					model.requests.get(workerTaskId)?.length === 2 &&
					provider.agentControlStore.getAgent(workerTaskId, rootTaskId)?.status === "completed",
				"worker_followup_failed",
			)
			assert.equal(provider.agentControlStore.getAgent(workerTaskId, rootTaskId)?.path, initialRecord.path)
			const results = provider.agentControlStore
				.getUnacknowledgedMailboxEntries(rootTaskId, { rootTaskId, kinds: ["result"] })
				.filter((entry) => entry.payload?.taskId === workerTaskId)
			assert.equal(results.length, 1)
			result = resultIdentity(results[0]!, own)
			await publish(directory, "worker-result-a.json", {
				...receipt,
				result,
				interruptedEventId,
				followupTaskId: workerTaskId,
			})
		} else {
			await until(
				async () => (await readOptional(directory, "worker-result-a.json")) !== undefined,
				"worker_result_missing",
			)
			const a = record(await readOptional(directory, "worker-result-a.json"))
			const owner = validateWorkerIdentity(a, manifest, "a")
			result = validateWorkerResult(a.result, owner)
			assert.strictEqual(provider.getLiveTask(workerTaskId), worker)
			assert.equal(provider.agentControlStore.getAgent(workerTaskId, rootTaskId)?.status, "running")
			assert.equal(model.requests.get(workerTaskId)?.[0]?.aborted, false)
			assert.equal(model.requests.get(workerTaskId)?.[0]?.settled, false)
			await publish(directory, "worker-result-b.json", {
				...receipt,
				result,
				uninterrupted: true,
				requestCount: model.requests.get(workerTaskId)!.length,
			})
		}
		await waitPhase("worker-claim")
		phase = "result_claim"
		const claimId = `${manifest.nonce}-worker-${identity.role}`
		const claimOptions = {
			rootTaskId: result.rootTaskId,
			channel: "wait" as const,
			claimId,
			kinds: ["result"] as ["result"],
			payloadTaskIds: [result.payloadTaskId],
		}
		let outcome: "claimed" | "empty" | "ownership_denied"
		let eventIds: string[] = []
		try {
			const claim = await provider.agentControlStore.claimMailbox(result.recipientTaskId, claimOptions)
			eventIds = claim.entries.map((entry) => entry.eventId)
			assert.ok(eventIds.length === 0 || (eventIds.length === 1 && eventIds[0] === result.eventId))
			outcome = eventIds.length ? "claimed" : "empty"
		} catch (error) {
			assert.ok(
				error instanceof Error &&
					(error.message ===
						`Agent tree ${result.rootTaskId} is owned by another live extension host and this host cannot claim its mailbox` ||
						error.message ===
							`Agent tree ${result.rootTaskId} has a mailbox claim owned by another live extension host and this host cannot claim its mailbox`),
			)
			outcome = "ownership_denied"
		}
		await publish(directory, `worker-claimed-${identity.role}.json`, {
			...receipt,
			result,
			claimId,
			outcome,
			eventIds,
		})
		await waitPhase("worker-ack")
		phase = "result_acknowledgement"
		if (outcome === "claimed") {
			await provider.agentControlStore.acknowledgeMailboxClaim(result.recipientTaskId, claimId, result.rootTaskId)
			await publish(directory, "worker-acked.json", { ...receipt, result, claimId })
		}
		await waitPhase("worker-acked")
		let retryCount = 0
		let retryOutcome: "empty" | "ownership_denied" = "empty"
		try {
			const retry = await provider.agentControlStore.claimMailbox(result.recipientTaskId, {
				...claimOptions,
				claimId: `${claimId}-retry`,
			})
			retryCount = retry.entries.length
			assert.equal(retryCount, 0)
		} catch (error) {
			// An active foreign root still refuses ownership; its durable ACK is verified by the controller.
			assert.equal(identity.role, "b")
			assert.ok(
				error instanceof Error &&
					error.message ===
						`Agent tree ${result.rootTaskId} is owned by another live extension host and this host cannot claim its mailbox`,
			)
			retryOutcome = "ownership_denied"
		}
		await publish(directory, `worker-verified-${identity.role}.json`, {
			...receipt,
			result,
			retryCount,
			retryOutcome,
		})
		await waitPhase("worker-close")
		phase = "worker_close"
		if (identity.role === "b") {
			await provider.cancelAgent(parent, workerTaskId)
			await until(
				() => provider.agentControlStore.getAgent(workerTaskId, rootTaskId)?.status === "cancelled",
				"worker_cancel_failed",
			)
			await worker.waitForTermination()
			assert.equal(model.requests.get(workerTaskId)?.[0]?.aborted, true)
		}
		await provider.closeAgent(parent, workerTaskId)
		assert.equal(provider.agentControlStore.getAgent(workerTaskId, rootTaskId), undefined)
		assert.equal(
			provider.agentControlStore
				.getSnapshot()
				.agents.filter((agent) => agent.rootTaskId === rootTaskId && agent.role !== "root").length,
			0,
		)
		phase = "root_stop"
		await stopSharedWorkerRoot(provider, parent)
		stopped = true
		assert.equal(model.requests.get(rootTaskId)?.[0]?.aborted, true)
		await publish(directory, `worker-done-${identity.role}.json`, {
			...receipt,
			result,
			interruptedEventId,
			requests: [...model.requests.values()].reduce((total, list) => total + list.length, 0),
			activeChildrenAfterClose: 0,
			closed: true,
			rootStopped: true,
		})
	} catch (error) {
		failure = error
		await publish(directory, `worker-failure-${identity.role}.json`, {
			...identity,
			phase,
			code: failureCode(error),
			site: failureSite(error),
			requests: [...model.requests.values()].reduce((total, list) => total + list.length, 0),
		}).catch(() => undefined)
	} finally {
		for (const cleanup of [
			async () => {
				if (parent && !stopped) {
					await stopSharedWorkerRoot(provider, parent)
				}
			},
			async () => {
				model.dispose()
				model.removeFromCache?.()
			},
			async () => {
				await api.setConfiguration(previous)
			},
		]) {
			try {
				await cleanup()
			} catch (error) {
				failure ??= error
			}
		}
	}
	if (failure) throw failure
}
