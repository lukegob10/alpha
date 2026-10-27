import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	getVscodeLlmContextWindow,
	TaskLifecycleState,
	type AlphaCodeSettings,
	type AgentLifecycleSnapshot,
	type ExtensionState,
} from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const TOOL_CALL_ID = "compaction-acceptance-read"
const ARCHIVE_MARKER = "ARCHIVE_PAYLOAD_MARKER"
const OVERFLOW_TOOL_CALL_ID = "compaction-overflow-read"
const OVERFLOW_MARKER = "OVERFLOW_ARCHIVE_PAYLOAD"
const STEERING_MARKER = "QUEUED_STEERING_AFTER_OVERFLOW"
const RETAINED_TURNS = 12
const RETAINED_PROMPT_PREFIX = "RETAINED_THREAD_PROMPT_"
const RETAINED_ARCHIVE_MARKER = "RETAINED_THREAD_ARCHIVE_EVIDENCE"
const RECOVERY_PROMPT = `${RETAINED_PROMPT_PREFIX}RECOVERY`
const AFTER_RECOVERY_PROMPT = `${RETAINED_PROMPT_PREFIX}AFTER_RECOVERY`
type HistoryMessage = {
	role: string
	content: unknown
	isSummary?: boolean
	condenseId?: string
	condenseParent?: string
}

class CompactionScriptedAI {
	readonly id = "compaction-acceptance-scripted"
	readonly mainRequests: unknown[][] = []
	readonly mainRequestTaskIds: string[] = []
	summaryRequests = 0
	removeFromCache?: () => void

	async *createMessage(
		systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; tools?: unknown[]; attemptId?: string },
	) {
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
		if (metadata.attemptId === "title") {
			yield { type: "text" as const, text: "Check context recovery" }
			return
		}
		if (systemPrompt.includes("tasked with summarizing conversations")) {
			this.summaryRequests++
			assert.equal(this.summaryRequests, 1, "The fixture permits one compaction request")
			assert.equal(metadata.tools?.length ?? 0, 0, "The summary request must not expose task tools")
			assert.ok(
				JSON.stringify(messages).includes("fixture answer=42"),
				"The summary input must include the read result",
			)
			yield { type: "text" as const, text: "The saved fixture answer is 42." }
			return
		}

		this.mainRequests.push(structuredClone(messages))
		this.mainRequestTaskIds.push(metadata!.taskId!)
		switch (this.mainRequests.length) {
			case 1:
				yield {
					type: "tool_call" as const,
					id: TOOL_CALL_ID,
					name: "exec_command",
					arguments: JSON.stringify({
						cmd: `node -p "require('fs').readFileSync('compaction-e2e.txt', 'utf8')"`,
					}),
				}
				return
			case 2:
				assert.ok(JSON.stringify(messages).includes(TOOL_CALL_ID), "The tool result must reach the model")
				assert.ok(JSON.stringify(messages).includes("fixture answer=42"), "The command must read the fixture")
				yield {
					type: "text" as const,
					text: `The fixture answer is 42. ${ARCHIVE_MARKER} ${"archive evidence ".repeat(500)}`,
				}
				return
			case 3:
				assert.ok(JSON.stringify(messages).includes("## Conversation Summary"))
				assert.ok(JSON.stringify(messages).includes("The saved fixture answer is 42."))
				assert.ok(!JSON.stringify(messages).includes(ARCHIVE_MARKER))
				yield { type: "text" as const, text: "The saved summary still says the fixture answer is 42." }
				return
			default:
				assert.fail("Unexpected model continuation")
		}
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 2_200, maxTokens: 200, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		// The visible response alone crosses the post-turn threshold. Host-side
		// canonical evidence must not be needed to inflate the request count.
		return content.reduce<number>(
			(tokens, block) => tokens + (JSON.stringify(block).includes(ARCHIVE_MARKER) ? 1_600 : 3),
			0,
		)
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

class OverflowCompactionScriptedAI {
	readonly id = "compaction-overflow-scripted"
	readonly mainRequests: unknown[][] = []
	readonly mainRequestSizes: number[] = []
	readonly summaryRequests: unknown[][] = []
	private releaseSummary!: () => void
	private readonly summaryGate = new Promise<void>((resolve) => {
		this.releaseSummary = resolve
	})

	releaseSummaryRequest(): void {
		this.releaseSummary()
	}

	async *createMessage(
		systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; tools?: unknown[]; attemptId?: string },
	) {
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
		if (metadata.attemptId === "title") {
			yield { type: "text" as const, text: "Check context recovery" }
			return
		}
		if (systemPrompt.includes("tasked with summarizing conversations")) {
			this.summaryRequests.push(structuredClone(messages))
			assert.equal(metadata.tools?.length ?? 0, 0, "The summary request must not expose task tools")
			await this.summaryGate
			yield {
				type: "text" as const,
				text: `The command returned fixture answer=42 and ${OVERFLOW_MARKER}; keep both facts for the continuation.`,
			}
			return
		}

		this.mainRequests.push(structuredClone(messages))
		this.mainRequestSizes.push(JSON.stringify(messages).length)
		switch (this.mainRequests.length) {
			case 1:
				yield {
					type: "tool_call" as const,
					id: OVERFLOW_TOOL_CALL_ID,
					name: "exec_command",
					arguments: JSON.stringify({
						cmd: `node -p "require('fs').readFileSync('compaction-overflow-e2e.txt', 'utf8')"`,
					}),
				}
				return
			case 2:
				assert.ok(
					JSON.stringify(messages).includes(OVERFLOW_TOOL_CALL_ID),
					"The completed tool call must reach the rejected request",
				)
				assert.ok(
					JSON.stringify(messages).includes("fixture answer=42"),
					"The completed tool result must reach the rejected request",
				)
				throw new Error("This model's maximum context length was exceeded (context_length_exceeded)")
			case 3:
				assert.ok(
					JSON.stringify(messages).includes("## Conversation Summary"),
					"The retry must use compacted history",
				)
				assert.ok(
					JSON.stringify(messages).includes("fixture answer=42"),
					"The retry must retain the command result or its summary",
				)
				assert.ok(
					JSON.stringify(messages).includes(OVERFLOW_MARKER),
					"The retry must retain the second fact carried by the summary",
				)
				assert.ok(
					!JSON.stringify(messages).includes(STEERING_MARKER),
					"Queued steering must not preempt the recovered continuation",
				)
				yield { type: "text" as const, text: "The fixture answer is 42 after compaction." }
				return
			case 4:
				assert.ok(JSON.stringify(messages).includes("## Conversation Summary"))
				assert.ok(
					JSON.stringify(messages).includes(STEERING_MARKER),
					"Queued steering must run after the recovered continuation",
				)
				yield { type: "text" as const, text: "The fixture answer is 42, followed by the queued steering." }
				return
			default:
				assert.fail("Unexpected model continuation")
		}
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 30_000, maxTokens: 1_000, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return content.reduce<number>((tokens, block) => tokens + Math.ceil(JSON.stringify(block).length / 4), 0)
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

class RetainedFollowupScriptedAI {
	readonly id = "retained-followup-context-recovery-scripted"
	readonly mainRequests: Array<{ taskId: string; prompt: string; messages: unknown[] }> = []
	readonly summaryRequests: unknown[][] = []
	removeFromCache?: () => void
	private rejected = false

	async *createMessage(
		systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; tools?: unknown[]; attemptId?: string },
	) {
		assert.ok(metadata?.taskId, "Every retained-thread request must belong to the real task")
		if (metadata.attemptId === "title") {
			yield { type: "text" as const, text: "Check context recovery" }
			return
		}
		if (systemPrompt.includes("tasked with summarizing conversations")) {
			this.summaryRequests.push(structuredClone(messages))
			assert.equal(this.summaryRequests.length, 1, "One context rejection must cause one bounded compaction")
			assert.equal(metadata.tools?.length ?? 0, 0, "Compaction must not expose task tools")
			assert.ok(JSON.stringify(messages).includes(RETAINED_ARCHIVE_MARKER))
			yield {
				type: "text" as const,
				text: "The completed thread established that the retained fixture answer is 42.",
			}
			return
		}

		const prompt = messages
			.flatMap((message) => JSON.stringify(message).match(/RETAINED_THREAD_PROMPT_[A-Z_0-9]+/g) ?? [])
			.at(-1)
		assert.ok(prompt, "Each provider request must contain its submitted prompt marker")
		this.mainRequests.push({ taskId: metadata.taskId, prompt, messages: structuredClone(messages) })
		if (prompt === RECOVERY_PROMPT && !this.rejected) {
			assert.equal(this.summaryRequests.length, 0, "The retained history must reach the provider before recovery")
			const outgoingHistory = JSON.stringify(messages)
			for (let turn = 0; turn < RETAINED_TURNS; turn++) {
				assert.ok(
					outgoingHistory.includes(`${RETAINED_PROMPT_PREFIX}${String(turn).padStart(2, "0")}`),
					`The rejected request must retain earlier user prompt ${turn}`,
				)
			}
			assert.equal(
				messages.filter(
					(message) =>
						typeof message === "object" &&
						message !== null &&
						"role" in message &&
						message.role === "assistant" &&
						JSON.stringify(message).includes(RETAINED_ARCHIVE_MARKER),
				).length,
				RETAINED_TURNS,
				"The rejected request must carry every earlier completed answer",
			)
			this.rejected = true
			// Reject before yielding any chunk, as a provider can do when its actual context budget differs.
			throw new Error("This model's maximum context length was exceeded (context_length_exceeded)")
		}
		if (prompt === RECOVERY_PROMPT || prompt === AFTER_RECOVERY_PROMPT) {
			assert.equal(this.summaryRequests.length, 1)
			assert.ok(JSON.stringify(messages).includes("## Conversation Summary"))
			const isRetainedAnswer = (message: unknown) =>
				typeof message === "object" &&
				message !== null &&
				"role" in message &&
				message.role === "assistant" &&
				JSON.stringify(message).includes(RETAINED_ARCHIVE_MARKER)
			const retainedAnswers = messages.filter(isRetainedAnswer)
			assert.ok(
				retainedAnswers.length > 0 && retainedAnswers.length < RETAINED_TURNS,
				"Compaction must retire older answers and retain a nonempty recent tail",
			)
			const rejectedRequest = this.mainRequests.find((request) => request.prompt === RECOVERY_PROMPT)
			assert.ok(rejectedRequest, "The original rejected request must define the exact tail")
			const originalAnswers = rejectedRequest.messages.filter(isRetainedAnswer)
			assert.deepEqual(
				retainedAnswers,
				originalAnswers.slice(-retainedAnswers.length),
				"Compaction must preserve the recent assistant suffix unchanged",
			)
			assert.ok(JSON.stringify(messages).includes("retained fixture answer is 42"))
			yield { type: "text" as const, text: "The retained fixture answer remains 42 after context recovery." }
			return
		}

		assert.equal(this.summaryRequests.length, 0, "Completed follow-ups must accumulate the original history")
		yield {
			type: "text" as const,
			text: `${RETAINED_ARCHIVE_MARKER} Answer to ${prompt}: the retained fixture answer is 42. ${"retained answer evidence ".repeat(200)}`,
		}
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 128_000, maxTokens: 1_000, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return content.reduce<number>((tokens, block) => tokens + Math.ceil(JSON.stringify(block).length / 4), 0)
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

class SmallWindowExhaustionScriptedAI {
	readonly id = "small-copilot-window-exhaustion-scripted"
	readonly requests: Array<{ summary: boolean; tokens: number; rejected: boolean }> = []
	private answers = 0

	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: getVscodeLlmContextWindow(
					{ vendor: "copilot", family: "claude-sonnet-4.6", maxInputTokens: 936_000 },
					200_000,
				),
				contextWindowIncludesOutput: false,
				maxTokens: 128_000,
				supportsPromptCache: false,
			},
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.ceil(JSON.stringify(content).length / 4)
	}

	async *createMessage(
		systemPrompt: string,
		messages: unknown[],
		metadata?: { attemptId?: string; tools?: unknown[] },
	) {
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Check small-window overflow" }
			return
		}
		const summary = systemPrompt.includes("tasked with summarizing conversations")
		const tokens = Math.ceil(
			(systemPrompt.length + JSON.stringify(messages).length + JSON.stringify(metadata?.tools ?? []).length) / 4,
		)
		const rejected = tokens > this.getModel().info.contextWindow
		this.requests.push({ summary, tokens, rejected })
		if (rejected)
			throw new Error("Request exceeds the maximum context length of 200000 tokens (context_length_exceeded)")
		let text = "The fixture answer is 42. Continue with the most recent instruction."
		if (!summary) {
			const answerIndex = this.answers++
			text =
				answerIndex === 1 || answerIndex === 2
					? `SMALL_WINDOW_ARCHIVE ${"data".repeat(110_000)}`
					: "The fixture answer is 42; the panel can accept another prompt."
		}
		yield { type: "text" as const, text }
		yield { type: "usage" as const, inputTokens: tokens, outputTokens: Math.ceil(text.length / 4), totalCost: 0 }
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

type CompactionHost = {
	getLiveTask(taskId: string):
		| {
				instanceId: string
				isStreaming?: boolean
				isWaitingForFirstChunk?: boolean
				isTaskLoopActive?: boolean
				taskAsk?: { ask?: string }
				approveAsk(): void
				alphaMessages: Array<{
					ask?: string
					say?: string
					text?: string
					partial?: boolean
					contextCondense?: { condenseId?: string; prevContextTokens?: number; newContextTokens?: number }
				}>
				apiConversationHistory: HistoryMessage[]
				queuedMessages: Array<{ text: string }>
		  }
		| undefined
	getTaskWithId(taskId: string): Promise<{ apiConversationHistory: HistoryMessage[] }>
	showTaskWithId(taskId: string): Promise<void>
	getAgentLifecycleSnapshot(taskId: string): AgentLifecycleSnapshot | undefined
	getStateToPostToWebview(): Promise<Partial<ExtensionState>>
}

function assertCompletedTaskState(provider: CompactionHost, state: Partial<ExtensionState>, taskId: string) {
	const canonical = provider.getAgentLifecycleSnapshot(taskId)
	assert.equal(canonical?.status, "completed", "The canonical journal must retain terminal completion")
	assert.equal(state.liveTasksById?.[taskId]?.lifecycle, TaskLifecycleState.Completed)
	assert.equal(state.liveTasksById?.[taskId]?.turnId, canonical?.turnId)
	assert.equal(state.liveTasksById?.[taskId]?.hasPendingToolCalls, false)
	assert.equal(state.agentLifecycleSnapshots, undefined, "UI state must not retransmit the full lifecycle journal")
}

suite("Alpha native compaction acceptance", function () {
	setDefaultSuiteTimeout(this)

	for (const automatic of [true, false]) {
		test(`settles a full 200k Copilot window and accepts another prompt (automatic summary=${automatic})`, async () => {
			assert.equal(vscode.version, "1.138.0")
			assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
			const api = globalThis.api
			const provider = (api as unknown as { sidebarProvider?: CompactionHost }).sidebarProvider
			assert.ok(provider)
			const original = api.getConfiguration()
			const model = new SmallWindowExhaustionScriptedAI()
			const completions: string[] = []
			const onCompleted = (taskId: string) => completions.push(taskId)
			api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
			try {
				const taskId = await api.startNewTask({
					configuration: {
						...original,
						apiProvider: "fake-ai",
						fakeAi: model,
						mode: "code",
						approvalMode: "auto",
						requestDelaySeconds: 0,
						writeDelayMs: 0,
						enableCheckpoints: false,
						autoCondenseContext: automatic,
						autoCondenseContextPercent: 100,
						autoCondenseContextScope: "full-context",
						postTurnCondenseContextPercent: 0,
					},
					text: "Retain fixture answer=42 while filling the small context window.",
				})
				const instanceId = provider.getLiveTask(taskId)?.instanceId
				for (let turn = 1; turn <= 5; turn++) {
					if (turn > 1) await api.sendMessage(`Continue small-window test turn ${turn}; answer=42.`)
					await waitFor(
						() => {
							const task = provider.getLiveTask(taskId)
							if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
							return completions.filter((id) => id === taskId).length === turn
						},
						{ timeout: 30_000, description: `small-window turn ${turn} to settle` },
					)
					const state = await provider.getStateToPostToWebview()
					assert.equal(state.currentTaskId, taskId)
					assertCompletedTaskState(provider, state, taskId)
					const task = provider.getLiveTask(taskId)!
					assert.equal(task.instanceId, instanceId)
					assert.equal(task.isStreaming, false)
					assert.equal(task.isWaitingForFirstChunk, false)
					assert.equal(task.isTaskLoopActive, false)
				}
				const summaries = model.requests.filter(({ summary }) => summary)
				assert.equal(summaries.length, automatic ? 1 : 0)
				if (automatic) assert.ok(summaries[0]!.rejected, "The full window must also reject the summary input")
				const task = provider.getLiveTask(taskId)!
				assert.ok(task.alphaMessages.some(({ say }) => say === "sliding_window_truncation"))
				assert.ok(!task.alphaMessages.some(({ ask }) => ask === "api_req_failed" || ask === "resume_task"))
				const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
				assert.equal(
					persisted.filter(
						(message) =>
							message.role === "assistant" &&
							JSON.stringify(message.content).includes("SMALL_WINDOW_ARCHIVE"),
					).length,
					2,
				)
				assert.ok(
					persisted.some((message) =>
						JSON.stringify(message.content).includes("panel can accept another prompt"),
					),
				)
			} finally {
				api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
				await api.clearCurrentTask().catch(() => undefined)
				await api.setConfiguration(original)
			}
		})
	}

	test("makes irreducible 200k overflow resumable and can start a healthy task", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CompactionHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new SmallWindowExhaustionScriptedAI()
		const completions: string[] = []
		const onCompleted = (taskId: string) => completions.push(taskId)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				postTurnCondenseContextPercent: 0,
			}
			const oversized = `IRREDUCIBLE_SMALL_WINDOW_INPUT ${"data".repeat(220_000)}`
			const failedId = await api.startNewTask({ configuration, text: oversized })
			await waitFor(() => provider.getLiveTask(failedId)?.taskAsk?.ask === "resume_task", {
				timeout: 30_000,
				description: "irreducible overflow to reach visible recovery instead of hanging",
			})
			const failed = provider.getLiveTask(failedId)!
			assert.equal(failed.isStreaming, false)
			assert.equal(failed.isWaitingForFirstChunk, false)
			const requestRow = failed.alphaMessages.find(({ say }) => say === "api_req_started")
			assert.ok(requestRow?.text, "The rejected request must retain its visible error row")
			const requestError = JSON.parse(requestRow.text) as {
				cancelReason?: string
				streamingFailedMessage?: string
			}
			assert.equal(requestError.cancelReason, "streaming_failed")
			assert.ok(requestError.streamingFailedMessage?.includes("context_length_exceeded"))
			assert.equal(model.requests.length, 2, "Only the original input and one rejected summary may be requested")
			assert.ok(model.requests.every(({ rejected }) => rejected))
			assert.equal(completions.length, 0, "Exhaustion must not report successful completion")
			const persisted = (await provider.getTaskWithId(failedId)).apiConversationHistory
			assert.ok(persisted.some((message) => JSON.stringify(message.content).includes(oversized)))
			await provider.getStateToPostToWebview()
			await api.clearCurrentTask()
			const healthyId = await api.startNewTask({
				configuration,
				text: "Complete a short healthy task after overflow.",
			})
			await waitFor(() => completions.includes(healthyId), {
				timeout: 30_000,
				description: "a fresh task to complete after irreducible context exhaustion",
			})
			assert.equal(model.requests.length, 3)
			assert.equal(model.requests[2]!.rejected, false)
			assertCompletedTaskState(provider, await provider.getStateToPostToWebview(), healthyId)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
		}
	})

	test("recovers a long completed-thread follow-up in ask mode and accepts the next prompt", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CompactionHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new RetainedFollowupScriptedAI()
		const completions: string[] = []
		const createdTasks: string[] = []
		const onCompleted = (taskId: string) => completions.push(taskId)
		const onCreated = (taskId: string) => createdTasks.push(taskId)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		api.on(AlphaCodeEventName.TaskCreated, onCreated)
		try {
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "ask",
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				autoCondenseContextScope: "full-context",
				postTurnCondenseContextPercent: 0,
			}
			const firstPrompt = `${RETAINED_PROMPT_PREFIX}00`
			const taskId = await api.startNewTask({ configuration, text: firstPrompt })
			const instanceId = provider.getLiveTask(taskId)?.instanceId
			assert.ok(instanceId)
			const waitForCompletedTurn = async (count: number) => {
				await waitFor(
					() => {
						const task = provider.getLiveTask(taskId)
						assert.ok(task, "The same retained task must remain live")
						assert.equal(task.instanceId, instanceId, "Follow-ups must reuse the retained task instance")
						assert.ok(
							!task.alphaMessages.some(({ ask }) => ask === "api_req_failed" || ask === "resume_task"),
							"Context recovery must not require a manual Retry or resume prompt",
						)
						return completions.filter((id) => id === taskId).length === count
					},
					{
						timeout: 30_000,
						description: `retained-thread turn ${count} to complete without user intervention`,
					},
				)
			}
			await waitForCompletedTurn(1)
			for (let turn = 1; turn < RETAINED_TURNS; turn++) {
				await api.sendMessage(`${RETAINED_PROMPT_PREFIX}${String(turn).padStart(2, "0")}`)
				await waitForCompletedTurn(turn + 1)
			}
			assert.equal(model.mainRequests.length, RETAINED_TURNS)
			assert.equal(model.summaryRequests.length, 0)
			const createdTaskCount = createdTasks.length

			await api.sendMessage(RECOVERY_PROMPT)
			await waitForCompletedTurn(RETAINED_TURNS + 1)
			await api.sendMessage(AFTER_RECOVERY_PROMPT)
			await waitForCompletedTurn(RETAINED_TURNS + 2)

			assert.equal(createdTasks.length, createdTaskCount, "Recovery and follow-up must not create another task")
			assert.equal(model.mainRequests.length, RETAINED_TURNS + 3, "Only the rejected request may be retried")
			assert.equal(model.summaryRequests.length, 1, "Recovery must finish after one compaction")
			assert.ok(model.mainRequests.every((request) => request.taskId === taskId))
			for (let turn = 0; turn < RETAINED_TURNS; turn++) {
				const prompt = `${RETAINED_PROMPT_PREFIX}${String(turn).padStart(2, "0")}`
				assert.equal(model.mainRequests.filter((request) => request.prompt === prompt).length, 1)
			}
			assert.equal(model.mainRequests.filter((request) => request.prompt === RECOVERY_PROMPT).length, 2)
			assert.equal(model.mainRequests.filter((request) => request.prompt === AFTER_RECOVERY_PROMPT).length, 1)
			const rejected = model.mainRequests[RETAINED_TURNS]!
			const recovered = model.mainRequests[RETAINED_TURNS + 1]!
			assert.ok(
				JSON.stringify(recovered.messages).length < JSON.stringify(rejected.messages).length,
				"Compaction must reduce the effective provider history after the long follow-up is rejected",
			)
			const task = provider.getLiveTask(taskId)
			assert.ok(task)
			assert.equal(task.alphaMessages.filter(({ say }) => say === "completion_result").length, RETAINED_TURNS + 2)
			const receipt = task.alphaMessages.find(
				(message) => message.say === "condense_context" && !!message.contextCondense?.condenseId,
			)?.contextCondense
			assert.ok(receipt?.condenseId, "The long-thread recovery must publish a durable compaction receipt")
			assert.ok(receipt.newContextTokens !== undefined && receipt.prevContextTokens !== undefined)
			assert.ok(receipt.newContextTokens < receipt.prevContextTokens)
			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			assert.ok(persisted.some((message) => message.isSummary && message.condenseId === receipt.condenseId))
			assert.equal(
				persisted.filter(
					(message) =>
						message.role === "assistant" && JSON.stringify(message).includes(RETAINED_ARCHIVE_MARKER),
				).length,
				RETAINED_TURNS,
				"Compaction must preserve every completed answer in the rewind archive",
			)
			const state = await provider.getStateToPostToWebview()
			assert.equal(state.currentTaskId, taskId)
			assertCompletedTaskState(provider, state, taskId)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			api.off(AlphaCodeEventName.TaskCreated, onCreated)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
			model.removeFromCache?.()
		}
	})

	test("compacts after a turn, reloads the archive, and sends reduced context on follow-up", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const fixturePath = path.join(workspace, "compaction-e2e.txt")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CompactionHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new CompactionScriptedAI()
		const postTurnPercent = 60
		const modelInfo = model.getModel().info
		// Match the fixture's input allowance after output reservation and the 10% safety buffer.
		const allowedInputTokens =
			modelInfo.contextWindow - modelInfo.maxTokens - Math.floor(modelInfo.contextWindow * 0.1)
		const archiveTokens = await model.countTokens([{ type: "text", text: ARCHIVE_MARKER }])
		assert.ok(archiveTokens > (allowedInputTokens * postTurnPercent) / 100)
		assert.ok(archiveTokens < allowedInputTokens)
		const completions: string[] = []
		const createdTasks: string[] = []
		const onCompleted = (taskId: string) => completions.push(taskId)
		const onCreated = (taskId: string) => createdTasks.push(taskId)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		api.on(AlphaCodeEventName.TaskCreated, onCreated)
		try {
			await fs.writeFile(fixturePath, "fixture answer=42\n", { flag: "wx" })
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				allowedCommands: ["*"],
				deniedCommands: [],
				terminalShellIntegrationDisabled: true,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				autoCondenseContextScope: "full-context",
				postTurnCondenseContextPercent: postTurnPercent,
			}
			const taskId = await api.startNewTask({
				configuration,
				text: "Read compaction-e2e.txt and report the fixture answer.",
			})
			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.filter((id) => id === taskId).length === 1
				},
				{ timeout: 60_000, description: "the first completed task turn" },
			)
			await waitFor(
				() =>
					provider
						.getLiveTask(taskId)
						?.alphaMessages.some(
							(message) => message.say === "condense_context" && !!message.contextCondense?.condenseId,
						) ?? false,
				{ timeout: 30_000, description: "a durable post-turn compaction receipt" },
			)
			assert.equal(model.mainRequests.length, 2)
			assert.deepEqual(model.mainRequestTaskIds, [taskId, taskId])
			assert.equal(model.summaryRequests, 1)
			const completedTask = provider.getLiveTask(taskId)
			assert.ok(completedTask)
			assert.ok(
				completedTask.alphaMessages.some(
					({ say, text, partial }) =>
						(say === "text" || say === "completion_result") &&
						partial !== true &&
						text?.startsWith("The fixture answer is 42. ") === true &&
						text.includes(ARCHIVE_MARKER),
				),
				"The task must present the answer produced from the real command result",
			)
			const receipt = completedTask.alphaMessages.find(
				(message) => message.say === "condense_context" && !!message.contextCondense?.condenseId,
			)?.contextCondense
			assert.ok(receipt?.newContextTokens !== undefined)
			assert.ok(receipt.prevContextTokens !== undefined)
			assert.ok(receipt.newContextTokens < receipt.prevContextTokens, "The active context must shrink")
			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			const summary = persisted.find((message) => message.isSummary)
			assert.ok(summary?.condenseId, "The summary must be saved to provider history")
			assert.ok(
				JSON.stringify(summary).includes("The saved fixture answer is 42."),
				"The persisted summary itself must retain the fixture answer",
			)
			const toolCall = persisted.find(
				(message) => JSON.stringify(message.content).includes(TOOL_CALL_ID) && message.role === "assistant",
			)
			const toolResult = persisted.find(
				(message) => JSON.stringify(message.content).includes(TOOL_CALL_ID) && message.role === "user",
			)
			assert.ok(toolCall && toolResult, "The complete tool transaction must remain in the rewind archive")
			assert.equal(toolCall.condenseParent, summary.condenseId)
			assert.equal(toolResult.condenseParent, summary.condenseId)

			await api.clearCurrentTask()
			await provider.showTaskWithId(taskId)
			const reloaded = provider.getLiveTask(taskId)
			assert.ok(reloaded)
			assert.notEqual(
				reloaded.instanceId,
				completedTask.instanceId,
				"showTaskWithId must restore a new task instance",
			)
			const createdTaskCountAfterReload = createdTasks.length

			// This invoke follows showTaskWithId immediately. It must stay bound to the
			// reopened task while the webview is still projecting its transcript.
			await api.sendMessage("Continue from the saved summary and finish briefly.")
			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return model.mainRequests.length === 3 && completions.filter((id) => id === taskId).length === 2
				},
				{ timeout: 60_000, description: "the reloaded task follow-up to complete" },
			)
			assert.ok(JSON.stringify(persisted).includes(ARCHIVE_MARKER))
			assert.deepEqual(model.mainRequestTaskIds, [taskId, taskId, taskId])
			assert.equal(createdTasks.length, createdTaskCountAfterReload, "the follow-up must not create another task")
			assert.ok(!JSON.stringify(model.mainRequests[2]).includes(ARCHIVE_MARKER))
			assert.ok(JSON.stringify(model.mainRequests[2]).includes("## Conversation Summary"))
			assert.ok(
				provider
					.getLiveTask(taskId)
					?.alphaMessages.some(
						({ say, text, partial }) =>
							(say === "text" || say === "completion_result") &&
							partial !== true &&
							text === "The saved summary still says the fixture answer is 42.",
					),
				"The reloaded task must present a follow-up answer based on the persisted summary",
			)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			api.off(AlphaCodeEventName.TaskCreated, onCreated)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
			model.removeFromCache?.()
			await fs.rm(fixturePath, { force: true })
		}
	})

	test("recovers an overflowed tool continuation before delivering queued steering", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const fixturePath = path.join(workspace, "compaction-overflow-e2e.txt")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CompactionHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new OverflowCompactionScriptedAI()
		const completions: string[] = []
		const onCompleted = (taskId: string) => completions.push(taskId)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			await fs.writeFile(
				fixturePath,
				`fixture answer=42\n${OVERFLOW_MARKER} ${"tool evidence ".repeat(2_000)}\n`,
				{
					flag: "wx",
				},
			)
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				allowedCommands: ["*"],
				deniedCommands: [],
				terminalShellIntegrationDisabled: true,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				autoCondenseContextScope: "full-context",
				postTurnCondenseContextPercent: 0,
			}
			const taskId = await api.startNewTask({
				configuration,
				text: "Read compaction-overflow-e2e.txt and report the fixture answer.",
			})

			await waitFor(() => model.summaryRequests.length === 1, {
				timeout: 15_000,
				description: "the forced compaction to invoke the scripted summarizer",
			})
			assert.equal(model.mainRequests.length, 2, "The tool result must be followed by one rejected continuation")
			assert.equal(model.summaryRequests.length, 1, "The context rejection must start one forced compaction")
			await api.sendMessage(`Follow the recovered result and include ${STEERING_MARKER}.`)
			await waitFor(
				() =>
					provider
						.getLiveTask(taskId)
						?.queuedMessages.some((message) => message.text.includes(STEERING_MARKER)) ?? false,
				{ timeout: 15_000, description: "the steering message to enter the task queue during compaction" },
			)
			model.releaseSummaryRequest()

			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.filter((id) => id === taskId).length === 1
				},
				{ timeout: 60_000, description: "the recovered continuation and queued steering to complete once" },
			)

			assert.equal(model.mainRequests.length, 4, "Recovery must retry before it starts queued steering")
			assert.equal(model.summaryRequests.length, 1)
			const rejectedRequestSize = model.mainRequestSizes[1]
			const recoveredRequestSize = model.mainRequestSizes[2]
			assert.ok(rejectedRequestSize !== undefined && recoveredRequestSize !== undefined)
			assert.ok(
				recoveredRequestSize < rejectedRequestSize,
				"The recovered request must contain less serialized history",
			)
			assert.ok(JSON.stringify(model.summaryRequests[0]).includes("fixture answer=42"))
			assert.ok(JSON.stringify(model.summaryRequests[0]).includes(OVERFLOW_MARKER))
			const task = provider.getLiveTask(taskId)
			assert.ok(task)
			assert.equal(task.alphaMessages.filter((message) => message.say === "completion_result").length, 1)
			assert.ok(
				task.alphaMessages.some(
					({ say, text, partial }) =>
						(say === "text" || say === "completion_result") &&
						partial !== true &&
						text === "The fixture answer is 42, followed by the queued steering.",
				),
				"The completed task must present the queued follow-up answer after recovery",
			)
			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			const summary = persisted.find((message) => message.isSummary)
			assert.ok(summary?.condenseId, "The forced summary must be persisted")
			assert.ok(
				JSON.stringify(summary).includes("fixture answer=42"),
				"The forced summary itself must retain the fixture answer",
			)
			assert.ok(
				JSON.stringify(summary).includes(OVERFLOW_MARKER),
				"The forced summary itself must retain the second fixture fact",
			)
			const toolCall = persisted.find(
				(message) =>
					JSON.stringify(message.content).includes(OVERFLOW_TOOL_CALL_ID) && message.role === "assistant",
			)
			const toolResult = persisted.find(
				(message) => JSON.stringify(message.content).includes(OVERFLOW_TOOL_CALL_ID) && message.role === "user",
			)
			assert.ok(toolCall && toolResult, "The completed tool transaction must remain in the rewind archive")
			assert.equal(toolCall.condenseParent, summary.condenseId)
			assert.equal(toolResult.condenseParent, summary.condenseId)
		} finally {
			model.releaseSummaryRequest()
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
			await fs.rm(fixturePath, { force: true })
		}
	})
})
