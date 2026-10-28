import * as assert from "assert"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	type AlphaCodeSettings,
	type AlphaMessage,
	type RequestUserInputQuestion,
} from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const ASYNC_CALL_ID = "request-user-input-async-acceptance"
const FIRST_QUESTION = "Choose a color for the status indicator."
const SECOND_QUESTION = "What label should appear beside it?"
const LATER_REPLY = "Use blue and label it Ready."
const WAITING_CALL_ID = "request-user-input-indefinite-acceptance"
const WAITING_QUESTIONS: RequestUserInputQuestion[] = [
	{
		id: "status_color",
		header: "Color",
		question: FIRST_QUESTION,
		options: [
			{ label: "Blue (Recommended)", description: "Use the default blue indicator." },
			{ label: "Green", description: "Use a green indicator instead." },
		],
	},
]
const WAITING_ANSWERS = { status_color: { answers: ["Green"] } }

type HistoryMessage = { role: string; content: unknown }
type InputTask = {
	taskAsk?: AlphaMessage
	alphaMessages: AlphaMessage[]
	approveAsk(): void
	getTaskApprovalMode(): "ask" | "auto" | "bypass"
	getActiveAskTimestamp(): number | undefined
	handleWebviewAskResponse(
		response: "messageResponse",
		text: string,
		images?: string[],
		queuedMessageIds?: string[],
		expectedAskTs?: number,
	): boolean
	markAsyncUserInputAnswered(messageTs: number): Promise<boolean>
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}
type AsyncInputHost = {
	getLiveTask(taskId: string): InputTask | undefined
	getTaskWithId(taskId: string): Promise<{ apiConversationHistory: HistoryMessage[]; uiMessagesFilePath: string }>
	showTaskWithId(taskId: string): Promise<void>
	cancelTask(taskId: string): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toolNames(tools: unknown[]): string[] {
	return tools.flatMap((tool) =>
		isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : [],
	)
}

function resultsFor(messages: readonly unknown[], callId: string): Record<string, unknown>[] {
	return messages.flatMap((message) => {
		if (!isRecord(message) || !Array.isArray(message.content)) return []
		return message.content.filter(
			(block): block is Record<string, unknown> =>
				isRecord(block) && block.type === "tool_result" && block.tool_use_id === callId,
		)
	})
}

class AsyncInputScriptedAI {
	readonly id: string = "request-user-input-async-scripted"
	readonly requests: Array<{ messages: unknown[]; tools: unknown[] }> = []
	removeFromCache?: () => void

	async *createMessage(
		_systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; attemptId?: string; tools?: unknown[] },
	) {
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Fixture task" }
			return
		}
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
		const tools = metadata.tools ?? []
		this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) })

		if (this.requests.length === 1) {
			assert.ok(
				toolNames(tools).includes("request_user_input_async"),
				"An opted-in capable root model must receive the async tool",
			)
			yield {
				type: "tool_call" as const,
				id: ASYNC_CALL_ID,
				name: "request_user_input_async",
				arguments: JSON.stringify({
					questions: [{ title: FIRST_QUESTION, options: ["Blue", "Green"] }, { title: SECOND_QUESTION }],
				}),
			}
			return
		}

		if (this.requests.length === 2) {
			const history = JSON.stringify(messages)
			assert.ok(history.includes(ASYNC_CALL_ID), "The async call ID must reach provider history")
			assert.ok(history.includes('"type":"tool_result"'), "The async call must have a terminal result")
			assert.ok(
				history.includes('\\"accepted\\":true'),
				"The tool result must immediately acknowledge acceptance",
			)
			assert.equal(
				history.split(FIRST_QUESTION).length - 1,
				1,
				"The question must appear only in tool arguments, not as a synthetic assistant message",
			)
			yield { type: "text" as const, text: "I asked both questions and can continue while you decide." }
			return
		}

		assert.equal(this.requests.length, 3, "The later user answer must produce one ordinary follow-up request")
		const history = JSON.stringify(messages)
		assert.ok(
			history.includes(LATER_REPLY),
			"The user's later answer must reach provider history as ordinary input",
		)
		assert.equal(
			history.split(FIRST_QUESTION).length - 1,
			1,
			"The async card must not be duplicated in provider history",
		)
		yield { type: "text" as const, text: "Blue with Ready is noted." }
	}

	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 16_000,
				maxTokens: 1_000,
				supportsImages: false,
				supportsPromptCache: false,
				experimental_supported_tools: ["request_user_input_async"],
			},
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return content.reduce<number>((tokens, block) => tokens + Math.ceil(JSON.stringify(block).length / 4), 0)
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

class WaitingInputScriptedAI extends AsyncInputScriptedAI {
	override readonly id = "request-user-input-indefinite-scripted"

	override async *createMessage(
		_systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; attemptId?: string; tools?: unknown[] },
	) {
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
		this.requests.push({ messages: structuredClone(messages), tools: structuredClone(metadata.tools ?? []) })
		if (this.requests.length === 1) {
			yield {
				type: "text" as const,
				text: "Choose the indicator color before I finish.",
				phase: "final_answer" as const,
			}
			yield {
				type: "tool_call" as const,
				id: WAITING_CALL_ID,
				name: "request_user_input",
				arguments: JSON.stringify({ questions: WAITING_QUESTIONS }),
			}
			return
		}

		assert.equal(this.requests.length, 2, "The addressed human answer must resume the model exactly once")
		const results = resultsFor(messages, WAITING_CALL_ID)
		assert.equal(results.length, 1, "The model must receive one terminal question result")
		assert.equal(typeof results[0]!.content, "string")
		assert.deepEqual(JSON.parse(results[0]!.content as string), { answers: WAITING_ANSWERS })
		yield { type: "text" as const, text: "The indicator will be green." }
	}
}

suite("Alpha async user input acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("posts one nonblocking question card, continues, then receives a normal user reply", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: AsyncInputHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new AsyncInputScriptedAI()
		const completions: string[] = []
		const onCompleted = (taskId: string) => completions.push(taskId)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "bypass",
				autoApprovalEnabled: true,
				alwaysAllowFollowupQuestions: true,
				followupAutoApproveTimeoutMs: 60_000,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			const taskId = await api.startNewTask({
				configuration,
				text: "Ask two optional UI questions, then continue.",
			})
			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.filter((id) => id === taskId).length === 1
				},
				{ timeout: 60_000, description: "the nonblocking async input turn to complete" },
			)
			assert.equal(model.requests.length, 2, "The tool must not wait for an answer before continuing")
			const task = provider.getLiveTask(taskId)
			assert.ok(task)
			assert.notEqual(task.taskAsk?.ask, "followup", "Async input must not leave a followup ask pending")
			const cards = task.alphaMessages.filter(
				(message) => message.type === "say" && message.say === "async_user_input",
			)
			assert.equal(cards.length, 1, "One tool call must produce one nonblocking card")
			const card = cards[0]
			assert.ok(card)
			assert.deepEqual(card.asyncUserInput?.questions, [
				{ title: FIRST_QUESTION, options: ["Blue", "Green"] },
				{ title: SECOND_QUESTION },
			])
			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			assert.ok(JSON.stringify(persisted).includes(ASYNC_CALL_ID), "The accepted tool transaction must persist")
			assert.equal(await task.markAsyncUserInputAnswered(card.ts), true)
			const { uiMessagesFilePath } = await provider.getTaskWithId(taskId)
			const savedCards = (
				JSON.parse(await fs.readFile(uiMessagesFilePath, "utf8")) as Array<{ ts: number; isAnswered?: boolean }>
			).filter((message) => message.ts === card.ts)
			assert.equal(savedCards[0]?.isAnswered, true, "The accepted card acknowledgement must persist")
			await api.sendMessage(LATER_REPLY)
			await waitFor(
				() => {
					const active = provider.getLiveTask(taskId)
					if (active?.taskAsk?.ask === "completion_result") active.approveAsk()
					return model.requests.length === 3 && completions.filter((id) => id === taskId).length === 2
				},
				{ timeout: 60_000, description: "the ordinary follow-up user reply to complete" },
			)
			await api.clearCurrentTask()
			await provider.showTaskWithId(taskId)
			await waitFor(
				() =>
					provider.getLiveTask(taskId)?.alphaMessages.find((message) => message.ts === card.ts)
						?.isAnswered === true,
				{ timeout: 10_000, description: "the answered async card to hydrate after task reload" },
			)
			const reopened = provider.getLiveTask(taskId)
			assert.ok(reopened)
			assert.equal(
				reopened.alphaMessages.find((message) => message.ts === card.ts)?.isAnswered,
				true,
				"The card must remain answered after task reload",
			)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			model.removeFromCache?.()
			await api.setConfiguration(original)
		}
	})

	for (const decision of ["answer", "cancel"] as const) {
		test(`keeps a capable Full Access model waiting indefinitely until an addressed ${decision}`, async () => {
			assert.equal(vscode.version, "1.138.0")
			assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
			const api = globalThis.api
			const provider = (api as unknown as { sidebarProvider?: AsyncInputHost }).sidebarProvider
			assert.ok(provider)
			const original = api.getConfiguration()
			const model = new WaitingInputScriptedAI()
			const completions: string[] = []
			const aborted: string[] = []
			const onCompleted = (taskId: string) => completions.push(taskId)
			const onAborted = (taskId: string) => aborted.push(taskId)
			api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
			api.on(AlphaCodeEventName.TaskAborted, onAborted)
			try {
				const taskId = await api.startNewTask({
					text: "Wait for my status color choice before completing.",
					presentationModelCalls: false,
					configuration: {
						...original,
						apiProvider: "fake-ai",
						fakeAi: model,
						mode: "code",
						approvalMode: "bypass",
						autoApprovalEnabled: true,
						alwaysAllowFollowupQuestions: true,
						followupAutoApproveTimeoutMs: 0,
						enableCheckpoints: false,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
					},
				})
				await waitFor(() => provider.getLiveTask(taskId)?.taskAsk?.ask === "followup", {
					timeout: 30_000,
					description: "the unanswered indefinite question to hold the provider turn",
				})
				const task = provider.getLiveTask(taskId)
				assert.ok(task)
				assert.equal(task.getTaskApprovalMode(), "bypass")
				await task.flushApiConversationHistoryPersistence()
				assert.equal(model.requests.length, 1, "An unanswered question must not start a continuation")
				assert.equal(completions.filter((id) => id === taskId).length, 0)
				const names = toolNames(model.requests[0]!.tools)
				assert.ok(names.includes("request_user_input"))
				assert.ok(!names.includes("request_user_input_async"), "Indefinite wait must withhold the async tool")
				const question = task.alphaMessages.find(
					(message) =>
						message.type === "ask" &&
						message.ask === "followup" &&
						!message.partial &&
						message.ts === task.getActiveAskTimestamp(),
				)
				assert.ok(question)
				assert.notEqual(question.isAnswered, true, "Full Access must not supply an automatic answer")
				assert.equal(task.alphaMessages.filter((message) => message.userInputResponse).length, 0)
				const askTimestamp = task.getActiveAskTimestamp()
				assert.equal(askTimestamp, question.ts)
				assert.notEqual(askTimestamp, undefined)
				const reply = JSON.stringify({ answers: WAITING_ANSWERS })
				assert.equal(
					task.handleWebviewAskResponse("messageResponse", reply, undefined, undefined, askTimestamp! - 1),
					false,
					"A response addressed to a different question must not release the wait",
				)
				assert.equal(task.getActiveAskTimestamp(), askTimestamp)
				assert.equal(model.requests.length, 1)

				if (decision === "cancel") {
					await provider.cancelTask(taskId)
					await task.waitForTermination()
					assert.equal(model.requests.length, 1, "Cancellation must not create a provider continuation")
					assert.equal(completions.filter((id) => id === taskId).length, 0)
					assert.equal(aborted.filter((id) => id === taskId).length, 1)
					assert.equal(task.getActiveAskTimestamp(), undefined)
					assert.equal(
						task.handleWebviewAskResponse("messageResponse", reply, undefined, undefined, askTimestamp),
						false,
						"A late answer must not revive a cancelled question",
					)
					const saved = await provider.getTaskWithId(taskId)
					assert.equal(resultsFor(saved.apiConversationHistory, WAITING_CALL_ID).length, 1)
					return
				}

				assert.equal(
					task.handleWebviewAskResponse("messageResponse", reply, undefined, undefined, askTimestamp),
					true,
				)
				assert.equal(
					task.handleWebviewAskResponse("messageResponse", reply, undefined, undefined, askTimestamp),
					false,
					"A duplicate answer must not produce another question result",
				)
				await waitFor(
					() => {
						if (task.taskAsk?.ask === "completion_result") task.approveAsk()
						return completions.filter((id) => id === taskId).length === 1
					},
					{ timeout: 30_000, description: "the one addressed answer to resume and complete the turn" },
				)
				await task.waitForTermination()
				await task.flushApiConversationHistoryPersistence()
				assert.equal(model.requests.length, 2)
				assert.equal(completions.filter((id) => id === taskId).length, 1)
				assert.equal(task.alphaMessages.find((message) => message.ts === question.ts)?.isAnswered, true)
				assert.equal(task.alphaMessages.filter((message) => message.userInputResponse).length, 1)
				assert.equal(task.getActiveAskTimestamp(), undefined)
				assert.equal(
					task.handleWebviewAskResponse("messageResponse", reply, undefined, undefined, askTimestamp),
					false,
					"A late answer must not create another completed turn",
				)
				const saved = await provider.getTaskWithId(taskId)
				const results = resultsFor(saved.apiConversationHistory, WAITING_CALL_ID)
				assert.equal(results.length, 1)
				assert.equal(typeof results[0]!.content, "string")
				assert.deepEqual(JSON.parse(results[0]!.content as string), { answers: WAITING_ANSWERS })
			} finally {
				api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
				api.off(AlphaCodeEventName.TaskAborted, onAborted)
				await api.clearCurrentTask().catch(() => undefined)
				model.removeFromCache?.()
				await api.setConfiguration(original)
			}
		})
	}
})
