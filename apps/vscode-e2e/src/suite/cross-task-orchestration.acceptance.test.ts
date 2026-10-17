import * as assert from "assert"
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

type ScriptChunk =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

interface CrossTaskHostProvider {
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
	clineMessages: AlphaMessage[]
	taskAsk?: AlphaMessage
	abort: boolean
	didComplete: boolean
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

function findLatestToolResult(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const content = (messages[index] as { content?: unknown } | undefined)?.content
		if (!Array.isArray(content)) continue
		for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex--) {
			const block = content[contentIndex] as { type?: string; content?: unknown } | undefined
			if (block?.type === "tool_result") {
				if (typeof block.content === "string") return block.content
				if (Array.isArray(block.content)) {
					return block.content
						.flatMap((item: { type?: string; text?: unknown }) =>
							item.type === "text" && typeof item.text === "string" ? [item.text] : [],
						)
						.join("\n")
				}
				return JSON.stringify(block.content)
			}
		}
	}
	throw new Error("The scripted model did not receive a terminal tool result")
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

	releaseChild(): void {
		this.releaseChildRequest()
	}

	async *createMessage(
		_system: string,
		messages: unknown[],
		metadata?: { taskId?: string; tools?: Array<{ type?: string; function?: { name?: string } }> },
	): AsyncGenerator<ScriptChunk> {
		const taskId = metadata?.taskId
		assert.ok(taskId)
		this.rootTaskId ??= taskId
		const turn = this.turns.get(taskId) ?? 0
		this.turns.set(taskId, turn + 1)
		if (taskId !== this.rootTaskId) {
			assert.equal(turn, 0)
			await this.childMayFinish
			yield { type: "text", text: "Child test completed." }
		} else if (turn === 0) {
			assert.ok(metadata?.tools?.some((tool) => tool.function?.name === "create_thread"))
			yield {
				type: "tool_call",
				id: `${taskId}-create-child`,
				name: "create_thread",
				arguments: JSON.stringify({ prompt: "Complete the test and report back" }),
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
			assert.ok(
				JSON.stringify(messages).includes("Child test completed."),
				"The child result must reach the parent",
			)
			this.sawChildResult = true
			yield { type: "text", text: "Integrated the child result." }
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
			await waitUntilCompleted({ api, taskId: taskIds.root, timeout: 60_000 })
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
			await waitUntilCompleted({ api, taskId: peerTaskId, timeout: 60_000 })
			const peer = provider.getLiveTask(peerTaskId)
			assert.ok(peer)
			await peer.flushApiConversationHistoryPersistence()

			const orchestrator = await provider.createTask(
				"Inspect and coordinate the existing independent conversation, preserving its separate identity.",
				undefined,
				undefined,
				{ preserveExisting: true, background: true, apiConfiguration: configuration },
				configuration,
			)
			createdTaskIds.push(orchestrator.taskId)
			await waitUntilCompleted({ api, taskId: orchestrator.taskId, timeout: 60_000 })
			await orchestrator.waitForTermination()
			await peer.waitForTermination()
			await orchestrator.flushApiConversationHistoryPersistence()
			await peer.flushApiConversationHistoryPersistence()
			assert.equal(scripted.peerFollowupStarted, true)
			assert.equal(scripted.peerSteeringStarted, true)
			assert.equal(peer.abort, true)
			assert.equal(provider.getLiveTask(peerTaskId), undefined, "Stopping a peer must release its live session")
			const incoming = peer.clineMessages.filter((message) => message.say === "agent_message")
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
				peer.clineMessages.some((message) => message.text === "Continue with the pending agent messages."),
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

	test("wait_threads returns a child result without automatically starting another parent turn", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CrossTaskHostProvider }).sidebarProvider
		assert.ok(provider)
		const scripted = new CompletingChildAI()
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
			}
			rootTaskId = await api.startNewTask({ configuration, text: "can you launch a test thread" })
			await waitFor(() => scripted.childTaskId !== undefined, {
				description: "canonical child creation to finish",
			})
			scripted.releaseChild()
			await waitFor(
				() => completions.filter((taskId) => taskId === rootTaskId).length === 1 && scripted.sawChildResult,
				{ timeout: 60_000, description: "explicit thread wait to return the child result and complete once" },
			)
			assert.equal(completions.filter((taskId) => taskId === scripted.childTaskId).length, 1)
			const root = provider.getLiveTask(rootTaskId)
			assert.ok(root)
			await root.waitForTermination()
			assert.equal(completions.filter((taskId) => taskId === rootTaskId).length, 1)
		} finally {
			scripted.releaseChild()
			api.off(AlphaCodeEventName.Message, onMessage)
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			if (rootTaskId && !provider.getLiveTask(rootTaskId)?.didComplete) {
				await api.cancelCurrentTask().catch(() => undefined)
			}
		}
	})
})
