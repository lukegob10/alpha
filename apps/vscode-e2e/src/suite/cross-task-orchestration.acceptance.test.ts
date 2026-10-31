import * as assert from "assert"
import * as vscode from "vscode"
import { readFile } from "node:fs/promises"

import {
	AlphaCodeEventName,
	alphaMessageSchema,
	type AlphaCodeSettings,
	type AlphaMessage,
	type ExtensionState,
	type HistoryItem,
	type ThreadListResult,
	type ThreadReadResult,
	type ThreadWaitResult,
} from "@alpha-code/types"

import { waitFor, waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"
import { assertFeatureTicketListResult } from "../scenarios/featureWorkflowFixture"

import {
	COLLECT_CHILD_RESULTS,
	ConcurrentThreadsAI,
	findLatestToolResult,
	type ScriptChunk,
} from "../scenarios/concurrentThreadsFixture"

interface CrossTaskHostProvider {
	closeTask(taskId: string): Promise<void>
	createIndependentTask(
		parent: HostTask,
		objective: string,
		workspaceMode: "shared",
		signal: undefined,
		options: { notifyOnCompletion: true },
	): Promise<{ task_id: string }>
	createTask(
		text: string,
		images: undefined,
		history: undefined,
		options: { preserveExisting: true; background: true; apiConfiguration: AlphaCodeSettings },
		configuration: AlphaCodeSettings,
	): Promise<HostTask>
	removeTaskFromStack(options: { taskId: string; requireAbortSuccess: true }): Promise<void>
	getLiveTask(taskId: string): HostTask | undefined
	getTaskWithId(
		taskId: string,
		options?: { includeApiConversationHistory?: boolean },
	): Promise<{
		historyItem: HistoryItem
		uiMessagesFilePath: string
		apiConversationHistory: unknown[]
	}>
	getStateToPostToWebview(): Promise<ExtensionState>
	listIndependentTasks(parent: HostTask): Promise<
		Array<{
			task_id: string
			objective: string
			lifecycle: string
			workspace_mode: string
		}>
	>
}

interface HostTask {
	taskId: string
	alphaMessages: AlphaMessage[]
	taskAsk?: AlphaMessage
	abort: boolean
	didComplete: boolean
	approveAsk(): void
	submitUserMessage(text: string): Promise<void>
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

class CrossTaskAcceptanceAI {
	readonly id = "cross-task-acceptance-e2e"
	private static readonly states = new WeakMap<
		CrossTaskAcceptanceAI,
		{
			calls: Array<{ taskId: string; name: string }>
			rootTaskId?: string
			childTaskId?: string
			childTask?: HostTask
			childRequestStarted: boolean
			turns: Map<string, number>
			host?: CrossTaskHostProvider
		}
	>()

	constructor() {
		CrossTaskAcceptanceAI.states.set(this, { calls: [], childRequestStarted: false, turns: new Map() })
	}

	get calls(): Array<{ taskId: string; name: string }> {
		return CrossTaskAcceptanceAI.states.get(this)!.calls
	}

	private state() {
		return CrossTaskAcceptanceAI.states.get(this)!
	}

	setHost(host: CrossTaskHostProvider): void {
		this.state().host = host
	}

	async *createMessage(
		_system: string,
		messages: unknown[],
		metadata?: {
			taskId?: string
			signal?: AbortSignal
			tools?: Array<{ type?: string; function?: { name?: string } }>
		},
	): AsyncGenerator<ScriptChunk> {
		const taskId = metadata?.taskId
		assert.ok(taskId, "The scripted task request must carry metadata.taskId")
		const state = this.state()
		state.rootTaskId ??= taskId
		const turn = state.turns.get(taskId) ?? 0
		state.turns.set(taskId, turn + 1)
		let chunk: Exclude<ScriptChunk, { type: "usage" }>

		if (taskId !== state.rootTaskId) {
			assert.equal(turn, 0, "The child must pause in its first provider request")
			const signal = metadata?.signal
			assert.ok(signal, "The child provider request must carry a cancellation signal")
			state.childRequestStarted = true
			state.calls.push({ taskId, name: "child_pending" })
			await new Promise<void>((resolve) => {
				if (signal.aborted) return resolve()
				signal.addEventListener("abort", () => resolve(), { once: true })
			})
			return
		} else {
			switch (turn) {
				case 0:
					assert.ok(
						metadata?.tools?.some((tool) => tool.function?.name === "create_thread"),
						"The launch-thread request must expose create_thread to the model",
					)
					chunk = {
						type: "tool_call",
						id: `${taskId}-create-child`,
						name: "create_thread",
						arguments: JSON.stringify({ prompt: "Run until stopped" }),
					}
					break
				case 1: {
					const created = JSON.parse(findLatestToolResult(messages)) as { threadId: string }
					state.childTaskId = created.threadId
					state.childTask = state.host?.getLiveTask(created.threadId)
					await waitFor(() => state.childRequestStarted, {
						timeout: 10_000,
						interval: 20,
						description: "the child task provider request to start",
					})
					chunk = {
						type: "tool_call",
						id: `${taskId}-list-children`,
						name: "list_threads",
						arguments: "{}",
					}
					break
				}
				case 2: {
					const listed = JSON.parse(findLatestToolResult(messages)) as ThreadListResult
					assert.ok(listed.threads.some(({ id }) => id === state.childTaskId))
					chunk = {
						type: "tool_call",
						id: `${taskId}-stop-child`,
						name: "stop_task",
						arguments: JSON.stringify({
							task_id: state.childTaskId,
							reason: "Acceptance fixture complete",
						}),
					}
					break
				}
				case 3: {
					const stopped = JSON.parse(findLatestToolResult(messages)) as { status: string }
					assert.ok(["stopped", "stopping"].includes(stopped.status))
					chunk = {
						type: "tool_call",
						id: `${taskId}-wait-child`,
						name: "wait_threads",
						arguments: JSON.stringify({ targets: [{ threadId: state.childTaskId }], timeoutMs: 5_000 }),
					}
					break
				}
				case 4: {
					const waited = JSON.parse(findLatestToolResult(messages)) as ThreadWaitResult
					assert.ok(waited.wake, "The stopped task must produce an actionable wait snapshot")
					chunk = {
						type: "text",
						text: "Created, inspected, stopped, and verified the independent child task.",
					}
					break
				}
				default:
					throw new Error(`Unexpected parent model turn ${turn + 1}`)
			}
		}

		state.calls.push({ taskId, name: chunk.type === "tool_call" ? chunk.name : "assistant_text" })
		yield chunk
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 128_000, maxTokens: 8_192, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}

	getChildTaskId(): string | undefined {
		return this.state().childTaskId
	}

	getChildTask(): HostTask | undefined {
		return this.state().childTask
	}
}

const TICKET_HANDOFF_PROMPT =
	"Read Alpha parent ticket ALPHA-42 and all five child tickets; implement and verify their success criteria. Use subagents as needed."
const TICKET_HANDOFF_ACK = "Ready. What should I work on?"
const LAUNCHER_ONLY_NOTE = "HANDOFF_LAUNCHER_ONLY"

class CompletingChildAI {
	readonly id = "cross-task-completion-e2e"
	private rootTaskId?: string
	private turns = new Map<string, number>()
	private releaseChildRequest!: () => void
	private readonly childMayFinish = new Promise<void>((resolve) => {
		this.releaseChildRequest = resolve
	})
	childTaskId?: string
	sawChildResult = false
	childRequests = 0
	constructor(private readonly performLookup = false) {}

	get childResult(): string {
		return this.performLookup ? "Completed the assigned ticket lookup." : TICKET_HANDOFF_ACK
	}

	releaseChild(): void {
		this.releaseChildRequest()
	}

	async *createMessage(
		system: string,
		messages: unknown[],
		metadata?: {
			taskId?: string
			tools?: Array<{ type?: string; function?: { name?: string } }>
			instructionFragments?: readonly { role: string; origin?: string; content: string }[]
		},
	): AsyncGenerator<ScriptChunk> {
		const taskId = metadata?.taskId
		assert.ok(taskId)
		this.rootTaskId ??= taskId
		const turn = this.turns.get(taskId) ?? 0
		this.turns.set(taskId, turn + 1)
		if (taskId !== this.rootTaskId) {
			this.childRequests++
			assert.equal(turn, this.performLookup ? this.childRequests - 1 : 0)
			const assignment = metadata?.instructionFragments?.find(({ origin }) => origin === "alpha-task-assignment")
			assert.ok(assignment, "A created independent task must receive host-owned assignment context")
			assert.equal(assignment?.role, "developer", "The host must distinguish assigned work from ordinary mail")
			assert.ok(
				assignment.content.includes(JSON.stringify(this.rootTaskId)),
				"The handoff must retain its host-owned origin",
			)
			assert.ok(
				system.includes(assignment.content),
				"Flattened provider instructions must retain the same handoff",
			)
			const transcript = JSON.stringify(messages)
			assert.ok(
				transcript.includes(TICKET_HANDOFF_PROMPT),
				"The first request must retain the entire ticket assignment",
			)
			assert.ok(
				!transcript.includes(LAUNCHER_ONLY_NOTE),
				"A fresh thread must not copy the launcher's conversation",
			)
			for (const name of ["read_ticket", "spawn_agent"]) {
				assert.ok(
					metadata?.tools?.some((tool) => tool.function?.name === name),
					`${name} must remain available`,
				)
			}
			await this.childMayFinish
			if (this.performLookup) {
				if (turn === 0) {
					yield {
						type: "tool_call",
						id: `${taskId}-assigned-lookup`,
						name: "list_tickets",
						arguments: "{}",
					}
					yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
					return
				}
				assert.equal(turn, 1, "Assigned work must run once and complete without another wake")
				assertFeatureTicketListResult(messages, `${taskId}-assigned-lookup`)
			}
			// Codex 8801b9a8 (2026-10-30), core/src/session/turn.rs: an ordinary
			// response with no continuation may end its turn even when it is only an acknowledgement.
			yield { type: "text", text: this.childResult }
		} else if (turn === 0) {
			assert.ok(metadata?.tools?.some((tool) => tool.function?.name === "create_thread"))
			yield {
				type: "tool_call",
				id: `${taskId}-create-child`,
				name: "create_thread",
				arguments: JSON.stringify({ prompt: TICKET_HANDOFF_PROMPT, title: "Parent ticket and children" }),
			}
		} else if (turn === 1) {
			this.childTaskId = (JSON.parse(findLatestToolResult(messages)) as { threadId: string }).threadId
			yield {
				type: "tool_call",
				id: `${taskId}-wait-child`,
				name: "wait_threads",
				arguments: JSON.stringify({ targets: [{ threadId: this.childTaskId }], timeoutMs: 30_000 }),
			}
		} else if (turn === 2) {
			assert.ok(JSON.stringify(messages).includes(this.childResult), "The child result must reach the parent")
			this.sawChildResult = true
			yield { type: "text", text: "Observed the child turn result." }
		} else {
			throw new Error(`Unexpected parent model turn ${turn + 1}`)
		}
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 128_000, maxTokens: 8_192, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

const PEER_BASELINE = "Independent peer baseline result."
const PEER_FOLLOWUP = "Continue the existing independent peer."
const PEER_STEERING = "Use this steering instruction for the peer."

class IndependentThreadAI {
	readonly id = "independent-thread-orchestration-e2e"
	readonly calls: Array<{ taskId: string; name: string }> = []
	private readonly turns = new Map<string, number>()
	private peerTaskId?: string
	private orchestratorTaskId?: string
	forkTaskId?: string
	peerFollowupStarted = false
	peerSteeringStarted = false

	getDiagnostics() {
		return {
			calls: this.calls.slice(-20),
			turns: [...this.turns],
			forkTaskId: this.forkTaskId,
			peerFollowupStarted: this.peerFollowupStarted,
			peerSteeringStarted: this.peerSteeringStarted,
		}
	}

	async *createMessage(
		_system: string,
		messages: unknown[],
		metadata?: {
			taskId?: string
			signal?: AbortSignal
			tools?: Array<{ function?: { name?: string } }>
		},
	): AsyncGenerator<ScriptChunk> {
		const taskId = metadata?.taskId
		assert.ok(taskId)
		this.peerTaskId ??= taskId
		const turn = this.turns.get(taskId) ?? 0
		this.turns.set(taskId, turn + 1)
		if (taskId === this.peerTaskId) {
			this.calls.push({ taskId, name: turn === 0 ? "peer_baseline" : "peer_pending" })
			if (turn === 0) {
				yield { type: "text", text: PEER_BASELINE }
				yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
				return
			}
			assert.ok(turn <= 2, "The peer must resume once for messaging and once for steering")
			const expected = turn === 1 ? PEER_FOLLOWUP : PEER_STEERING
			assert.ok(JSON.stringify(messages).includes(expected), "The peer must receive attributed guidance")
			if (turn === 1) this.peerFollowupStarted = true
			else this.peerSteeringStarted = true
			const signal = metadata?.signal
			assert.ok(signal, "Peer requests must remain cancellable during cross-thread controls")
			await new Promise<void>((resolve) => {
				if (signal.aborted) return resolve()
				signal.addEventListener("abort", () => resolve(), { once: true })
			})
			return
		}

		this.orchestratorTaskId ??= taskId
		assert.equal(taskId, this.orchestratorTaskId, "Forking must not start a model request")
		const tool = (name: string, args: Record<string, unknown>): ScriptChunk => {
			assert.ok(
				metadata?.tools?.some(({ function: spec }) => spec?.name === name),
				`${name} must be visible`,
			)
			this.calls.push({ taskId, name })
			return { type: "tool_call", id: `${taskId}-peer-step-${turn}`, name, arguments: JSON.stringify(args) }
		}
		const result = (): unknown => JSON.parse(findLatestToolResult(messages))
		switch (turn) {
			case 0:
				yield tool("list_threads", { limit: 50 })
				break
			case 1: {
				const listed = result() as ThreadListResult
				assert.ok(
					listed.threads.some(({ id }) => id === this.peerTaskId),
					"An unrelated peer must be listed",
				)
				yield tool("read_thread", { threadId: this.peerTaskId, turnLimit: 1 })
				break
			}
			case 2: {
				const read = result() as ThreadReadResult
				assert.equal(read.thread.id, this.peerTaskId)
				assert.ok(JSON.stringify(read.turns).includes(PEER_BASELINE), "Peer history must be readable")
				yield tool("fork_thread", { threadId: this.peerTaskId })
				break
			}
			case 3: {
				const forked = result() as { threadId: string; sourceThreadId: string }
				assert.equal(forked.sourceThreadId, this.peerTaskId)
				assert.notEqual(forked.threadId, this.peerTaskId)
				this.forkTaskId = forked.threadId
				yield tool("read_thread", { threadId: this.forkTaskId, turnLimit: 1 })
				break
			}
			case 4: {
				const read = result() as ThreadReadResult
				assert.equal(read.thread.id, this.forkTaskId)
				assert.ok(
					JSON.stringify(read.turns).includes(PEER_BASELINE),
					"An idle fork must preserve completed history",
				)
				yield tool("set_thread_title", { threadId: this.forkTaskId, title: "Independent peer fork" })
				break
			}
			case 5:
				assert.equal((result() as { title: string }).title, "Independent peer fork")
				yield tool("send_message_to_thread", { threadId: this.peerTaskId, prompt: PEER_FOLLOWUP })
				break
			case 6:
				assert.equal((result() as { threadId: string }).threadId, this.peerTaskId)
				await waitFor(() => this.peerFollowupStarted, { description: "independent peer follow-up request" })
				yield tool("steer_task", { task_id: this.peerTaskId, message: PEER_STEERING })
				break
			case 7:
				await waitFor(() => this.peerSteeringStarted, { description: "independent peer steering request" })
				yield tool("stop_task", { task_id: this.peerTaskId, reason: "Independent peer acceptance complete" })
				break
			case 8:
				assert.ok(["stopped", "stopping"].includes((result() as { status: string }).status))
				yield tool("wait_threads", { targets: [{ threadId: this.peerTaskId }], timeoutMs: 0 })
				break
			case 9: {
				const waited = result() as ThreadWaitResult
				assert.ok(waited.polls.some(({ thread }) => thread.id === this.peerTaskId))
				assert.ok(waited.wake, "A stopped peer must yield an actionable wait snapshot")
				yield tool("set_thread_archived", { threadId: this.forkTaskId, archived: true })
				break
			}
			case 10:
				assert.equal((result() as { archived: boolean }).archived, true)
				yield tool("list_archived_threads", { limit: 50 })
				break
			case 11: {
				const listed = result() as ThreadListResult
				assert.ok(listed.threads.some(({ id }) => id === this.forkTaskId))
				yield tool("set_thread_archived", { threadId: this.forkTaskId, archived: false })
				break
			}
			case 12:
				assert.equal((result() as { archived: boolean }).archived, false)
				this.calls.push({ taskId, name: "assistant_text" })
				yield { type: "text", text: "Inspected, forked, messaged, steered, and stopped the independent peer." }
				break
			default:
				throw new Error(`Unexpected independent orchestrator model step ${turn + 1}`)
		}
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 128_000, maxTokens: 8_192, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

suite("Cross-task deterministic Extension Host acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("ten command/API launches keep every previous task running and respect capacity", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		assert.equal(vscode.version, "1.138.0")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CrossTaskHostProvider }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const scripted = new ConcurrentThreadsAI()
		const taskIds: string[] = []
		const completed = new Set<string>()
		const onCompleted = (taskId: string) => completed.add(taskId)
		const onMessage = (event: { taskId: string; message: AlphaMessage }) => {
			if (event.message.type === "ask" && event.message.ask === "completion_result") {
				queueMicrotask(() => provider.getLiveTask(event.taskId)?.approveAsk())
			}
		}
		api.on(AlphaCodeEventName.Message, onMessage)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				maxConcurrentTasks: 10,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			for (let index = 0; index < 10; index++) {
				const taskId = await api.startNewTask({ configuration, text: `Concurrent command ${index + 1}` })
				taskIds.push(taskId)
				await waitFor(() => scripted.started.has(taskId), {
					timeout: 15_000,
					description: `worker ${index + 1} to start`,
				})
			}
			assert.equal(scripted.started.size, 10)
			const liveTasks = taskIds.map((taskId) => provider.getLiveTask(taskId))
			const firstTaskId = taskIds[0]
			assert.ok(firstTaskId)
			await api.resumeTask(firstTaskId)
			for (const [index, taskId] of taskIds.entries()) {
				assert.equal(
					provider.getLiveTask(taskId),
					liveTasks[index],
					"Opening a running chat must retain its runtime",
				)
			}
			for (const taskId of taskIds) {
				assert.equal(
					provider.getLiveTask(taskId)?.abort,
					false,
					"Launching another root must not cancel this task",
				)
				assert.equal(provider.getLiveTask(taskId)?.didComplete, false)
			}
			await assert.rejects(
				api.startNewTask({ configuration, text: "Exceeds capacity" }),
				/Maximum live task limit/,
			)
			assert.ok(taskIds.every((id) => provider.getLiveTask(id)?.abort === false))
			scripted.release()
			await waitFor(() => taskIds.every((id) => completed.has(id)), {
				timeout: 60_000,
				description: "all ten roots to complete",
			})
		} finally {
			scripted.release()
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			api.off(AlphaCodeEventName.Message, onMessage)
			for (const taskId of taskIds) await provider.closeTask(taskId)
			await api.setConfiguration(original)
		}
	})

	test("ten native child threads survive completion and are collected by an explicit human follow-up", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		assert.equal(vscode.version, "1.138.0")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CrossTaskHostProvider }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const scripted = new ConcurrentThreadsAI(10)
		const completed = new Set<string>()
		const onCompleted = (taskId: string) => completed.add(taskId)
		const onMessage = (event: { taskId: string; message: AlphaMessage }) => {
			if (event.message.type === "ask" && event.message.ask === "completion_result") {
				queueMicrotask(() => provider.getLiveTask(event.taskId)?.approveAsk())
			}
		}
		api.on(AlphaCodeEventName.Message, onMessage)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		let rootId: string | undefined
		try {
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				maxConcurrentTasks: 11,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			rootId = await api.startNewTask({
				configuration,
				text: "Launch ten new chat threads for this project and collect their results.",
			})
			await waitFor(() => scripted.started.size === 10 && completed.has(rootId!), {
				timeout: 60_000,
				description: "ten children running after their coordinator completes",
			})
			const root = provider.getLiveTask(rootId)
			assert.ok(root)
			assert.equal(root.didComplete, true)
			const childIds = new Set(scripted.children)
			assert.equal(childIds.size, 10)
			const listed = await provider.listIndependentTasks(root)
			const children = listed.filter(({ task_id }) => childIds.has(task_id))
			assert.equal(children.length, 10)
			assert.deepEqual(new Set(children.map(({ task_id }) => task_id)), childIds)
			assert.ok(children.every((child) => child.lifecycle === "running"))
			for (const childId of scripted.children) {
				assert.equal(provider.getLiveTask(childId)?.abort, false)
				assert.equal(provider.getLiveTask(childId)?.didComplete, false)
			}
			scripted.release()
			await waitFor(() => scripted.children.every((id) => completed.has(id)), {
				timeout: 60_000,
				description: "all ten native child threads to complete",
				onTimeout: () => scripted.getDiagnostics(),
			})
			for (const childId of scripted.children) await provider.getLiveTask(childId)?.waitForTermination()
			await root.waitForTermination()
			assert.equal(root.didComplete, true)
			assert.equal(scripted.coordinatorRequests, 11, "Native thread completion must not wake its creator")
			assert.equal(scripted.receivedResults.size, 0)
			for (const childId of scripted.children) {
				const { historyItem } = await provider.getTaskWithId(childId, { includeApiConversationHistory: false })
				assert.equal(historyItem.orchestrationNotifyCompletion, false)
				assert.equal(historyItem.orchestrationCompletionNotifications, undefined)
			}
			await root.submitUserMessage(COLLECT_CHILD_RESULTS)
			await waitFor(
				() => scripted.receivedResults.size === 10 && provider.getLiveTask(rootId!)?.didComplete === true,
				{
					timeout: 60_000,
					description: "the coordinator to explicitly collect all ten native thread results",
					onTimeout: () => scripted.getDiagnostics(),
				},
			)
			assert.equal(provider.getLiveTask(rootId), root, "Collection must reuse the coordinator runtime")
			assert.deepEqual(scripted.receivedResults, childIds)
			for (const childId of scripted.children) {
				const { historyItem } = await provider.getTaskWithId(childId, { includeApiConversationHistory: false })
				assert.equal(historyItem.orchestrationParentTaskId, rootId)
				assert.equal(historyItem.orchestrationCompletionNotifications, undefined)
			}
		} finally {
			scripted.release()
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			api.off(AlphaCodeEventName.Message, onMessage)
			for (const childId of scripted.children) await provider.closeTask(childId)
			if (rootId) await provider.closeTask(rootId)
			await api.setConfiguration(original)
		}
	})

	test("ten children with host completion notifications survive their coordinator and deliver one durable receipt each", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		assert.equal(vscode.version, "1.138.0")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CrossTaskHostProvider }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const scripted = new ConcurrentThreadsAI(10, "host")
		const childIds: string[] = []
		const completed = new Set<string>()
		const onCompleted = (taskId: string) => completed.add(taskId)
		const onMessage = (event: { taskId: string; message: AlphaMessage }) => {
			if (event.message.type === "ask" && event.message.ask === "completion_result")
				queueMicrotask(() => provider.getLiveTask(event.taskId)?.approveAsk())
		}
		api.on(AlphaCodeEventName.Message, onMessage)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		let rootId: string | undefined
		try {
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				maxConcurrentTasks: 11,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			rootId = await api.startNewTask({
				configuration,
				text: "Launch ten new chat threads for this project and collect their results.",
			})
			const root = provider.getLiveTask(rootId)
			assert.ok(root)
			await waitFor(() => scripted.coordinatorRequests === 1, {
				description: "the coordinator request to own the host launch barrier",
			})
			for (let index = 0; index < 10; index++) {
				const child = await provider.createIndependentTask(
					root,
					`Concurrent child ${index + 1}`,
					"shared",
					undefined,
					{
						notifyOnCompletion: true,
					},
				)
				childIds.push(child.task_id)
			}
			scripted.registerHostChildren(childIds)
			await waitFor(() => scripted.started.size === 10 && completed.has(rootId!), {
				timeout: 60_000,
				description: "ten host-notified children running after coordinator completion",
				onTimeout: () => scripted.getDiagnostics(),
			})
			assert.equal(new Set(childIds).size, 10)
			assert.equal(root.didComplete, true)
			for (const childId of childIds) {
				assert.equal(provider.getLiveTask(childId)?.abort, false)
				assert.equal(provider.getLiveTask(childId)?.didComplete, false)
			}
			scripted.release()
			await waitFor(() => scripted.receivedResults.size === 10 && root.didComplete, {
				timeout: 60_000,
				description: "the coordinator to integrate all ten host completion messages",
				onTimeout: () => scripted.getDiagnostics(),
			})
			assert.deepEqual(scripted.receivedResults, new Set(childIds))
			assert.equal(provider.getLiveTask(rootId), root)
			assert.ok(childIds.every((id) => completed.has(id)))
			await waitFor(
				async () => {
					for (const childId of childIds) {
						const { historyItem } = await provider.getTaskWithId(childId, {
							includeApiConversationHistory: false,
						})
						if (!historyItem.orchestrationCompletionNotifications?.[0]?.deliveredAt) return false
					}
					return true
				},
				{ timeout: 30_000, description: "all child completion receipts to become durable" },
			)
			for (const childId of childIds) {
				const { historyItem } = await provider.getTaskWithId(childId, { includeApiConversationHistory: false })
				assert.equal(historyItem.orchestrationParentTaskId, rootId)
				assert.equal(historyItem.orchestrationNotifyCompletion, true)
				assert.equal(historyItem.orchestrationCompletionNotifications?.length, 1)
				assert.ok(historyItem.orchestrationCompletionNotifications?.[0]?.deliveredAt)
			}
		} finally {
			scripted.release()
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			api.off(AlphaCodeEventName.Message, onMessage)
			for (const childId of childIds) await provider.closeTask(childId)
			if (rootId) await provider.closeTask(rootId)
			await api.setConfiguration(original)
		}
	})

	test("creates, lists, stops, waits, and persists a parent-owned child through the model tool path", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CrossTaskHostProvider }).sidebarProvider
		assert.ok(provider, "The extension API did not expose its provider to the cross-task acceptance test")
		const scripted = new CrossTaskAcceptanceAI()
		scripted.setHost(provider)
		const taskIds: { root?: string; child?: string } = {}
		const completions: string[] = []
		const interactiveToolApprovals: string[] = []
		const onMessage = (event: { taskId: string; message: AlphaMessage }) => {
			if (event.message.type === "ask" && event.message.ask === "tool" && !event.message.isAnswered) {
				interactiveToolApprovals.push(event.message.text ?? "unknown tool")
			}
			if (
				event.message.type === "ask" &&
				event.taskId === taskIds.root &&
				event.message.ask === "completion_result"
			) {
				queueMicrotask(() => provider.getLiveTask(event.taskId)?.approveAsk())
			}
		}
		const onCompleted = (taskId: string) => completions.push(taskId)
		api.on(AlphaCodeEventName.Message, onMessage)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			const configuration: AlphaCodeSettings = {
				...api.getConfiguration(),
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			taskIds.root = await api.startNewTask({
				configuration,
				text: "can you launch a test thread",
			})
			await waitUntilCompleted({
				api,
				taskId: taskIds.root,
				isCompleted: () => provider.getLiveTask(taskIds.root!)?.didComplete === true,
				timeout: 60_000,
			})
			taskIds.child = scripted.getChildTaskId()
			assert.ok(taskIds.child, "The model-facing create_thread call did not return a child task ID")
			await waitFor(async () => completions.filter((id) => id === taskIds.root).length === 1, {
				description: "exactly one parent completion",
			})
			const root = provider.getLiveTask(taskIds.root)
			const child = scripted.getChildTask()
			assert.ok(root)
			assert.ok(child)
			assert.equal(
				provider.getLiveTask(taskIds.child),
				undefined,
				"A stopped child must leave the live task registry",
			)
			await root.waitForTermination()
			await child.waitForTermination()
			await root.flushApiConversationHistoryPersistence()
			await child.flushApiConversationHistoryPersistence()

			assert.deepEqual(
				scripted.calls.map(({ taskId, name }) => [taskId === taskIds.root ? "parent" : "child", name]),
				[
					["parent", "create_thread"],
					["child", "child_pending"],
					["parent", "list_threads"],
					["parent", "stop_task"],
					["parent", "wait_threads"],
					["parent", "assistant_text"],
				],
			)
			assert.equal(root.didComplete, true)
			assert.deepEqual(interactiveToolApprovals, [], "Auto must not pause for shared child orchestration")
			assert.equal(child.abort, true)
			assert.equal(child.didComplete, false)
			assert.equal(completions.filter((id) => id === taskIds.child).length, 0)

			const history = await provider.getTaskWithId(taskIds.child, { includeApiConversationHistory: false })
			assert.equal(history.historyItem.orchestrationParentTaskId, taskIds.root)
			assert.equal(history.historyItem.orchestrationWorkspaceMode, "shared")
			assert.equal(history.historyItem.task, "Run until stopped")
			assert.equal(history.historyItem.status, "interrupted")
			const records = await provider.listIndependentTasks(root)
			assert.deepEqual(
				records
					.filter(({ task_id }) => task_id === taskIds.child)
					.map(({ task_id, lifecycle }) => ({ task_id, lifecycle })),
				[{ task_id: taskIds.child, lifecycle: "closed" }],
			)
			const state = await provider.getStateToPostToWebview()
			assert.equal(state.liveTasksById?.[taskIds.child], undefined)
			const projectedChild = state.taskHistory.find(({ id }) => id === taskIds.child)
			assert.equal(projectedChild?.orchestrationParentTaskId, taskIds.root)
			assert.equal(projectedChild?.orchestrationWorkspaceMode, "shared")
			assert.equal(projectedChild?.status, "interrupted")
		} finally {
			api.off(AlphaCodeEventName.Message, onMessage)
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			if (taskIds.root && !provider.getLiveTask(taskIds.root)?.didComplete) {
				await api.cancelCurrentTask().catch(() => undefined)
			}
		}
	})

	test("a fresh conversation controls an unrelated peer and persists an idle completed-history fork", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CrossTaskHostProvider }).sidebarProvider
		assert.ok(provider)
		const scripted = new IndependentThreadAI()
		const createdTaskIds: string[] = []
		const onMessage = (event: { taskId: string; message: AlphaMessage }) => {
			if (
				event.message.type === "ask" &&
				(event.message.ask === "tool" || event.message.ask === "completion_result")
			) {
				queueMicrotask(() => provider.getLiveTask(event.taskId)?.approveAsk())
			}
		}
		api.on(AlphaCodeEventName.Message, onMessage)
		try {
			const configuration: AlphaCodeSettings = {
				...api.getConfiguration(),
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				maxConcurrentTasks: 8,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			const peerTaskId = await api.startNewTask({ configuration, text: "Report the independent peer baseline." })
			createdTaskIds.push(peerTaskId)
			await waitUntilCompleted({
				api,
				taskId: peerTaskId,
				isCompleted: () => provider.getLiveTask(peerTaskId)?.didComplete === true,
				timeout: 60_000,
			})
			const peer = provider.getLiveTask(peerTaskId)
			assert.ok(peer)
			await peer.flushApiConversationHistoryPersistence()

			const orchestrator = await provider.createTask(
				"Inspect and coordinate the existing independent conversation. Fork the existing conversation with its completed history, preserving its separate identity.",
				undefined,
				undefined,
				{ preserveExisting: true, background: true, apiConfiguration: configuration },
				configuration,
			)
			createdTaskIds.push(orchestrator.taskId)
			await waitUntilCompleted({
				api,
				taskId: orchestrator.taskId,
				isCompleted: () => orchestrator.didComplete,
				timeout: 60_000,
				onTimeout: () => ({
					script: scripted.getDiagnostics(),
					peer: { abort: peer.abort, completed: peer.didComplete, ask: peer.taskAsk?.ask },
					orchestrator: {
						abort: orchestrator.abort,
						completed: orchestrator.didComplete,
						ask: orchestrator.taskAsk?.ask,
					},
				}),
			})
			await orchestrator.waitForTermination()
			await peer.waitForTermination()
			await orchestrator.flushApiConversationHistoryPersistence()
			await peer.flushApiConversationHistoryPersistence()
			assert.equal(scripted.peerFollowupStarted, true)
			assert.equal(scripted.peerSteeringStarted, true)
			assert.equal(peer.abort, true)
			assert.equal(provider.getLiveTask(peerTaskId), undefined, "Stopping a peer must release its live session")
			const incoming = peer.alphaMessages.filter((message) => message.say === "agent_message")
			assert.deepEqual(
				incoming.map((message) => message.text),
				[PEER_FOLLOWUP, PEER_STEERING, "Independent peer acceptance complete"],
				"Each incoming peer input must have one visible message bubble",
			)
			assert.ok(incoming.every((message) => message.agentMessage?.senderTaskId === orchestrator.taskId))
			assert.ok(incoming.every((message) => message.isProtected === true))
			const stopReceipt = incoming.at(-1)
			assert.ok(stopReceipt?.agentMessage)
			assert.equal(stopReceipt.agentMessage.stopStatus, "stopped", "The notice must confirm joined cleanup")
			const stopMessageId = stopReceipt.agentMessage.id
			const peerHistory = await provider.getTaskWithId(peerTaskId)
			const savedMessages = alphaMessageSchema
				.array()
				.parse(JSON.parse(await readFile(peerHistory.uiMessagesFilePath, "utf8")))
			assert.deepEqual(
				savedMessages.find((message) => message.agentMessage?.id === stopMessageId),
				stopReceipt,
			)
			assert.ok(
				savedMessages.some(
					(message) =>
						message.say === "api_req_started" &&
						JSON.parse(message.text ?? "{}").agentStopMessageId === stopMessageId,
				),
				"The cancelled API receipt must identify the peer stop",
			)
			assert.equal(
				JSON.stringify(peerHistory.apiConversationHistory).includes(stopMessageId),
				false,
				"A stop receipt must not enqueue another model prompt",
			)
			assert.equal(
				peer.alphaMessages.some((message) => message.text === "Continue with the pending agent messages."),
				false,
				"Internal thread wake instructions must not appear as chat input",
			)

			const forkTaskId = scripted.forkTaskId
			assert.ok(forkTaskId)
			createdTaskIds.push(forkTaskId)
			assert.equal(
				scripted.calls.some(({ taskId }) => taskId === forkTaskId),
				false,
			)
			assert.equal(provider.getLiveTask(forkTaskId), undefined, "An idle fork must not start a runtime")
			const fork = await provider.getTaskWithId(forkTaskId)
			assert.equal(fork.historyItem.displayName, "Independent peer fork")
			assert.ok(JSON.stringify(fork.apiConversationHistory).includes(PEER_BASELINE))
			for (const taskId of [peerTaskId, orchestrator.taskId]) {
				const saved = await provider.getTaskWithId(taskId, { includeApiConversationHistory: false })
				assert.equal(
					saved.historyItem.orchestrationParentTaskId,
					undefined,
					"Peer control must not reparent tasks",
				)
			}
			assert.deepEqual(
				scripted.calls.filter(({ taskId }) => taskId === orchestrator.taskId).map(({ name }) => name),
				[
					"list_threads",
					"read_thread",
					"fork_thread",
					"read_thread",
					"set_thread_title",
					"send_message_to_thread",
					"steer_task",
					"stop_task",
					"wait_threads",
					"set_thread_archived",
					"list_archived_threads",
					"set_thread_archived",
					"assistant_text",
				],
			)
		} finally {
			for (const taskId of createdTaskIds.reverse()) {
				if (provider.getLiveTask(taskId)) {
					await provider.removeTaskFromStack({ taskId, requireAbortSuccess: true }).catch(() => undefined)
				}
			}
			api.off(AlphaCodeEventName.Message, onMessage)
		}
	})

	for (const performLookup of [false, true]) {
		test(
			performLookup
				? "starts permitted ticket work from an agent assignment without another human prompt"
				: "preserves a ticket handoff and returns an acknowledgement without automatically restarting either task",
			async () => {
				assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
				const api = globalThis.api
				const provider = (api as unknown as { sidebarProvider?: CrossTaskHostProvider }).sidebarProvider
				assert.ok(provider)
				const scripted = new CompletingChildAI(performLookup)
				const completions: string[] = []
				let rootTaskId: string | undefined
				const onMessage = (event: { taskId: string; message: AlphaMessage }) => {
					if (
						event.message.type === "ask" &&
						(event.message.ask === "tool" || event.message.ask === "completion_result")
					) {
						queueMicrotask(() => provider.getLiveTask(event.taskId)?.approveAsk())
					}
				}
				const onCompleted = (taskId: string) => completions.push(taskId)
				api.on(AlphaCodeEventName.Message, onMessage)
				api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
				try {
					const configuration: AlphaCodeSettings = {
						...api.getConfiguration(),
						apiProvider: "fake-ai",
						fakeAi: scripted,
						mode: "code",
						autoApprovalEnabled: false,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
						enableCheckpoints: false,
						subagentsEnabled: true,
					}
					rootTaskId = await api.startNewTask({
						configuration,
						text: `Launch a new thread for Alpha parent ticket ALPHA-42 and all five children. Use subagents as needed. ${LAUNCHER_ONLY_NOTE}`,
					})
					await waitFor(() => scripted.childTaskId !== undefined, {
						description: "canonical child creation to finish",
					})
					scripted.releaseChild()
					await waitFor(
						() =>
							completions.filter((taskId) => taskId === rootTaskId).length === 1 &&
							scripted.sawChildResult,
						{
							timeout: 60_000,
							description: "explicit thread wait to return the child result and complete once",
						},
					)
					assert.equal(completions.filter((taskId) => taskId === scripted.childTaskId).length, 1)
					const root = provider.getLiveTask(rootTaskId)
					assert.ok(root)
					await root.waitForTermination()
					assert.equal(completions.filter((taskId) => taskId === rootTaskId).length, 1)
					assert.equal(
						scripted.childRequests,
						performLookup ? 2 : 1,
						"Only the tool result may continue the child",
					)
					const saved = await provider.getTaskWithId(scripted.childTaskId!)
					assert.equal(
						saved.historyItem.task,
						TICKET_HANDOFF_PROMPT,
						"A display title must not replace the objective",
					)
					assert.equal((saved.apiConversationHistory[0] as { input_origin?: string })?.input_origin, "agent")
					assert.equal(saved.historyItem.orchestrationParentTaskId, rootTaskId)
					if (performLookup) {
						assertFeatureTicketListResult(
							saved.apiConversationHistory,
							`${scripted.childTaskId}-assigned-lookup`,
						)
					}
				} finally {
					scripted.releaseChild()
					api.off(AlphaCodeEventName.Message, onMessage)
					api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
					if (rootTaskId && !provider.getLiveTask(rootTaskId)?.didComplete) {
						await api.cancelCurrentTask().catch(() => undefined)
					}
				}
			},
		)
	}
})
