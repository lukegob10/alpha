import * as assert from "assert"
import * as vscode from "vscode"

import { AlphaCodeEventName, type AlphaCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const LIST_CALL_ID = "alpha-tickets-eager-list"
const TICKET_TOOLS = ["list_tickets", "read_ticket", "create_ticket", "update_ticket", "delete_ticket"]

type HistoryMessage = { role: string; content: unknown }
type TicketHost = {
	getLiveTask(taskId: string): { taskAsk?: { ask?: string }; approveAsk(): void } | undefined
	getTaskWithId(taskId: string): Promise<{ apiConversationHistory: HistoryMessage[] }>
}

function findSuccessfulList(value: unknown, depth = 0): { result: { tickets: unknown[]; total: number } } | undefined {
	if (depth > 8) return undefined
	if (typeof value === "string") {
		try {
			return findSuccessfulList(JSON.parse(value), depth + 1)
		} catch {
			return undefined
		}
	}
	if (!value || typeof value !== "object") return undefined
	if (Array.isArray(value)) {
		for (const part of value) {
			const found = findSuccessfulList(part, depth + 1)
			if (found) return found
		}
		return undefined
	}
	const record = value as Record<string, unknown>
	if (record.status === "success" && record.result && typeof record.result === "object") {
		const result = record.result as Record<string, unknown>
		if (Array.isArray(result.tickets) && typeof result.total === "number") {
			return { result: { tickets: result.tickets, total: result.total } }
		}
	}
	for (const part of Object.values(record)) {
		const found = findSuccessfulList(part, depth + 1)
		if (found) return found
	}
	return undefined
}

class TicketsScriptedAI {
	readonly id = "alpha-tickets-eager-scripted"
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
			for (const name of TICKET_TOOLS) {
				assert.ok(names.includes(name), `${name} must be eager in the first Alpha Tickets model request`)
			}
			yield {
				type: "tool_call" as const,
				id: LIST_CALL_ID,
				name: "list_tickets",
				arguments: JSON.stringify({ status: "in-progress" }),
			}
			return
		}

		assert.equal(this.requests.length, 2, "The fixture permits one list and one continuation")
		const history = JSON.stringify(messages)
		assert.ok(history.includes(LIST_CALL_ID), "The list call ID must reach provider history")
		assert.ok(history.includes('"name":"list_tickets"'), "The canonical list call must reach provider history")
		assert.ok(history.includes('"type":"tool_result"'), "The list must have a terminal tool result")
		const listed = findSuccessfulList(messages)
		assert.ok(listed, "The native Ticket store must return a structured successful list")
		assert.equal(listed.result.total, 0, "The isolated test workspace must start with no Tickets")
		assert.deepEqual(listed.result.tickets, [])
		yield { type: "text" as const, text: "There are no in-progress Alpha Tickets in this workspace." }
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

suite("Alpha Tickets eager tool acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("offers all Ticket tools immediately and executes a real list with paired history", async () => {
		assert.equal(vscode.version, "1.125.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: TicketHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new TicketsScriptedAI()
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
			const taskId = await api.startNewTask({ configuration, text: "Which Alpha Tickets are in progress?" })
			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.filter((id) => id === taskId).length === 1
				},
				{ timeout: 60_000, description: "the eager Alpha Tickets lookup to complete once" },
			)
			assert.equal(model.requests.length, 2)
			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			assert.ok(JSON.stringify(persisted).includes(LIST_CALL_ID), "The accepted list call must persist")
			assert.ok(findSuccessfulList(persisted), "The successful Ticket list result must persist")
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
		}
	})
})
