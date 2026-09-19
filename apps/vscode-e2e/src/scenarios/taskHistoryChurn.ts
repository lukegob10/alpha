import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"

import {
	AlphaCodeEventName,
	agentControlStateSchema,
	type AlphaCodeAPI,
	type AlphaCodeSettings,
	type AlphaMessage,
	type HistoryItem,
} from "@alpha-code/types"

import { measureTaskHistoryMirror, TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES } from "../evidence/storageRestart"
import {
	TASK_HISTORY_CHURN_WORKLOAD,
	taskHistoryChurnTaskIdsSha256,
	type TaskHistoryChurnPhase,
	type TaskHistoryChurnRunProjection,
} from "../evidence/taskHistoryChurn"

export const TASK_HISTORY_CHURN_ROOT_TEXT_PREFIX = "Task-history churn root "
export const TASK_HISTORY_CHURN_CHILD_OBJECTIVE_PREFIX = "Task-history churn managed child "

export interface TaskHistoryChurnAIChunk {
	type: "text" | "tool_call" | "usage"
	text?: string
	id?: string
	name?: string
	arguments?: string
	inputTokens?: number
	outputTokens?: number
	totalCost?: number
}

export interface TaskHistoryChurnTask {
	taskAsk?: { ask?: string }
	approveAsk(): void
	waitForTermination(): Promise<void>
}

export interface TaskHistoryChurnProvider {
	taskHistoryStoreReady?: Promise<void>
	flushGlobalStateWriteThrough?: () => Promise<void>
	agentControlStore: { persistence: { filePath: string } }
	getLiveTask(taskId: string): TaskHistoryChurnTask | undefined
	getTaskWithId(taskId: string): Promise<{ historyItem: HistoryItem }>
}

export interface TaskHistoryChurnGlobalState {
	get<T>(key: string): T | undefined
}

export interface TaskHistoryChurnRunResult extends TaskHistoryChurnRunProjection {
	requests: number
}

function textOfBytes(prefix: string, bytes: number): string {
	const prefixBytes = Buffer.byteLength(prefix, "utf8")
	assert.ok(prefixBytes <= bytes, `Churn prefix exceeds requested ${bytes}-byte workload`)
	return `${prefix}${"x".repeat(bytes - prefixBytes)}`
}

export function makeTaskHistoryChurnRootText(index: number): string {
	return textOfBytes(`${TASK_HISTORY_CHURN_ROOT_TEXT_PREFIX}${index}: `, TASK_HISTORY_CHURN_WORKLOAD.rootPromptBytes)
}

export function makeTaskHistoryChurnChildObjective(index: number): string {
	return textOfBytes(
		`${TASK_HISTORY_CHURN_CHILD_OBJECTIVE_PREFIX}${index}: `,
		TASK_HISTORY_CHURN_WORKLOAD.childObjectiveBytes,
	)
}

export class TaskHistoryChurnAI {
	readonly id = "task-history-churn-scripted"
	requests = 0
	private readonly turnsByTask = new Map<string, number>()
	private readonly childTaskIds = new Set<string>()
	private readonly childObjective = makeTaskHistoryChurnChildObjective(0)

	registerManagedChild(taskId: string): void {
		this.childTaskIds.add(taskId)
	}

	async *createMessage(
		_systemPrompt: string,
		_messages: unknown[],
		metadata?: { taskId?: string },
	): AsyncGenerator<TaskHistoryChurnAIChunk> {
		const taskId = metadata?.taskId
		if (!taskId) throw new Error("Task-history churn request is missing metadata.taskId")
		const turn = this.turnsByTask.get(taskId) ?? 0
		this.turnsByTask.set(taskId, turn + 1)
		this.requests++

		if (this.childTaskIds.has(taskId)) {
			if (turn !== 0) throw new Error(`Managed churn child ${taskId} requested more than one turn`)
			yield { type: "text", text: "Managed churn child completed." }
		} else if (turn === 0) {
			yield {
				type: "tool_call",
				id: `task-history-churn-spawn-${taskId}`,
				name: "spawn_agent",
				arguments: JSON.stringify({
					task_name: "history_churn_child",
					fork_turns: "none",
					objective: this.childObjective,
					agent_kind: "explore",
					expected_output: ["A bounded managed-child churn acknowledgement."],
				}),
			}
		} else if (turn === 1) {
			yield {
				type: "tool_call",
				id: `task-history-churn-wait-${taskId}`,
				name: "wait_agent",
				arguments: JSON.stringify({ target: "history_churn_child", until_terminal: true, timeout_ms: 90_000 }),
			}
		} else if (turn === 2) {
			yield { type: "text", text: "Task-history churn root completed." }
		} else {
			throw new Error(`Churn root ${taskId} requested more than three turns`)
		}
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 128_000,
				maxTokens: 8_192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	description: string,
	options: { timeoutMs?: number; maxAttempts?: number; waitForNextAttempt?: () => Promise<void> } = {},
): Promise<void> {
	const deadline = Date.now() + (options.timeoutMs ?? 90_000)
	let attempts = 0
	while (Date.now() < deadline && (options.maxAttempts === undefined || attempts < options.maxAttempts)) {
		attempts++
		if (await predicate()) return
		if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) break
		if (options.waitForNextAttempt) await options.waitForNextAttempt()
		else await new Promise((resolve) => setTimeout(resolve, 25))
	}
	throw new Error(`Timed out waiting for ${description}`)
}

function assertHistoryIdentity(historyItem: HistoryItem, taskId: string, parentTaskId: string): void {
	assert.equal(historyItem.id, taskId)
	assert.equal(historyItem.taskKind, "subagent")
	assert.equal(historyItem.parentTaskId, parentTaskId)
	assert.equal(historyItem.rootTaskId, parentTaskId)
	assert.equal(historyItem.status, "completed")
}

export interface TaskHistoryChurnWaitOptions {
	timeoutMs?: number
	maxAttempts?: number
	waitForNextAttempt?: () => Promise<void>
}

export async function waitForCompletedHistory(
	provider: Pick<TaskHistoryChurnProvider, "getTaskWithId">,
	taskId: string,
	description: string,
	accept: (historyItem: HistoryItem) => boolean,
	options: TaskHistoryChurnWaitOptions = {},
): Promise<HistoryItem> {
	let latest: HistoryItem | undefined
	await waitForCondition(
		async () => {
			try {
				latest = (await provider.getTaskWithId(taskId)).historyItem
				return accept(latest)
			} catch (error) {
				if (error instanceof Error && error.message === "Task not found") return false
				throw error
			}
		},
		description,
		options,
	)
	assert.ok(latest, `The completed history item must be readable for ${taskId}`)
	return latest
}

type DurableAgentControlState = ReturnType<typeof agentControlStateSchema.parse>

async function readDurableAgentControlState(
	provider: TaskHistoryChurnProvider,
): Promise<DurableAgentControlState | undefined> {
	try {
		const serialized = await fs.readFile(provider.agentControlStore.persistence.filePath, "utf8")
		return agentControlStateSchema.parse(JSON.parse(serialized))
	} catch (error) {
		// AgentControlStore replaces the file atomically. Only initial absence is
		// retryable; malformed or schema-invalid durable state must fail the proof.
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return undefined
		}
		throw error
	}
}

async function assertDurableManagedChildCompletion(
	provider: TaskHistoryChurnProvider,
	childTaskId: string,
	rootTaskId: string,
): Promise<void> {
	await waitForCondition(async () => {
		const state = await readDurableAgentControlState(provider)
		const record = state?.agents.find((agent) => agent.taskId === childTaskId)
		const resultEvents =
			state?.mailbox.filter(
				(event) =>
					event.kind === "result" &&
					event.name === "agent_completed" &&
					event.rootTaskId === rootTaskId &&
					event.senderTaskId === childTaskId &&
					event.recipientTaskId === rootTaskId,
			) ?? []
		return (
			record?.parentTaskId === rootTaskId &&
			record.rootTaskId === rootTaskId &&
			record.status === "completed" &&
			record.terminalResult?.status === "completed" &&
			resultEvents.length === 1
		)
	}, `durable managed-child completion for ${childTaskId}`)

	const state = await readDurableAgentControlState(provider)
	assert.ok(state, `The canonical agent-control state must be readable for ${childTaskId}`)
	const record = state.agents.find((agent) => agent.taskId === childTaskId)
	assert.ok(record, `The canonical agent-control state must retain ${childTaskId}`)
	assert.equal(record.parentTaskId, rootTaskId)
	assert.equal(record.rootTaskId, rootTaskId)
	assert.equal(record.status, "completed")
	assert.equal(record.terminalResult?.status, "completed")
	const resultEvents = state.mailbox.filter(
		(event) =>
			event.kind === "result" &&
			event.name === "agent_completed" &&
			event.rootTaskId === rootTaskId &&
			event.senderTaskId === childTaskId &&
			event.recipientTaskId === rootTaskId,
	)
	assert.equal(resultEvents.length, 1, `Exactly one durable terminal result is required for ${childTaskId}`)
	assert.equal(resultEvents[0]?.payload?.taskId, childTaskId)
	assert.equal(resultEvents[0]?.payload?.status, "completed")
}

/**
 * Run repeated root/managed-child tasks through the public task owner and flush the real memento.
 * The returned projection is deliberately content-free so callers can publish it across host boundaries.
 */
export async function runTaskHistoryChurnWorkload(options: {
	phase: TaskHistoryChurnPhase
	api: AlphaCodeAPI
	provider: TaskHistoryChurnProvider
	globalState: TaskHistoryChurnGlobalState
}): Promise<TaskHistoryChurnRunResult> {
	const { api, provider, globalState } = options
	if (!provider.taskHistoryStoreReady || !provider.flushGlobalStateWriteThrough) {
		throw new Error("The task-history owner does not expose its initialized write-through boundary")
	}
	await provider.taskHistoryStoreReady
	const before = measureTaskHistoryMirror(globalState)
	const mirrorSamples = []
	const model = new TaskHistoryChurnAI()
	const configuration: AlphaCodeSettings = {
		...api.getConfiguration(),
		apiProvider: "fake-ai",
		fakeAi: model,
		mode: "code",
		disabledTools: [],
		mcpEnabled: false,
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowSubagents: true,
		alwaysAllowFollowupQuestions: false,
		enableCheckpoints: false,
		requestDelaySeconds: 0,
		writeDelayMs: 0,
		maxConcurrentTasks: 2,
		maxConcurrentSubagents: 1,
		subagentDelegationPolicy: "proactive",
		subagentMaxDepth: 1,
	}
	const completed = new Set<string>()
	const childIdsByRoot = new Map<string, string>()
	const onCompleted = (taskId: string) => {
		completed.add(taskId)
	}
	const onMessage = (event: { taskId: string; action: "created" | "updated"; message: AlphaMessage }) => {
		if (event.message.say !== "subagent_group" || !event.message.subagentGroup) return
		const [child] = event.message.subagentGroup.agents
		if (!child) return
		model.registerManagedChild(child.taskId)
		childIdsByRoot.set(event.taskId, child.taskId)
	}
	const onSpawned = (parentTaskId: string, childTaskId: string) => {
		model.registerManagedChild(childTaskId)
		childIdsByRoot.set(parentTaskId, childTaskId)
	}
	api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
	api.on(AlphaCodeEventName.Message, onMessage)
	api.on(AlphaCodeEventName.TaskSpawned, onSpawned)
	try {
		await api.setConfiguration(configuration)
		const rootTaskIds: string[] = []
		const managedChildTaskIds: string[] = []
		const managedChildParentTaskIds: string[] = []
		for (let index = 0; index < TASK_HISTORY_CHURN_WORKLOAD.rootCount; index++) {
			const rootTaskId = await api.startNewTask({
				configuration,
				text: makeTaskHistoryChurnRootText(index),
			})
			rootTaskIds.push(rootTaskId)
			await waitForCondition(() => childIdsByRoot.has(rootTaskId), `managed child for churn root ${index}`)
			let originalRootTask: TaskHistoryChurnTask | undefined
			await waitForCondition(() => {
				originalRootTask = provider.getLiveTask(rootTaskId)
				return originalRootTask !== undefined
			}, `live root task for churn root ${index}`)
			const childTaskId = childIdsByRoot.get(rootTaskId)!
			managedChildTaskIds.push(childTaskId)
			managedChildParentTaskIds.push(rootTaskId)
			await waitForCondition(async () => {
				const rootTask = provider.getLiveTask(rootTaskId)
				if (rootTask?.taskAsk?.ask === "completion_result") rootTask.approveAsk()
				return completed.has(childTaskId) && completed.has(rootTaskId)
			}, `completion of churn root ${index}`)
			await originalRootTask!.waitForTermination()
			const rootHistory = await waitForCompletedHistory(
				provider,
				rootTaskId,
				`durable history for churn root ${index}`,
				(historyItem) =>
					historyItem.id === rootTaskId &&
					historyItem.taskKind === "primary" &&
					historyItem.status === "completed",
			)
			assert.equal(rootHistory.id, rootTaskId)
			assert.equal(rootHistory.taskKind, "primary")
			assert.equal(rootHistory.status, "completed")
			const childHistory = await waitForCompletedHistory(
				provider,
				childTaskId,
				`durable history for churn child ${index}`,
				(historyItem) =>
					historyItem.id === childTaskId &&
					historyItem.taskKind === "subagent" &&
					historyItem.parentTaskId === rootTaskId &&
					historyItem.rootTaskId === rootTaskId &&
					historyItem.status === "completed",
			)
			assertHistoryIdentity(childHistory, childTaskId, rootTaskId)
			await provider.flushGlobalStateWriteThrough()
			await assertDurableManagedChildCompletion(provider, childTaskId, rootTaskId)
			const currentMirror = measureTaskHistoryMirror(globalState)
			assert.equal(currentMirror.withinBudget, true)
			mirrorSamples.push(currentMirror)
		}
		await provider.flushGlobalStateWriteThrough()
		const after = measureTaskHistoryMirror(globalState)
		assert.equal(before.withinBudget && after.withinBudget, true)
		assert.equal(
			model.requests,
			TASK_HISTORY_CHURN_WORKLOAD.rootCount * 3 + TASK_HISTORY_CHURN_WORKLOAD.childCount,
			"The churn workload must issue exactly three root and one child request per root",
		)
		return {
			phase: options.phase,
			rootTaskIds,
			managedChildTaskIds,
			managedChildParentTaskIds,
			taskIdsSha256: taskHistoryChurnTaskIdsSha256(rootTaskIds, managedChildTaskIds),
			taskHistoryMirror: {
				key: "taskHistory",
				budgetBytes: TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
				before,
				after,
				samples: mirrorSamples,
				maxBytes: Math.max(before.bytes, after.bytes, ...mirrorSamples.map((sample) => sample.bytes)),
				withinBudget: true,
			},
			requests: model.requests,
		}
	} finally {
		api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
		api.off(AlphaCodeEventName.Message, onMessage)
		api.off(AlphaCodeEventName.TaskSpawned, onSpawned)
	}
}
