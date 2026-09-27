import * as assert from "assert"
import * as vscode from "vscode"

import { AlphaCodeEventName, type AlphaCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const PLAN_CALL_ID = "update-plan-acceptance-call"
const PLAN_STEP = "Persist the canonical plan tool call"

type HistoryMessage = { role: string; content: unknown }

type UpdatePlanHost = {
	getLiveTask(taskId: string):
		| {
				taskAsk?: { ask?: string }
				approveAsk(): void
				apiConversationHistory: HistoryMessage[]
				todoList: Array<{ id: string; content: string; status: string }>
		  }
		| undefined
	getTaskWithId(taskId: string): Promise<{ apiConversationHistory: HistoryMessage[] }>
}

class UpdatePlanScriptedAI {
	readonly id = "update-plan-acceptance-scripted"
	readonly requests: Array<{ messages: unknown[]; tools: unknown[] }> = []
	removeFromCache?: () => void

	async *createMessage(
		_systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; tools?: unknown[] },
	) {
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
		this.requests.push({ messages: structuredClone(messages), tools: structuredClone(metadata.tools ?? []) })

		if (this.requests.length === 1) {
			const toolNames = (metadata.tools ?? []).flatMap((tool) => {
				if (!tool || typeof tool !== "object" || !("function" in tool)) return []
				const fn = (tool as { function?: { name?: unknown; parameters?: unknown } }).function
				return fn && typeof fn.name === "string" ? [fn.name] : []
			})
			assert.ok(toolNames.includes("update_plan"), "The fresh Code schema must expose update_plan")
			assert.ok(!toolNames.includes("update_todo_list"), "The fresh schema must hide the saved-history alias")
			const planSchema = (metadata.tools ?? []).find(
				(tool) =>
					!!tool &&
					typeof tool === "object" &&
					"function" in tool &&
					(tool as { function?: { name?: unknown } }).function?.name === "update_plan",
			) as { function?: { parameters?: { properties?: Record<string, unknown> } } } | undefined
			assert.ok(
				planSchema?.function?.parameters?.properties?.plan,
				"The provider schema must carry the plan payload",
			)

			yield {
				type: "tool_call" as const,
				id: PLAN_CALL_ID,
				name: "update_plan",
				arguments: JSON.stringify({ plan: [{ step: PLAN_STEP, status: "completed" }] }),
			}
			return
		}

		assert.equal(this.requests.length, 2, "The fixture permits one tool call and one continuation")
		const requestHistory = JSON.stringify(messages)
		assert.ok(requestHistory.includes(PLAN_CALL_ID), "The completed tool transaction must reach the continuation")
		assert.ok(
			requestHistory.includes('"name":"update_plan"'),
			"Provider history must retain the canonical call name",
		)
		assert.ok(requestHistory.includes('"type":"tool_result"'), "Provider history must include one terminal result")
		assert.ok(!requestHistory.includes('"name":"update_todo_list"'), "Fresh provider history must stay canonical")
		yield { type: "text" as const, text: "The plan was updated and retained in provider history." }
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 16_000, maxTokens: 1_000, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return content.reduce<number>((tokens, block) => tokens + Math.ceil(JSON.stringify(block).length / 4), 0)
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

suite("Alpha canonical update_plan acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("updates plan state and sends a paired canonical call/result to the next provider request", async () => {
		assert.equal(vscode.version, "1.122.1")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: UpdatePlanHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new UpdatePlanScriptedAI()
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
			const taskId = await api.startNewTask({ configuration, text: "Update and retain a one-step plan." })

			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.filter((id) => id === taskId).length === 1
				},
				{ timeout: 60_000, description: "the canonical update_plan task to complete once" },
			)

			assert.equal(model.requests.length, 2, "The model must continue once after the update_plan tool result")
			const task = provider.getLiveTask(taskId)
			assert.ok(task)
			assert.equal(task.todoList.length, 1)
			assert.deepEqual(
				task.todoList.map(({ content, status }) => ({ content, status })),
				[{ content: PLAN_STEP, status: "completed" }],
			)
			const updatedPlanStep = task.todoList[0]
			assert.ok(updatedPlanStep)
			assert.ok(updatedPlanStep.id, "The updated plan step must have a stable checklist identity")

			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			const assistantCall = persisted.find(
				(message) => message.role === "assistant" && JSON.stringify(message.content).includes(PLAN_CALL_ID),
			)
			const toolResult = persisted.find(
				(message) => message.role === "user" && JSON.stringify(message.content).includes(PLAN_CALL_ID),
			)
			assert.ok(assistantCall, "The canonical update_plan assistant call must be persisted")
			assert.ok(toolResult, "The update_plan call must have a paired persisted terminal result")
			assert.ok(JSON.stringify(assistantCall.content).includes('"name":"update_plan"'))
			assert.ok(JSON.stringify(toolResult.content).includes('"type":"tool_result"'))
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
			model.removeFromCache?.()
		}
	})
})
