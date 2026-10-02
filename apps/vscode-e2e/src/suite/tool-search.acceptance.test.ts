import * as assert from "assert"
import * as vscode from "vscode"

import { AlphaCodeEventName, type AlphaCodeSettings, type McpServer } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const SEARCH_CALL_ID = "tool-search-acceptance-call"
const SERVER_NAME = "tool-search-acceptance"
const TARGET_TOOL_NAME = "mcp--tool-search-acceptance--calendar_lookup_00"

type HistoryMessage = { role: string; content: unknown }

type SearchMcpHub = {
	connections: unknown[]
	getServers(): McpServer[]
}

type SearchHost = {
	getMcpHub(): SearchMcpHub | undefined
	getLiveTask(taskId: string): { taskAsk?: { ask?: string }; approveAsk(): void } | undefined
	getTaskWithId(taskId: string): Promise<{ apiConversationHistory: HistoryMessage[] }>
}

class ToolSearchScriptedAI {
	readonly id = "tool-search-acceptance-scripted"
	readonly requests: Array<{ messages: unknown[]; tools: unknown[] }> = []

	async *createMessage(
		_systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; tools?: unknown[] },
	) {
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
		const tools = metadata.tools ?? []
		this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) })
		const toolNames = tools.flatMap((tool) => {
			if (!tool || typeof tool !== "object" || !("function" in tool)) return []
			const fn = (tool as { function?: { name?: unknown } }).function
			return fn && typeof fn.name === "string" ? [fn.name] : []
		})

		if (this.requests.length === 1) {
			assert.ok(toolNames.includes("tool_search"), "The first provider request must expose canonical tool_search")
			assert.ok(!toolNames.includes(TARGET_TOOL_NAME), "The deferred MCP tool must stay hidden until searched")
			yield {
				type: "tool_call" as const,
				id: SEARCH_CALL_ID,
				name: "tool_search",
				arguments: JSON.stringify({ query: TARGET_TOOL_NAME, limit: 1 }),
			}
			return
		}

		assert.equal(this.requests.length, 2, "The fixture permits one discovery call and one continuation")
		assert.ok(toolNames.includes("tool_search"), "tool_search must remain available on the next model step")
		assert.ok(toolNames.includes(TARGET_TOOL_NAME), "A successful search result must expose the selected tool next")
		const history = JSON.stringify(messages)
		assert.ok(history.includes(SEARCH_CALL_ID), "The discovery call ID must reach provider history")
		assert.ok(history.includes('"name":"tool_search"'), "Provider history must retain the canonical tool name")
		assert.ok(history.includes('"type":"tool_result"'), "Provider history must include the terminal result")
		assert.ok(history.includes(TARGET_TOOL_NAME), "The discovery result must reach the next provider request")
		yield { type: "text" as const, text: "The deferred calendar tool was found and made available." }
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

suite("Alpha canonical tool_search acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("executes discovery and sends the selected tool with a paired call/result history to the next request", async () => {
		assert.equal(vscode.version, "1.125.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: SearchHost }).sidebarProvider
		assert.ok(provider)
		await waitFor(() => Boolean(provider.getMcpHub()), {
			timeout: 30_000,
			description: "the initialized MCP hub",
		})
		const hub = provider.getMcpHub()
		assert.ok(hub, "The extension host must expose its initialized MCP hub")

		const targetTool = {
			name: "calendar_lookup_00",
			description: `Search calendar events by date and attendee. ${"Calendar event lookup capability. ".repeat(72)}`,
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
				additionalProperties: false,
			},
		}
		const server: McpServer = {
			name: SERVER_NAME,
			config: "{}",
			status: "connected",
			source: "project",
			tools: Array.from({ length: 8 }, (_, index) => ({
				...targetTool,
				name: `calendar_lookup_${String(index).padStart(2, "0")}`,
			})),
		}
		const connection = { type: "connected", server, client: {}, transport: {} }
		hub.connections.push(connection)

		const original = api.getConfiguration()
		const model = new ToolSearchScriptedAI()
		const completions: string[] = []
		const onCompleted = (taskId: string) => completions.push(taskId)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		let taskId: string | undefined
		try {
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mcpEnabled: true,
				mode: "code",
				autoApprovalEnabled: true,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			taskId = await api.startNewTask({ configuration, text: "Find the deferred calendar lookup tool." })

			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId!)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.includes(taskId!)
				},
				{ timeout: 60_000, description: "the tool_search task to complete once" },
			)

			assert.equal(model.requests.length, 2)
			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			const assistantCall = persisted.find(
				(message) => message.role === "assistant" && JSON.stringify(message.content).includes(SEARCH_CALL_ID),
			)
			const toolResult = persisted.find(
				(message) => message.role === "user" && JSON.stringify(message.content).includes(SEARCH_CALL_ID),
			)
			assert.ok(assistantCall, "The tool_search call must be persisted")
			assert.ok(toolResult, "The tool_search call must have a paired terminal result")
			assert.ok(JSON.stringify(assistantCall.content).includes('"name":"tool_search"'))
			assert.ok(JSON.stringify(toolResult.content).includes('"tool_use_id":"tool-search-acceptance-call"'))
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
			const connectionIndex = hub.connections.indexOf(connection)
			if (connectionIndex >= 0) hub.connections.splice(connectionIndex, 1)
		}
	})
})
