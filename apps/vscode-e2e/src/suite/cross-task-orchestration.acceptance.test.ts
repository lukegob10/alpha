import * as assert from "assert"

import {
	AlphaCodeEventName,
	type AlphaCodeSettings,
	type AlphaMessage,
	type ExtensionState,
	type HistoryItem,
} from "@alpha-code/types"

import { waitFor, waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

type ScriptChunk =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

interface CrossTaskHostProvider {
	getLiveTask(taskId: string): HostTask | undefined
	getTaskWithId(
		taskId: string,
		options?: { includeApiConversationHistory?: boolean },
	): Promise<{
		historyItem: HistoryItem
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
				return typeof block.content === "string" ? block.content : JSON.stringify(block.content)
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
						metadata?.tools?.some((tool) => tool.function?.name === "create_task"),
						"The launch-thread request must expose create_task to the model",
					)
					chunk = {
						type: "tool_call",
						id: `${taskId}-create-child`,
						name: "create_task",
						arguments: JSON.stringify({ objective: "Run until stopped", workspace_mode: "shared" }),
					}
					break
				case 1: {
					const created = JSON.parse(findLatestToolResult(messages)) as { task_id: string }
					state.childTaskId = created.task_id
					state.childTask = state.host?.getLiveTask(created.task_id)
					await waitFor(() => state.childRequestStarted, {
						timeout: 10_000,
						interval: 20,
						description: "the child task provider request to start",
					})
					chunk = {
						type: "tool_call",
						id: `${taskId}-list-children`,
						name: "list_tasks",
						arguments: "{}",
					}
					break
				}
				case 2: {
					const listed = JSON.parse(findLatestToolResult(messages)) as {
						tasks: Array<{ task_id: string; lifecycle: string }>
					}
					assert.deepEqual(
						listed.tasks.map(({ task_id, lifecycle }) => ({ task_id, lifecycle })),
						[{ task_id: state.childTaskId, lifecycle: "running" }],
					)
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
						name: "wait_task",
						arguments: JSON.stringify({ task_id: state.childTaskId, timeout_ms: 5_000 }),
					}
					break
				}
				case 4: {
					const waited = JSON.parse(findLatestToolResult(messages)) as { lifecycle: string }
					assert.equal(waited.lifecycle, "closed")
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
			assert.ok(metadata?.tools?.some((tool) => tool.function?.name === "create_task"))
			yield {
				type: "tool_call",
				id: `${taskId}-create-child`,
				name: "create_task",
				arguments: JSON.stringify({ objective: "Complete the test and report back", workspace_mode: "shared" }),
			}
		} else if (turn === 1) {
			this.childTaskId = (JSON.parse(findLatestToolResult(messages)) as { task_id: string }).task_id
			yield { type: "text", text: "Launched the test task." }
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
			assert.ok(taskIds.child, "The model-facing create_task call did not return a child task ID")
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
					["parent", "create_task"],
					["child", "child_pending"],
					["parent", "list_tasks"],
					["parent", "stop_task"],
					["parent", "wait_task"],
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
				records.map(({ task_id, lifecycle }) => ({ task_id, lifecycle })),
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

	test("a completed child resumes its parent with the result", async () => {
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
			await waitUntilCompleted({ api, taskId: rootTaskId, timeout: 60_000 })
			assert.ok(scripted.childTaskId)
			scripted.releaseChild()
			await waitFor(
				() => completions.filter((taskId) => taskId === rootTaskId).length === 2 && scripted.sawChildResult,
				{ timeout: 60_000, description: "child result to resume and complete the parent" },
			)
			assert.equal(completions.filter((taskId) => taskId === scripted.childTaskId).length, 1)
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
