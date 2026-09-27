import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { AlphaCodeEventName, type AlphaCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const TOOL_CALL_ID = "compaction-acceptance-read"
const ARCHIVE_MARKER = "ARCHIVE_PAYLOAD_MARKER"
const OVERFLOW_TOOL_CALL_ID = "compaction-overflow-read"
const OVERFLOW_MARKER = "OVERFLOW_ARCHIVE_PAYLOAD"
const STEERING_MARKER = "QUEUED_STEERING_AFTER_OVERFLOW"
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

	async *createMessage(systemPrompt: string, messages: unknown[], metadata?: { taskId?: string; tools?: unknown[] }) {
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
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
		// A bounded synthetic tokenizer makes the archived response large while leaving fixed prompt costs stable.
		return content.reduce<number>(
			(tokens, block) => tokens + (JSON.stringify(block).includes(ARCHIVE_MARKER) ? 600 : 3),
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

	async *createMessage(systemPrompt: string, messages: unknown[], metadata?: { taskId?: string; tools?: unknown[] }) {
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
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

type CompactionHost = {
	getLiveTask(taskId: string):
		| {
				instanceId: string
				taskAsk?: { ask?: string }
				approveAsk(): void
				clineMessages: Array<{
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
}

suite("Alpha native compaction acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("compacts after a turn, reloads the archive, and sends reduced context on follow-up", async () => {
		assert.equal(vscode.version, "1.122.1")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const fixturePath = path.join(workspace, "compaction-e2e.txt")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: CompactionHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new CompactionScriptedAI()
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
				postTurnCondenseContextPercent: 60,
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
						?.clineMessages.some(
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
				completedTask.clineMessages.some(
					({ say, text, partial }) =>
						(say === "text" || say === "completion_result") &&
						partial !== true &&
						text?.startsWith("The fixture answer is 42. ") === true &&
						text.includes(ARCHIVE_MARKER),
				),
				"The task must present the answer produced from the real command result",
			)
			const receipt = completedTask.clineMessages.find(
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
					?.clineMessages.some(
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
		assert.equal(vscode.version, "1.122.1")
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
			assert.equal(task.clineMessages.filter((message) => message.say === "completion_result").length, 1)
			assert.ok(
				task.clineMessages.some(
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
