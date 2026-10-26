import * as assert from "assert"
import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { AlphaCodeEventName, type AlphaCodeSettings, type McpServer } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"
import { createLocalMcpFixture } from "../scenarios/localMcpFixture"
import { FeatureScriptedAI, assertFeatureToolCall, assertFeatureToolResult } from "../scenarios/featureWorkflowFixture"

const SEARCH_CALL_ID = "tool-search-acceptance-call"
const SERVER_NAME = "tool-search-acceptance"
const TARGET_TOOL_NAME = "mcp--tool-search-acceptance--calendar_lookup_00"

type HistoryMessage = { role: string; content: unknown }

type SearchMcpHub = {
	isConnecting: boolean
	waitUntilReady(): Promise<void>
	getServers(): McpServer[]
	updateServerConnections(servers: Record<string, unknown>, source: "project"): Promise<void>
	refreshAllConnections(): Promise<void>
	restartConnection(name: string, source: "project"): Promise<void>
	callTool(
		name: string,
		tool: string,
		args: Record<string, unknown>,
		source: "project",
		signal: AbortSignal,
	): Promise<unknown>
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
		metadata?: { taskId?: string; attemptId?: string; tools?: unknown[] },
	) {
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Fixture task" }
			return
		}
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

		assert.ok(toolNames.includes("tool_search"), "tool_search must remain available on the next model step")
		assert.ok(toolNames.includes(TARGET_TOOL_NAME), "A successful search result must expose the selected tool next")
		const history = JSON.stringify(messages)
		assert.ok(history.includes(SEARCH_CALL_ID), "The discovery call ID must reach provider history")
		assert.ok(history.includes('"name":"tool_search"'), "Provider history must retain the canonical tool name")
		assert.ok(history.includes('"type":"tool_result"'), "Provider history must include the terminal result")
		assert.ok(history.includes(TARGET_TOOL_NAME), "The discovery result must reach the next provider request")
		const operations = [
			{ name: TARGET_TOOL_NAME, arguments: { query: "owned fixture" } },
			{ name: "list_mcp_resources", arguments: { server: SERVER_NAME } },
			{ name: "list_mcp_resources", arguments: { server: SERVER_NAME, cursor: "resource-page-2" } },
			{ name: "list_mcp_resource_templates", arguments: { server: SERVER_NAME } },
			{ name: "list_mcp_resource_templates", arguments: { server: SERVER_NAME, cursor: "template-page-2" } },
			{ name: "read_mcp_resource", arguments: { server: SERVER_NAME, uri: "fixture:///second" } },
		]
		const operation = operations[this.requests.length - 2]
		if (operation) {
			assert.ok(toolNames.includes(operation.name), `${operation.name} must be available before execution`)
			yield {
				type: "tool_call" as const,
				id: `local-mcp-${this.requests.length}`,
				name: operation.name,
				arguments: JSON.stringify(operation.arguments),
			}
			return
		}
		assert.equal(
			this.requests.length,
			8,
			"One discovery, six real operations and a final continuation are expected",
		)
		for (const marker of ["LOCAL_MCP_TOOL_RESULT", "LOCAL_MCP_RESOURCE_CONTENT", "second-template"])
			assert.ok(history.includes(marker), `The real MCP result ${marker} must reach the model`)
		yield { type: "text" as const, text: "The local MCP tool and paginated resources were verified." }
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 64_000, maxTokens: 1_000, supportsImages: false, supportsPromptCache: false },
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

	test("discovers and invokes a configured local MCP peer, pages resources, cancels and reconnects", async () => {
		assert.equal(vscode.version, "1.138.0")
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
		await hub.waitUntilReady()

		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const fixture = await createLocalMcpFixture(workspace)
		const settingsPath = path.join(workspace, ".alpha", "mcp.json")
		const originalSettings = await fs.readFile(settingsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined
			throw error
		})
		const savedSettings = (originalSettings ? JSON.parse(originalSettings) : {}) as {
			mcpServers?: Record<string, unknown>
		}
		const previousServers = Object.fromEntries(
			hub
				.getServers()
				.filter((server) => server.source === "project")
				.map((server) => [server.name, JSON.parse(server.config)]),
		)
		const original = api.getConfiguration()
		const model = new ToolSearchScriptedAI()
		const completions: string[] = []
		const onCompleted = (taskId: string) => completions.push(taskId)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		let taskId: string | undefined
		let replacementModel: FeatureScriptedAI | undefined
		try {
			await api.setConfiguration({ mcpEnabled: true })
			await waitFor(() => !hub.isConnecting, { description: "the initial MCP settings transition settling" })
			await fs.mkdir(path.dirname(settingsPath), { recursive: true })
			await fs.writeFile(
				settingsPath,
				JSON.stringify({
					...savedSettings,
					mcpServers: { ...savedSettings.mcpServers, [SERVER_NAME]: fixture.configuration },
				}),
			)
			await hub.refreshAllConnections()
			await waitFor(
				() => hub.getServers().find((server) => server.name === SERVER_NAME)?.status === "connected",
				{
					description: "the configured local MCP stdio peer connecting through production discovery",
				},
			)
			assert.equal(hub.getServers().find((server) => server.name === SERVER_NAME)?.status, "connected")
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mcpEnabled: true,
				mode: "code",
				approvalMode: "bypass",
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			taskId = await api.startNewTask({ configuration, text: "Verify the owned MCP tool and resource catalog." })

			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId!)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.includes(taskId!)
				},
				{ timeout: 60_000, description: "the tool_search task to complete once" },
			)

			assert.equal(model.requests.length, 8)
			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			assertFeatureToolCall(persisted, SEARCH_CALL_ID, "tool_search", { query: TARGET_TOOL_NAME, limit: 1 })
			assertFeatureToolResult(persisted, SEARCH_CALL_ID, { error: false, marker: TARGET_TOOL_NAME })
			const executedTools = [
				{ name: TARGET_TOOL_NAME, arguments: { query: "owned fixture" }, marker: "LOCAL_MCP_TOOL_RESULT" },
				{ name: "list_mcp_resources", arguments: { server: SERVER_NAME }, marker: "fixture:///first" },
				{
					name: "list_mcp_resources",
					arguments: { server: SERVER_NAME, cursor: "resource-page-2" },
					marker: "fixture:///second",
				},
				{
					name: "list_mcp_resource_templates",
					arguments: { server: SERVER_NAME },
					marker: "first-template",
				},
				{
					name: "list_mcp_resource_templates",
					arguments: { server: SERVER_NAME, cursor: "template-page-2" },
					marker: "second-template",
				},
				{
					name: "read_mcp_resource",
					arguments: { server: SERVER_NAME, uri: "fixture:///second" },
					marker: "LOCAL_MCP_RESOURCE_CONTENT",
				},
			]
			for (const [index, operation] of executedTools.entries()) {
				const step = index + 2
				const callId = `local-mcp-${step}`
				assertFeatureToolCall(persisted, callId, operation.name, operation.arguments)
				assertFeatureToolResult(persisted, callId, { error: false, marker: operation.marker })
			}
			const cancellation = new AbortController()
			const waiting = hub.callTool(SERVER_NAME, "fixture_wait", {}, "project", cancellation.signal)
			const cancelled = assert.rejects(waiting, /Owned MCP cancellation/)
			await waitFor(async () => (await fixture.readEvents()).some((event) => event.name === "fixture_wait"), {
				description: "the real MCP request entering its cancellation barrier",
			})
			cancellation.abort(new Error("Owned MCP cancellation"))
			await cancelled
			await hub.restartConnection(SERVER_NAME, "project")
			assert.equal(hub.getServers().find((server) => server.name === SERVER_NAME)?.status, "connected")
			const result = await hub.callTool(
				SERVER_NAME,
				"calendar_lookup_00",
				{},
				"project",
				new AbortController().signal,
			)
			assert.match(JSON.stringify(result), /LOCAL_MCP_TOOL_RESULT/)
			const events = await fixture.readEvents()
			assert.equal(events.filter((event) => event.method === "started").length, 2)
			assert.equal(events.filter((event) => event.name === "calendar_lookup_00").length, 2)
			assert.deepEqual(
				events
					.filter((event) => event.method === "tools/call" && event.name === "calendar_lookup_00")
					.map((event) => (event.arguments as { arguments: unknown }).arguments),
				[{ query: "owned fixture" }, {}],
				"The provider's exact query and the post-reconnect control must reach the peer",
			)
			assert.deepEqual(
				events
					.filter((event) => event.method === "resources/read")
					.map((event) => (event.arguments as { uri: unknown }).uri),
				["fixture:///second"],
			)
			for (const [method, cursor] of [
				["resources/list", "resource-page-2"],
				["resources/templates/list", "template-page-2"],
			])
				assert.ok(
					events.some(
						(event) =>
							event.method === method && (event.arguments as { cursor?: unknown }).cursor === cursor,
					),
				)
			replacementModel = new FeatureScriptedAI(async (request) => {
				if (request.ordinal === 1)
					return { name: "tool_search", arguments: { query: TARGET_TOOL_NAME, limit: 1 } }
				if (request.ordinal === 2) {
					// The request's immutable tool surface was captured before this provider callback.
					const capturedServer = hub.getServers().find((server) => server.name === SERVER_NAME)
					await fs.writeFile(
						settingsPath,
						JSON.stringify({
							...savedSettings,
							mcpServers: {
								...savedSettings.mcpServers,
								[SERVER_NAME]: { ...fixture.configuration, timeout: 11 },
							},
						}),
					)
					await hub.refreshAllConnections()
					await waitFor(
						() => {
							const currentServer = hub.getServers().find((server) => server.name === SERVER_NAME)
							return (
								currentServer !== capturedServer &&
								currentServer?.status === "connected" &&
								!hub.isConnecting
							)
						},
						{ description: "the configured replacement receiving a distinct live connection" },
					)
					return { name: TARGET_TOOL_NAME, arguments: { query: "must not reach the replacement" } }
				}
				assert.equal(request.ordinal, 3)
				assert.ok(
					JSON.stringify(request.messages).includes("captured connection and schema"),
					"A stale invocation must fail for the connection-identity contract",
				)
				return undefined
			})
			taskId = await api.startNewTask({
				configuration: { ...configuration, fakeAi: replacementModel },
				text: "Exercise a configured MCP connection replacement at the captured tool boundary.",
			})
			await waitFor(
				() => {
					replacementModel!.assertHealthy()
					const task = provider.getLiveTask(taskId!)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.includes(taskId!)
				},
				{
					timeout: 60_000,
					description: "the stale MCP invocation receiving its terminal failure",
				},
			)
			const replacementHistory = (await provider.getTaskWithId(taskId)).apiConversationHistory
			assertFeatureToolCall(replacementHistory, `${replacementModel.id}-2`, TARGET_TOOL_NAME, {
				query: "must not reach the replacement",
			})
			assertFeatureToolResult(replacementHistory, `${replacementModel.id}-2`, {
				error: true,
				marker: "captured connection and schema",
			})
			assert.equal(
				(await fixture.readEvents()).filter((event) => event.name === "calendar_lookup_00").length,
				2,
				"The replacement must receive no stale dispatch",
			)
			assert.match(
				JSON.stringify(
					await hub.callTool(SERVER_NAME, "calendar_lookup_00", {}, "project", new AbortController().signal),
				),
				/LOCAL_MCP_TOOL_RESULT/,
			)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			if (originalSettings === undefined) await fs.rm(settingsPath, { force: true })
			else await fs.writeFile(settingsPath, originalSettings)
			await hub.updateServerConnections(previousServers, "project")
			await api.setConfiguration(original)
			await fixture.dispose()
			replacementModel?.dispose()
		}
	})
})
