import * as assert from "assert"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { AlphaCodeEventName, type AlphaCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const ASYNC_CALL_ID = "request-user-input-async-acceptance"
const FIRST_QUESTION = "Choose a color for the status indicator."
const SECOND_QUESTION = "What label should appear beside it?"
const LATER_REPLY = "Use blue and label it Ready."

type HistoryMessage = { role: string; content: unknown }
type AsyncInputHost = {
	getLiveTask(taskId: string):
		| {
				taskAsk?: { ask?: string }
				approveAsk(): void
				markAsyncUserInputAnswered(messageTs: number): Promise<boolean>
				clineMessages: Array<{
					ts: number
					type: string
					say?: string
					isAnswered?: boolean
					asyncUserInput?: { questions: Array<{ title: string; options?: string[] }> }
				}>
		  }
		| undefined
	getTaskWithId(taskId: string): Promise<{ apiConversationHistory: HistoryMessage[]; uiMessagesFilePath: string }>
	showTaskWithId(taskId: string): Promise<void>
}

class AsyncInputScriptedAI {
	readonly id = "request-user-input-async-scripted"
	readonly requests: Array<{ messages: unknown[]; tools: unknown[] }> = []

	async *createMessage(
		_systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; tools?: unknown[] },
	) {
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
		const tools = metadata.tools ?? []
		this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) })

		if (this.requests.length === 1) {
			const names = tools.flatMap((tool) => {
				if (!tool || typeof tool !== "object" || !("function" in tool)) return []
				const fn = (tool as { function?: { name?: unknown } }).function
				return fn && typeof fn.name === "string" ? [fn.name] : []
			})
			assert.ok(names.includes("request_user_input_async"), "A capable root model must receive the async tool")
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

suite("Alpha async user input acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("posts one nonblocking question card, continues, then receives a normal user reply", async () => {
		assert.equal(vscode.version, "1.125.0")
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
				approvalMode: "auto",
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
			const cards = task.clineMessages.filter(
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
					provider.getLiveTask(taskId)?.clineMessages.find((message) => message.ts === card.ts)
						?.isAnswered === true,
				{ timeout: 10_000, description: "the answered async card to hydrate after task reload" },
			)
			const reopened = provider.getLiveTask(taskId)
			assert.ok(reopened)
			assert.equal(
				reopened.clineMessages.find((message) => message.ts === card.ts)?.isAnswered,
				true,
				"The card must remain answered after task reload",
			)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
		}
	})
})
