import type Anthropic from "@anthropic-ai/sdk"
import {
	openAiModelInfoSaneDefaults,
	vertexModels,
	type CustomToolDefinition,
	type McpServer,
	type McpTool,
	type ModelInfo,
} from "@alpha-code/types"
import { applyCopilotToolPreferences } from "../../../api/providers/utils/router-tool-preferences"
import { planModeSlug } from "../../../shared/modes"
import { customToolRegistry } from "@alpha-code/core"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

import { createAgentResponse, type AgentToolCall } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { clearTaskSessionApprovalGrants } from "../../auto-approval/taskSessionApprovalGrants"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import type { TaskToolSurface } from "../../tools/TaskToolSurface"
import { getEffectiveApiHistory } from "../../condense"
import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import { McpHub } from "../../../services/mcp/McpHub"
import type { Task } from "../Task"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../build-tools"
import { TaskToolCatalogCache, DISCOVERY_OUTPUT_LIMIT } from "../TaskToolCatalogCache"
import {
	createToolSearchTool,
	TOOL_SEARCH_SOURCE_INVENTORY_MAX_BYTES,
} from "../../prompts/tools/native-tools/discover_tools"

const target = "mcp--calendar--lookup_00"
const targetAlias = "mcp__calendar__lookup_00"

function fixture(count = 12) {
	const server: McpServer = {
		name: "calendar",
		status: "connected",
		config: "{}",
		source: "project",
		tools: Array.from({ length: count }, (_, index) => ({
			name: `lookup_${String(index).padStart(2, "0")}`,
			description: `Calendar operation ${index}. ${"Returns scoped calendar records with stable identifiers. ".repeat(34)}`,
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
				additionalProperties: false,
			},
		})),
	}
	const connection = { type: "connected", server, client: {}, transport: {} }
	const hub = { connections: [connection], getServers: () => (server.disabled ? [] : [server]) }
	const provider = { context: {}, getMcpHub: () => hub as unknown as McpHub }
	const options: BuildToolsOptions = {
		provider: provider as unknown as BuildToolsOptions["provider"],
		cwd: process.cwd(),
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: { apiProvider: "openai" },
		catalogCache: new TaskToolCatalogCache(),
		discoveryHistory: [],
	}
	return { server, connection, hub, options }
}

async function capture(options: BuildToolsOptions): Promise<TaskToolSurface> {
	const result = await buildNativeToolsArrayWithRestrictions(options)
	expect(result.tools).toEqual(result.surface?.schemas)
	return result.surface!
}

function call(name: string, args: Record<string, unknown> = {}, id = name): AgentToolCall {
	return { type: "tool_call", id, name, arguments: args }
}

function host(): ToolExecutionHost {
	const results: Anthropic.ToolResultBlockParam[] = []
	return {
		taskId: "catalog-fixture",
		cwd: process.cwd(),
		userMessageContent: results,
		ask: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn(async () => {}),
		recordToolUsage: vi.fn(),
		taskFacade: {} as Task,
		pushToolResultToUserContent(result) {
			if (results.some((existing) => existing.tool_use_id === result.tool_use_id)) return false
			results.push(result)
			return true
		},
	}
}

async function execute(
	surface: TaskToolSurface,
	calls: AgentToolCall[],
	input: {
		signal?: AbortSignal
		mode?: string
		executionHost?: ToolExecutionHost
		failFence?: boolean
		experiments?: Record<string, boolean>
	} = {},
) {
	const executionHost = input.executionHost ?? host()
	const fence = vi.fn(() => {
		if (input.failFence) throw new Error("Fixture receipt was not persisted")
	})
	const outcome = await new ToolScheduler({
		executionHost,
		registry: surface.registry,
		policy: surface.policy,
		mode: input.mode ?? "code",
		experiments: input.experiments,
		signal: input.signal,
		preserveAbortedResults: true,
		beforeEffect: fence,
	}).run(createAgentResponse(calls))
	expect(outcome.results).toHaveLength(calls.length)
	expect(executionHost.userMessageContent.filter((block) => block.type === "tool_result")).toHaveLength(calls.length)
	return { outcome, executionHost, fence }
}

function receipt(calls: AgentToolCall[], executionHost: ToolExecutionHost): ApiMessage[] {
	return [
		{
			role: "assistant",
			content: calls.map((item) => ({ type: "tool_use", id: item.id, name: item.name, input: item.arguments })),
		},
		{ role: "user", content: executionHost.userMessageContent },
	]
}

async function discover(surface: TaskToolSurface) {
	const calls = [call("tool_search", { query: "lookup_00", limit: 1 }, "discovery-1")]
	const result = await execute(surface, calls)
	expect(result.outcome.results[0].status).toBe("success")
	return receipt(calls, result.executionHost)
}

async function discoverNames(surface: TaskToolSurface, query: string, limit = 3): Promise<string[]> {
	const result = await execute(surface, [call("tool_search", { query, limit }, `discovery-${query}`)])
	expect(result.outcome.results[0].status).toBe("success")
	const content = result.outcome.results[0].content
	if (typeof content !== "string") throw new Error("Discovery fixture must contain a text result")
	return (JSON.parse(content) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
}

function mockMcpEffect() {
	const effect = vi.fn()
	vi.spyOn(useMcpToolTool, "handle").mockImplementation(async (_task, block, callbacks) => {
		if (await callbacks.askApproval("use_mcp_server", "fixture MCP approval")) {
			effect(block.nativeArgs)
			callbacks.pushToolResult("Calendar record found.")
		}
	})
	return effect
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function realMcpHost(options: BuildToolsOptions, servers: McpServer[]) {
	const requests = servers.map(() =>
		vi.fn(async () => ({ content: [{ type: "text", text: "Calendar record found." }] })),
	)
	const hub = Object.create(McpHub.prototype) as McpHub
	// Object.create skips field initializers; real dispatch and catalog refresh retain their production ownership state.
	for (const field of ["connectionControllers", "catalogRefreshControllers", "catalogChanges", "catalogRevisions"])
		Reflect.set(hub, field, new Map())
	Reflect.set(hub, "latestCatalogRefresh", new WeakMap())
	Reflect.set(hub, "catalogErrors", new WeakMap())
	hub.connections = servers.map((server, index) => ({
		type: "connected",
		server,
		client: { request: requests[index] },
		transport: {},
	})) as unknown as McpHub["connections"]
	Object.assign(options.provider, { getMcpHub: () => hub, postMessageToWebview: vi.fn() })
	const executionHost = host()
	executionHost.taskFacade = {
		providerRef: new WeakRef(options.provider),
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		say: vi.fn(async () => {}),
	} as unknown as Task
	return { executionHost, requests, hub }
}

function holdMcpCatalogRefresh(hub: McpHub) {
	const started = deferred()
	const tools = deferred<McpTool[]>()
	const catalogs = hub as unknown as {
		fetchToolsList(): Promise<McpTool[]>
		fetchResourcesList(): Promise<[]>
		fetchResourceTemplatesList(): Promise<[]>
		notifyWebviewOfServerChanges(): Promise<void>
	}
	vi.spyOn(catalogs, "fetchToolsList").mockImplementation(async () => {
		started.resolve()
		return tools.promise
	})
	vi.spyOn(catalogs, "fetchResourcesList").mockResolvedValue([])
	vi.spyOn(catalogs, "fetchResourceTemplatesList").mockResolvedValue([])
	vi.spyOn(catalogs, "notifyWebviewOfServerChanges").mockResolvedValue()
	const connection = hub.connections[0]
	if (connection.type !== "connected") throw new Error("Expected connected MCP fixture")
	const notification = hub["queueCatalogRefresh"](connection)
	return { started: started.promise, tools, notification }
}

afterEach(() => vi.restoreAllMocks())

describe("notified MCP catalog captures", () => {
	it("blocks old bindings during refresh and waits before capturing the successor even when schemas are unchanged", async () => {
		const { server, options } = fixture(1)
		const { hub, requests, executionHost } = realMcpHost(options, [server])
		const original = await capture(options)
		const refresh = holdMcpCatalogRefresh(hub)
		await refresh.started
		let captured = false
		const successor = capture(options).then((surface) => {
			captured = true
			return surface
		})
		const stale = await execute(original, [call(target)], { executionHost })
		const capturedDuringRefresh = captured
		refresh.tools.resolve(server.tools!)
		await refresh.notification
		const next = await successor

		expect(stale.outcome.results[0].status).toBe("error")
		expect(requests[0]).not.toHaveBeenCalled()
		expect(capturedDuringRefresh).toBe(false)
		expect(next).not.toBe(original)
		const stillStale = await execute(original, [call(target, {}, "old-after-refresh")])
		expect(stillStale.outcome.results[0].status).toBe("error")
		const nextHost = host()
		nextHost.taskFacade = executionHost.taskFacade
		const current = await execute(next, [call(target, {}, "new-after-refresh")], { executionHost: nextHost })
		expect(current.outcome.results[0].status).toBe("success")
	})

	it("releases a cancelled capture without cancelling the shared notified refresh", async () => {
		const { server, options } = fixture(1)
		const { hub, executionHost } = realMcpHost(options, [server])
		const original = await capture(options)
		const refresh = holdMcpCatalogRefresh(hub)
		await refresh.started
		const controller = new AbortController()
		const waiting = capture({ ...options, signal: controller.signal })
		const settled = waiting.catch((error: unknown) => error)
		await execute(original, [call(target)], { executionHost })
		const reason = new Error("cancelled catalog capture")
		controller.abort(reason)
		const result = await settled
		refresh.tools.resolve(server.tools!)
		await refresh.notification

		expect(result).toBe(reason)
		expect((await capture(options)).isCallable(target)).toBe(true)
	})

	it.each([false, true])(
		"isolates a failed server while preserving builtins and other servers (replay declarations: %s)",
		async (replay) => {
			const { server, options } = fixture(1)
			options.includeAllToolsWithRestrictions = replay
			const working: McpServer = {
				...server,
				name: "docs",
				tools: [{ ...server.tools![0], name: "read_docs" }],
			}
			const workingName = "mcp--docs--read_docs"
			const { hub, requests, executionHost } = realMcpHost(options, [server, working])
			const original = await capture(options)
			const refresh = holdMcpCatalogRefresh(hub)
			await refresh.started
			refresh.tools.reject(new Error("notified catalog unavailable"))
			await refresh.notification

			const isolated = await capture(options)
			expect(isolated.isCallable(target)).toBe(false)
			expect(
				isolated.schemas.some((schema) => schema.type === "function" && schema.function.name === target),
			).toBe(replay)
			const continued = host()
			continued.taskFacade = executionHost.taskFacade
			const progress = await execute(
				isolated,
				[
					call("update_plan", { plan: [{ step: "Continue with available tools", status: "in_progress" }] }),
					call(workingName, { query: "working server" }),
				],
				{ executionHost: continued },
			)
			expect(progress.outcome.results.map((result) => result.status)).toEqual(["success", "success"])
			const continuedTask = continued.taskFacade
			if (!continuedTask) throw new Error("Expected a task facade for the continued MCP fixture")
			expect(continuedTask.todoList?.[0]?.content).toBe("Continue with available tools")
			expect(requests[1]).toHaveBeenCalledOnce()
			const stale = await execute(original, [call(target)], { executionHost })
			expect(stale.outcome.results[0].status).toBe("error")
			expect(requests[0]).not.toHaveBeenCalled()
			const recovery = holdMcpCatalogRefresh(hub)
			await recovery.started
			recovery.tools.resolve(server.tools!)
			await recovery.notification
			expect((await capture(options)).isCallable(target)).toBe(true)
			const stillStale = await execute(original, [call(target, {}, "before-recovery")])
			expect(stillStale.outcome.results[0].status).toBe("error")
		},
	)
})

describe("TaskToolCatalogCache", () => {
	it.each([0, 12])("retains captured memory authority through a cached catalog with %i MCP tools", async (count) => {
		const { options } = fixture(count)
		options.memoryToolsEnabled = true
		const memoryNames = ["memories_list", "memories_read", "memories_search", "memories_add_ad_hoc_note"]
		const enabled = await capture(options)
		for (const name of memoryNames) {
			expect(enabled.schemas.some((schema) => schema.type === "function" && schema.function.name === name)).toBe(
				true,
			)
			expect(enabled.isCallable(name)).toBe(true)
		}
		expect(await capture(options)).toBe(enabled)

		options.memoryToolsEnabled = false
		const disabled = await capture(options)
		for (const name of memoryNames) {
			expect(disabled.schemas.some((schema) => schema.type === "function" && schema.function.name === name)).toBe(
				false,
			)
			expect(disabled.isCallable(name)).toBe(false)
		}
	})

	it("captures only validated MCP read-only hints and rejects annotation drift before dispatch", async () => {
		const { options, server } = fixture(4)
		server.tools![0].annotations = { readOnlyHint: true, destructiveHint: false }
		server.tools![1].annotations = undefined
		server.tools![2].annotations = { readOnlyHint: false }
		server.tools![3].annotations = { readOnlyHint: true, destructiveHint: true }
		const surface = await capture(options)
		const readDescriptor = surface.registry.resolve(target)!
		expect(readDescriptor.capabilities).toMatchObject({
			concurrency: "serial",
			sideEffects: "external",
			requiresApproval: true,
			parallelMcpRead: true,
		})
		expect(surface.policy.capabilities[target]?.parallelMcpRead).toBe(true)
		for (const name of ["mcp--calendar--lookup_01", "mcp--calendar--lookup_02", "mcp--calendar--lookup_03"]) {
			expect(surface.registry.resolve(name)?.capabilities.parallelMcpRead).toBeUndefined()
			expect(surface.policy.capabilities[name]?.parallelMcpRead).toBeUndefined()
		}

		const effect = mockMcpEffect()
		const executionHost = host()
		executionHost.ask = async () => {
			server.tools![0].annotations = { readOnlyHint: false }
			return { response: "yesButtonClicked" }
		}
		const result = await execute(surface, [call(target, { query: "today" })], { executionHost })
		expect(result.outcome.results[0].status).toBe("error")
		expect(effect).not.toHaveBeenCalled()
	})

	it("ranks a complete deferred tool name above broader metadata matches", async () => {
		const { options } = fixture()
		const surface = await capture(options)

		expect(await discoverNames(surface, target, 1)).toEqual([target])
	})

	it("advertises Codex tool_search with default limit 8 through the captured discovery registry", async () => {
		const { options } = fixture()
		const surface = await capture(options)
		const schema = surface.schemas.find((item) => item.type === "function" && item.function.name === "tool_search")
		expect(schema).toMatchObject({
			function: {
				name: "tool_search",
				parameters: { required: ["query"], properties: { limit: { minimum: 1, maximum: 32 } } },
			},
		})
		expect(
			surface.schemas.some((item) => item.type === "function" && item.function.name === "discover_tools"),
		).toBe(false)
		expect(surface.isCallable("tool_search")).toBe(true)
		expect(surface.registry.resolve("tool_search")?.name).toBe("tool_search")
		expect(surface.registry.resolve("discover_tools")?.name).toBe("tool_search")
		expect(surface.registry.resolve("tool_search")?.schema).toEqual(schema)
		expect(surface.policy.visibleTools).toContain("tool_search")
		expect(surface.policy.visibleTools).not.toContain("discover_tools")

		const result = await execute(surface, [call("tool_search", { query: "calendar operation" })])
		expect(result.outcome.results[0].status).toBe("success")
		const content = result.outcome.results[0].content
		if (typeof content !== "string") throw new Error("Discovery fixture must contain a text result")
		expect(JSON.parse(content).tools).toHaveLength(8)
	})

	it("defers registered custom tools through the same catalog while leaving Alpha Tickets eager", async () => {
		const names = Array.from({ length: 8 }, (_, index) => `calendar_custom_fixture_${index}`)
		const targetName = "calendar_custom_fixture_3"
		for (const [index, name] of names.entries()) {
			const definition: CustomToolDefinition = {
				name,
				description: `Calendar catalog capability ${index}. ${"Find and inspect calendar appointments. ".repeat(80)}`,
				execute: async () => "custom result",
			}
			customToolRegistry.register(definition)
		}
		try {
			const { options } = fixture(0)
			options.experiments = { customTools: true }
			const initial = await capture(options)
			for (const name of names) expect(initial.isCallable(name)).toBe(false)
			expect(initial.isCallable("tool_search")).toBe(true)
			expect(initial.isCallable("list_tickets")).toBe(true)
			expect(
				initial.schemas.some((schema) => schema.type === "function" && schema.function.name === "list_tickets"),
			).toBe(true)

			const calls = [call("tool_search", { query: targetName, limit: 1 }, "custom-tool-search")]
			const result = await execute(initial, calls)
			expect(result.outcome.results[0].status).toBe("success")
			const content = result.outcome.results[0].content
			if (typeof content !== "string") throw new Error("Discovery fixture must contain a text result")
			expect(JSON.parse(content).tools.map((tool: { name: string }) => tool.name)).toEqual([targetName])

			const next = await capture({ ...options, discoveryHistory: receipt(calls, result.executionHost) })
			expect(next.isCallable(targetName)).toBe(true)
			expect(next.registry.resolve(targetName)?.exposure).toBe("deferred")
		} finally {
			for (const name of names) customToolRegistry.unregister(name)
		}
	})

	it("restores persisted legacy discover_tools calls alongside the new tool_search schema", async () => {
		const { options } = fixture()
		const initial = await capture(options)
		const calls = [call("discover_tools", { query: "lookup_00", limit: 1 }, "legacy-discovery")]
		const result = await execute(initial, calls)
		expect(result.outcome.results[0].status).toBe("success")
		expect(result.outcome.results[0]).toMatchObject({ callId: "legacy-discovery", name: "discover_tools" })
		expect(result.executionHost.userMessageContent[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "legacy-discovery",
		})
		const next = await capture({ ...options, discoveryHistory: receipt(calls, result.executionHost) })
		const names = next.schemas.flatMap((schema) => (schema.type === "function" ? [schema.function.name] : []))

		expect(names).toContain("tool_search")
		expect(names).toContain("discover_tools")
		expect(next.isCallable(target)).toBe(true)
	})

	it("uses natural-language synonyms across tool names and descriptions", async () => {
		const { options, server } = fixture()
		server.tools![0].name = "search_meetings"
		server.tools![0].description = `Search calendar meetings and appointments. ${server.tools![0].description}`
		server.tools![1].name = "delete_event"
		server.tools![1].description = `Remove scheduled calendar appointments. ${server.tools![1].description}`
		const surface = await capture(options)
		const names = await discoverNames(surface, "find me a calendar meeting", 3)

		expect(names).toContain("mcp--calendar--search_meetings")
		expect(names[0]).toBe("mcp--calendar--search_meetings")
	})

	it("indexes nested schema properties and descriptions and promotes the selected schema next step", async () => {
		const { options, server } = fixture()
		server.tools![0].description = "Perform the configured operation."
		server.tools![0].inputSchema = {
			type: "object",
			properties: {
				event: {
					type: "object",
					properties: {
						venue_timezone: {
							type: "string",
							description: "The geographic offset used for local event times.",
						},
					},
				},
			},
		}
		const initial = await capture(options)
		expect(initial.isCallable(target)).toBe(false)
		expect(await discoverNames(initial, "venue timezone", 1)).toEqual([target])
		expect(await discoverNames(initial, "geographic offset", 1)).toEqual([target])

		const calls = [call("tool_search", { query: "venue timezone", limit: 1 }, "nested-schema-search")]
		const discovery = await execute(initial, calls)
		const content = discovery.outcome.results[0].content
		if (typeof content !== "string") throw new Error("Discovery fixture must contain a text result")
		const selectedSchema = (JSON.parse(content) as { tools: Array<{ name: string; schema: unknown }> }).tools[0]
		expect(selectedSchema.name).toBe(target)

		const next = await capture({ ...options, discoveryHistory: receipt(calls, discovery.executionHost) })
		expect(next.isCallable(target)).toBe(true)
		expect(next.resolve(target)?.schema).toEqual(selectedSchema.schema)

		const effect = mockMcpEffect()
		const result = await execute(next, [call(target, { event: { venue_timezone: "Europe/Paris" } })])
		expect(result.outcome.results[0].status).toBe("success")
		expect(effect).toHaveBeenCalledWith({
			server_name: "calendar",
			tool_name: "lookup_00",
			arguments: { event: { venue_timezone: "Europe/Paris" } },
		})
	})

	it("bounds nested schema search by recursion depth and indexed text", async () => {
		const { options, server } = fixture()
		let deepSchema: Record<string, unknown> = {
			type: "string",
			description: "hidden_depth_signal",
		}
		for (let level = 0; level < 10; level++) {
			deepSchema = { type: "object", properties: { [`level_${level}`]: deepSchema } }
		}
		server.tools![0].description = "Perform the deep operation."
		server.tools![0].inputSchema = deepSchema
		server.tools![1].description = "Perform the text operation."
		server.tools![1].inputSchema = {
			type: "object",
			properties: { payload: { type: "string", description: `${" ".repeat(8_000)}late_text_signal` } },
		}
		const surface = await capture(options)

		expect(await discoverNames(surface, "hidden depth signal", 1)).toEqual([])
		expect(await discoverNames(surface, "late sentinel signal", 1)).toEqual([])
	})

	it("does not return unrelated tools and preserves lexical order for equal matches", async () => {
		const { options } = fixture()
		const surface = await capture(options)

		expect(await discoverNames(surface, "quantum entanglement")).toEqual([])
		expect(await discoverNames(surface, "calendar operation", 3)).toEqual([
			"mcp--calendar--lookup_00",
			"mcp--calendar--lookup_01",
			"mcp--calendar--lookup_02",
		])
	})

	it.each(["primary", "subagent"] as const)(
		"captures the Codex patch schema and executable policy together for %s tasks",
		async (taskKind) => {
			const { options } = fixture(0)
			Object.assign(options, { taskKind, apiConfiguration: { apiProvider: "vscode-lm" } })
			for (const family of ["gpt-5.5", "claude-opus-4.7", "gemini-3.1-pro"]) {
				options.modelIdentity = { provider: "vscode-lm", vendor: "copilot", family }
				options.modelInfo = applyCopilotToolPreferences(
					{ vendor: "copilot", family },
					openAiModelInfoSaneDefaults,
				)
				const current = await capture(options)
				const names = current.schemas.map((schema) => schema.type === "function" && schema.function.name)
				expect(names).toContain("apply_patch")
				expect(current.resolve("apply_patch")).toBeDefined()
				for (const name of ["apply_diff", "search_replace", "edit_file", "edit", "write_to_file"]) {
					expect(names).not.toContain(name)
					expect(current.isCallable(name)).toBe(false)
				}
				const rejected = await execute(current, [call("apply_diff", { path: "fixture.ts", diff: "hidden" })])
				expect(rejected.outcome.results[0].status).toBe("error")
				expect(rejected.fence).not.toHaveBeenCalled()
				const disabled = await capture({ ...options, disabledTools: ["apply_patch"] })
				expect(disabled.isCallable("apply_patch")).toBe(false)
				const plan = await capture({ ...options, mode: planModeSlug })
				expect(plan.isCallable("apply_patch")).toBe(false)
				const readOnly = await capture({
					...options,
					mode: "review-only",
					customModes: [
						{ slug: "review-only", name: "Review", roleDefinition: "Review files", groups: ["read"] },
					],
				})
				expect(readOnly.isCallable("apply_patch")).toBe(false)
				const restrictedChild = await capture({ ...options, allowedToolNames: ["read_file"] })
				expect(restrictedChild.isCallable("apply_patch")).toBe(false)
			}
		},
	)

	it("reuses the same Codex catalog across model preference metadata", async () => {
		const { options } = fixture(0)
		options.apiConfiguration = { apiProvider: "vscode-lm" }
		options.modelIdentity = { provider: "vscode-lm", vendor: "copilot", family: "gpt-5.5" }
		options.modelInfo = applyCopilotToolPreferences(
			{ vendor: "copilot", family: "gpt-5.5" },
			openAiModelInfoSaneDefaults,
		)
		const original = await capture(options)
		options.modelInfo = applyCopilotToolPreferences(
			{ vendor: "copilot", family: "claude-opus-4.7" },
			openAiModelInfoSaneDefaults,
		)
		options.modelIdentity = { provider: "vscode-lm", vendor: "copilot", family: "claude-opus-4.7" }
		const next = await capture(options)
		expect(original.isCallable("apply_patch")).toBe(true)
		expect(original.isCallable("edit")).toBe(false)
		expect(next.isCallable("apply_patch")).toBe(true)
		expect(next.isCallable("edit")).toBe(false)
		expect(next.digest).toBe(original.digest)
		expect(next.schemas).toEqual(original.schemas)
	})

	it.each(["search_replace", "edit_file"])(
		"does not re-advertise the retired %s editor in the Copilot catalog",
		async (preferred) => {
			const { options } = fixture(0)
			options.modelIdentity = { provider: "vscode-lm", vendor: "copilot", family: "gpt-5.5" }
			options.modelInfo = applyCopilotToolPreferences(
				{ vendor: "copilot", family: "gpt-5.5" },
				{ ...openAiModelInfoSaneDefaults, includedTools: [preferred], excludedTools: ["apply_diff"] },
			)
			const current = await capture(options)
			expect(current.isCallable(preferred)).toBe(false)
			expect(current.isCallable("apply_patch")).toBe(true)
			expect(current.isCallable("edit")).toBe(false)
		},
	)

	it("uses the Codex patch tool across provider identities", async () => {
		const { options } = fixture(0)
		for (const [apiProvider, modelIdentity] of [
			["vertex", { provider: "vertex", id: "gemini-3.7-flash" }],
			["stellar", { provider: "stellar", id: "Meta-Llama-3.3-70B-Instruct" }],
			["openai", { provider: "openai", id: "gpt-5.5" }],
		] as const) {
			const existing = await capture({
				...options,
				apiConfiguration: { apiProvider },
				modelIdentity,
				modelInfo: openAiModelInfoSaneDefaults,
			})
			expect(existing.isCallable("apply_diff")).toBe(false)
			expect(existing.isCallable("apply_patch")).toBe(true)
			expect(existing.isCallable("edit")).toBe(false)
		}
		for (const [modelId, model] of Object.entries(vertexModels)) {
			const modelInfo = model as ModelInfo
			if (!modelInfo.includedTools?.length && !modelInfo.excludedTools?.length) continue
			const existing = await capture({
				...options,
				apiConfiguration: { apiProvider: "vertex" },
				modelIdentity: { provider: "vertex", id: modelId },
				modelInfo,
			})
			expect(existing.isCallable("apply_diff")).toBe(false)
			expect(existing.isCallable("search_replace")).toBe(false)
			expect(existing.isCallable("edit_file")).toBe(false)
			expect(existing.isCallable("apply_patch")).toBe(true)
			expect(existing.isCallable("edit")).toBe(false)
		}
	})

	it("keeps Codex patch schema across stale model metadata in a provider superset", async () => {
		const { options } = fixture(0)
		const result = await capture({
			...options,
			apiConfiguration: { apiProvider: "vertex" },
			modelIdentity: { provider: "vertex", id: "gemini-3.7-flash" },
			modelInfo: { ...openAiModelInfoSaneDefaults, includedTools: ["apply_patch"] },
			includeAllToolsWithRestrictions: true,
		})
		const names = result.schemas.flatMap((schema) => (schema.type === "function" ? [schema.function.name] : []))
		expect(names).toContain("apply_patch")
		expect(names).not.toContain("edit")
		expect(result.isCallable("apply_patch")).toBe(true)
		expect(result.isCallable("edit")).toBe(false)
	})

	it("reuses deterministic frozen schemas and a sealed registry for equivalent inputs", async () => {
		const { options, server } = fixture()
		const first = await capture(options)
		server.tools!.reverse()
		const second = await capture({ ...options, disabledTools: [] })
		expect(second).toBe(first)
		expect(second.registry).toBe(first.registry)
		expect(first.registry.isSealed()).toBe(true)
		expect(Object.isFrozen(first.schemas)).toBe(true)
		expect(Object.isFrozen(first.registry.resolve(target))).toBe(true)
		expect(
			first.schemas.some((schema) => schema.type === "function" && schema.function.name === "tool_search"),
		).toBe(true)
		expect(first.isCallable(target)).toBe(false)
		expect(first.isCallable("read_file")).toBe(false)
	})

	it("promotes only persisted successful discovery results at the next boundary and executes through the same registry", async () => {
		const { options } = fixture()
		const effect = mockMcpEffect()
		const initial = await capture(options)
		const originalSchemas = JSON.stringify(initial.schemas)
		const history = await discover(initial)
		expect(await capture(options)).toBe(initial)
		expect(initial.isCallable(target)).toBe(false)
		const next = await capture({ ...options, discoveryHistory: history })
		expect(next.registry).toBe(initial.registry)
		expect(next.isCallable(target)).toBe(true)
		expect(next.isCallable(targetAlias)).toBe(true)
		expect(initial.isCallable(targetAlias)).toBe(false)
		expect(JSON.stringify(initial.schemas)).toBe(originalSchemas)
		const result = await execute(next, [call(targetAlias, { query: "today" })])
		expect(result.outcome.results[0].status).toBe("success")
		expect(result.fence).toHaveBeenCalledOnce()
		expect(effect).toHaveBeenCalledWith({
			server_name: "calendar",
			tool_name: "lookup_00",
			arguments: { query: "today" },
		})
	})

	it("denies direct, alias and generic bypasses in the same response as discovery", async () => {
		const { options } = fixture()
		const effect = mockMcpEffect()
		const initial = await capture(options)
		const result = await execute(initial, [
			call("tool_search", { query: "lookup_00", limit: 1 }),
			call(target),
			call(targetAlias),
			call("use_mcp_tool", { server_name: "calendar", tool_name: "lookup_00" }),
		])
		expect(result.outcome.results.map((item) => item.status)).toEqual(["success", "denied", "denied", "error"])
		expect(result.executionHost.userMessageContent.slice(1)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tool_use_id: target, is_error: true }),
				expect.objectContaining({ tool_use_id: targetAlias, is_error: true }),
				expect.objectContaining({ tool_use_id: "use_mcp_tool", is_error: true }),
			]),
		)
		expect(effect).not.toHaveBeenCalled()
		expect(initial.resolve(target)).toBeUndefined()
	})

	it.each(["disabled", "alias-disabled", "prompt-disabled", "removed", "schema", "mode", "child", "policy"])(
		"invalidates the next surface after %s revocation without changing the in-flight surface",
		async (change) => {
			const { options, server } = fixture()
			const first = await capture(options)
			options.discoveryHistory = await discover(first)
			const loaded = await capture(options)
			const saved = JSON.stringify(loaded.schemas)
			switch (change) {
				case "disabled":
					options.disabledTools = [target]
					break
				case "alias-disabled":
					options.disabledTools = [targetAlias]
					break
				case "prompt-disabled":
					server.tools![0].enabledForPrompt = false
					break
				case "removed":
					server.tools!.shift()
					break
				case "schema":
					server.tools![0].inputSchema = { type: "object", required: ["new_argument"] }
					break
				case "mode":
					options.mode = "architect"
					break
				case "child":
					options.taskKind = "subagent"
					options.allowedToolNames = ["read_file"]
					break
				case "policy":
					options.policy = createToolPolicySnapshot({ visibleTools: ["read_file"] })
					break
			}
			const next = await capture(options)
			expect(next).not.toBe(loaded)
			expect(next.isCallable(target)).toBe(false)
			expect(next.isCallable(targetAlias)).toBe(false)
			expect(next.isCallable("use_mcp_tool")).toBe(false)
			expect(loaded.isCallable(target)).toBe(true)
			expect(JSON.stringify(loaded.schemas)).toBe(saved)
		},
	)

	it.each(["disconnect", "reconnect", "schema", "prompt-disabled", "removed"])(
		"blocks an MCP effect when %s changes while approval is pending",
		async (change) => {
			const { options, server, connection } = fixture()
			const initial = await capture(options)
			options.discoveryHistory = await discover(initial)
			const loaded = await capture(options)
			const effect = mockMcpEffect()
			const executionHost = host()
			executionHost.ask = async () => {
				if (change === "disconnect") server.status = "disconnected"
				if (change === "reconnect") connection.client = {}
				if (change === "schema") server.tools![0].inputSchema = { type: "object", required: ["replacement"] }
				if (change === "prompt-disabled") server.tools![0].enabledForPrompt = false
				if (change === "removed") server.tools!.shift()
				return { response: "yesButtonClicked" }
			}
			const result = await execute(loaded, [call(target, { query: "today" })], { executionHost })
			expect(result.outcome.results[0].status).toBe("error")
			expect(effect).not.toHaveBeenCalled()
		},
	)

	it.each(["unchanged", "client", "connection", "catalog", "schema", "unrelated"] as const)(
		"binds an MCP session approval to its captured authority after %s changes",
		async (change) => {
			const { options, server, connection, hub } = fixture(2)
			let catalogRevision = 1
			Object.assign(hub, { getServerCatalogRevision: () => catalogRevision })
			const taskId = `catalog-session-authority-${change}`
			const requestToolApproval = vi.fn(async () => ({ decision: "approve_session" as const }))
			const effect = mockMcpEffect()
			const run = async (id: string) => {
				const executionHost = { ...host(), taskId, requestToolApproval }
				const result = await execute(await capture(options), [call(target, { query: "today" }, id)], {
					executionHost,
				})
				expect(result.outcome.results[0].status).toBe("success")
			}
			try {
				await run("first")
				if (change === "unchanged") options.catalogCache = new TaskToolCatalogCache()
				if (change === "client") connection.client = {}
				if (change === "connection") hub.connections = [{ ...connection }]
				if (change === "catalog") catalogRevision++
				if (change === "schema") server.tools![0].inputSchema = { type: "object", properties: {} }
				if (change === "unrelated") server.tools![1].description += " Updated."
				await run("second")
				expect(effect).toHaveBeenCalledTimes(2)
				expect(requestToolApproval).toHaveBeenCalledTimes(
					change === "unchanged" || change === "unrelated" ? 1 : 2,
				)
			} finally {
				clearTaskSessionApprovalGrants(taskId)
			}
		},
	)

	it.each([false, true])(
		"binds a custom session approval to its captured callback (replaced=%s)",
		async (replaced) => {
			const { options } = fixture(1)
			options.experiments = { customTools: true }
			const definition: CustomToolDefinition = {
				name: "session_authority_fixture",
				description: "Fixture custom effect",
				execute: vi.fn(async () => "First implementation"),
			}
			vi.spyOn(customToolRegistry, "loadFromDirectoriesIfStale").mockImplementation(async () => ({
				loaded: [definition.name],
				failed: [],
				catalog: [definition],
			}))
			const taskId = `catalog-custom-session-authority-${replaced}`
			const requestToolApproval = vi.fn(async () => ({ decision: "approve_session" as const }))
			const run = async (id: string) => {
				const result = await execute(await capture(options), [call(definition.name, {}, id)], {
					executionHost: { ...host(), taskId, requestToolApproval },
					experiments: options.experiments,
				})
				expect(result.outcome.results[0].status).toBe("success")
			}
			try {
				await run("first")
				if (replaced) definition.execute = vi.fn(async () => "Replacement implementation")
				else options.catalogCache = new TaskToolCatalogCache()
				await run("second")
				expect(requestToolApproval).toHaveBeenCalledTimes(replaced ? 2 : 1)
			} finally {
				clearTaskSessionApprovalGrants(taskId)
			}
		},
	)

	it.each([
		"unchanged",
		"disconnect",
		"reconnect",
		"schema",
		"prompt-disabled",
		"removed",
		"cancel",
		"status-reconnect",
	])("enforces the captured %s contract at the real MCP dispatch after post-approval UI waits", async (change) => {
		const { options, server, connection, hub } = fixture(2)
		const surface = await capture(options)
		const entered = deferred()
		const release = deferred()
		const effect = vi.fn(async () => ({ content: [{ type: "text", text: "Calendar record found." }] }))
		Object.assign(hub, { getAllServers: () => [server], callTool: effect })
		Object.assign(options.provider, {
			postMessageToWebview: vi.fn(() => {
				if (change === "status-reconnect") connection.client = {}
			}),
		})
		const executionHost = host()
		executionHost.taskFacade = {
			providerRef: new WeakRef(options.provider),
			consecutiveMistakeCount: 0,
			say: async (type: string) => {
				if (type === "mcp_server_request_started") {
					entered.resolve()
					await release.promise
				}
			},
		} as unknown as Task
		const controller = new AbortController()
		const running = execute(surface, [call(target, { query: "today" })], {
			executionHost,
			signal: controller.signal,
		})
		await entered.promise
		expect(executionHost.ask).toHaveBeenCalledOnce()
		if (change === "disconnect") server.status = "disconnected"
		if (change === "reconnect") connection.client = {}
		if (change === "schema") server.tools![0].inputSchema = { type: "object", required: ["replacement"] }
		if (change === "prompt-disabled") server.tools![0].enabledForPrompt = false
		if (change === "removed") server.tools!.shift()
		if (change === "cancel") controller.abort()
		release.resolve()
		const result = await running
		expect(result.outcome.results[0].status).toBe(
			change === "unchanged" ? "success" : change === "cancel" ? "cancelled" : "error",
		)
		expect(result.executionHost.userMessageContent[0]).toMatchObject({ is_error: change !== "unchanged" })
		expect(effect).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0)
	})

	it.each(["resolve", "reject"])(
		"cancels a custom load wait and observes its late %s without publishing",
		async (settle) => {
			const { options } = fixture()
			const entered = deferred()
			const load = deferred<Awaited<ReturnType<typeof customToolRegistry.loadFromDirectoriesIfStale>>>()
			vi.spyOn(customToolRegistry, "loadFromDirectoriesIfStale").mockImplementation(() => {
				entered.resolve()
				return load.promise
			})
			const captureSpy = vi.spyOn(options.catalogCache!, "capture")
			const controller = new AbortController()
			const addListener = vi.spyOn(controller.signal, "addEventListener")
			const removeListener = vi.spyOn(controller.signal, "removeEventListener")
			const running = capture({ ...options, experiments: { customTools: true }, signal: controller.signal })
			const cancelled = expect(running).rejects.toMatchObject({ name: "AbortError" })
			await entered.promise
			controller.abort()
			await cancelled
			expect(captureSpy).not.toHaveBeenCalled()
			expect(removeListener.mock.calls.map((args) => args[1])).toEqual(
				addListener.mock.calls.map((args) => args[1]),
			)
			if (settle === "resolve") load.resolve({ loaded: [], failed: [], catalog: [] })
			else load.reject(new Error("Late shared load failure"))
			await new Promise((resolve) => setImmediate(resolve))
			expect(captureSpy).not.toHaveBeenCalled()
		},
	)

	it("dispatches the exact captured MCP name when another tool is a fuzzy match", async () => {
		const { options, server, hub } = fixture(2)
		server.tools![0].name = "lookup-one"
		server.tools![1].name = "lookup_one"
		options.disabledTools = ["mcp--calendar--lookup-one"]
		const surface = await capture(options)
		const effect = vi.fn(async () => ({ content: [{ type: "text", text: "Calendar record found." }] }))
		Object.assign(hub, { getAllServers: () => [server], callTool: effect })
		Object.assign(options.provider, { postMessageToWebview: vi.fn() })
		const executionHost = host()
		executionHost.taskFacade = {
			providerRef: new WeakRef(options.provider),
			consecutiveMistakeCount: 0,
			say: vi.fn(async () => {}),
		} as unknown as Task
		const result = await execute(surface, [call("mcp--calendar--lookup_one", { query: "today" })], {
			executionHost,
		})
		expect(result.outcome.results[0].status).toBe("success")
		expect(effect).toHaveBeenCalledExactlyOnceWith(
			"calendar",
			"lookup_one",
			{ query: "today" },
			"project",
			expect.any(AbortSignal),
		)
	})

	it.each([false, true])(
		"uses the captured server source when the project override is disabled=%s",
		async (disabled) => {
			const { options, server } = fixture(2)
			const global = structuredClone(server)
			global.source = "global"
			global.tools![0].description = "Global definition"
			server.disabled = disabled
			if (!disabled) global.tools![0].enabledForPrompt = false
			const { executionHost, requests } = realMcpHost(options, [global, server])
			const surface = await capture(options)
			expect(surface.isCallable(target)).toBe(true)
			const result = await execute(surface, [call(target, { query: "today" })], { executionHost })
			expect(result.outcome.results[0].status).toBe("success")
			expect(requests[disabled ? 0 : 1]).toHaveBeenCalledOnce()
			expect(requests[disabled ? 1 : 0]).not.toHaveBeenCalled()
		},
	)

	it("keeps the first captured tool target when sanitized names collide", async () => {
		const { options, server } = fixture(2)
		server.tools![0].name = "lookup--one"
		server.tools![1].name = "lookup-one"
		const { executionHost, requests } = realMcpHost(options, [server])
		const surface = await capture(options)
		const result = await execute(surface, [call("mcp--calendar--lookup-one", { query: "today" })], {
			executionHost,
		})
		expect(result.outcome.results[0].status).toBe("success")
		expect(requests[0]).toHaveBeenCalledExactlyOnceWith(
			{ method: "tools/call", params: { name: "lookup--one", arguments: { query: "today" } } },
			expect.anything(),
			{ timeout: 60_000, signal: expect.any(AbortSignal) },
		)
	})

	it("keeps the captured original server when sanitized server names collide", async () => {
		const { options, server } = fixture(2)
		server.name = "calendar place"
		const second = structuredClone(server)
		second.name = "calendar_place"
		const { executionHost, requests } = realMcpHost(options, [second, server])
		const surface = await capture(options)
		const result = await execute(surface, [call("mcp--calendar_place--lookup_00", { query: "today" })], {
			executionHost,
		})
		expect(result.outcome.results[0].status).toBe("success")
		expect(requests[1]).toHaveBeenCalledOnce()
		expect(requests[0]).not.toHaveBeenCalled()
	})

	it("keeps a disconnected historical collision from shadowing the callable provider schema", async () => {
		const { options, server } = fixture(2)
		server.name = "calendar_place"
		const offline = structuredClone(server)
		offline.name = "calendar place"
		offline.status = "disconnected"
		offline.tools![0].inputSchema = { type: "object", required: ["offline_contract"] }
		const { executionHost, requests } = realMcpHost(options, [offline, server])
		const surface = await capture({
			...options,
			apiConfiguration: { apiProvider: "vertex" },
			includeAllToolsWithRestrictions: true,
		})
		const name = "mcp--calendar_place--lookup_00"
		expect(surface.resolve(name)?.schema).toMatchObject({ function: { parameters: { required: ["query"] } } })
		const result = await execute(surface, [call(name, { query: "today" })], { executionHost })
		expect(result.outcome.results[0].status).toBe("success")
		expect(requests[1]).toHaveBeenCalledOnce()
		expect(requests[0]).not.toHaveBeenCalled()
	})

	it("captures reconnect identity and retains disconnected historical schemas only in the restricted provider superset", async () => {
		const { options, server, connection } = fixture()
		const initial = await capture(options)
		connection.client = {}
		expect((await capture(options)).registry).not.toBe(initial.registry)
		server.status = "disconnected"
		const offline = await capture(options)
		expect(offline.registry.has(target)).toBe(false)
		const gemini = await capture({
			...options,
			includeAllToolsWithRestrictions: true,
			apiConfiguration: { apiProvider: "vertex" },
		})
		expect(gemini.registry.has(target)).toBe(true)
		expect(gemini.schemas.some((schema) => schema.type === "function" && schema.function.name === target)).toBe(
			true,
		)
		expect(gemini.isCallable(target)).toBe(false)
		expect(gemini.allowedFunctionNames).not.toContain(target)
	})

	it.each(["vertex", "vscode-lm"] as const)(
		"keeps ordinary eager schemas for the %s fallback",
		async (apiProvider) => {
			const { options } = fixture()
			const fallback = await capture({
				...options,
				apiConfiguration: { apiProvider },
				includeAllToolsWithRestrictions: apiProvider !== "vscode-lm",
			})
			expect(fallback.isCallable(target)).toBe(true)
			expect(fallback.isCallable("tool_search")).toBe(false)
			expect(fallback.schemas.every((schema) => schema.type === "function")).toBe(true)
		},
	)

	it.each(["vertex"] as const)(
		"retains discovery history declarations after switching to %s without enabling discovery",
		async (apiProvider) => {
			const { options } = fixture()
			const ordinary = await capture(options)
			const history = await discover(ordinary)
			const fallback = await capture({
				...options,
				discoveryHistory: history,
				apiConfiguration: { apiProvider },
				includeAllToolsWithRestrictions: true,
			})
			expect(
				fallback.schemas.some((schema) => schema.type === "function" && schema.function.name === "tool_search"),
			).toBe(true)
			expect(fallback.allowedFunctionNames).not.toContain("tool_search")
			expect(fallback.isCallable(target)).toBe(true)
			const rejected = await execute(fallback, [call("tool_search", { query: "calendar" })])
			expect(rejected.outcome.results[0].status).toBe("denied")
			expect(rejected.executionHost.userMessageContent[0]).toMatchObject({ is_error: true })
			const pushToolResult = vi.fn()
			await expect(
				fallback.registry.resolve("discover_tools")!.execute({
					task: {} as Task,
					call: {
						type: "tool_use",
						id: "historical-only",
						name: "discover_tools",
						params: {},
						partial: false,
						nativeArgs: { query: "calendar" },
					},
					callbacks: { askApproval: vi.fn(), handleError: vi.fn(), pushToolResult },
				}),
			).rejects.toThrow("Tool discovery is unavailable for this catalog.")
			expect(pushToolResult).not.toHaveBeenCalled()
			expect(ordinary.isCallable("discover_tools")).toBe(true)
		},
	)

	it("keeps small catalogs and catalogs without discovery authority eager", async () => {
		const small = fixture(2)
		const surface = await capture(small.options)
		expect(surface.isCallable(target)).toBe(true)
		expect(surface.isCallable("tool_search")).toBe(false)
		const large = fixture()
		const disabled = await capture({ ...large.options, disabledTools: ["discover_tools"] })
		expect(disabled.isCallable(target)).toBe(true)
		expect(disabled.isCallable("tool_search")).toBe(false)
		const noMcp = await capture({ ...large.options, disabledTools: ["use_mcp_tool"] })
		expect(noMcp.isCallable(target)).toBe(false)
		expect(noMcp.isCallable("tool_search")).toBe(false)
	})

	it("restores paired discovery after reload, retains it across context reset, and isolates other tasks", async () => {
		const { options } = fixture()
		const initial = await capture(options)
		const history = await discover(initial)
		const restored = await capture({
			...options,
			catalogCache: new TaskToolCatalogCache(),
			discoveryHistory: history,
		})
		expect(restored.isCallable(target)).toBe(true)
		const loaded = await capture({ ...options, discoveryHistory: history })
		expect(await capture({ ...options, discoveryHistory: [] })).toBe(loaded)
		const independent = await capture({
			...options,
			catalogCache: new TaskToolCatalogCache(),
			discoveryHistory: [],
		})
		expect(independent.isCallable(target)).toBe(false)
	})

	it.each(["success", "error", "cancelled"] as const)(
		"restores only successful %s discovery from a compacted prefix after restart",
		async (status) => {
			const { options } = fixture()
			const initial = await capture(options)
			const history = await discover(initial)
			const content = history[1].content
			if (!Array.isArray(content) || content[0].type !== "tool_result") {
				throw new Error("Discovery fixture must contain a structured result")
			}
			if (status === "error") content[0].is_error = true
			if (status === "cancelled") content[0].content = JSON.stringify({ status: "cancelled" })
			const storedHistory: ApiMessage[] = [
				...history.map((message) => ({ ...message, condenseParent: "archived-discovery" })),
				{
					role: "user",
					content: "Older work was summarized; continue with the recent evidence.",
					isSummary: true,
					condenseId: "archived-discovery",
				},
				{ role: "assistant", content: "Recent investigation" },
				{ role: "user", content: "Continue without redoing discovery" },
			]
			expect(getEffectiveApiHistory(storedHistory)).toEqual(storedHistory.slice(2))

			const reloaded = await capture({
				...options,
				catalogCache: new TaskToolCatalogCache(),
				discoveryHistory: structuredClone(storedHistory),
			})

			expect(reloaded.isCallable(target)).toBe(status === "success")
			// Selection restores visibility only; the MCP effect still requires approval.
			expect(reloaded.registry.resolve(target)?.capabilities.requiresApproval).toBe(true)
		},
	)

	it.each([
		"unpaired",
		"text",
		"error",
		"cancelled",
		"malformed",
		"wrong-digest",
		"wrong-schema",
		"wrong-call",
		"duplicate",
		"version",
		"oversize",
	])("does not restore %s discovery data", async (kind) => {
		const { options } = fixture()
		const initial = await capture(options)
		const history = structuredClone(await discover(initial))
		const results = history[1].content as Anthropic.ToolResultBlockParam[]
		const result = results[0]
		const data = JSON.parse(result.content as string)
		if (kind === "unpaired") history.shift()
		if (kind === "text") history[1].content = [{ type: "text", text: result.content as string }]
		if (kind === "error") result.is_error = true
		if (kind === "cancelled") data.status = "cancelled"
		if (kind === "wrong-digest") data.tools[0].schemaDigest = "0".repeat(64)
		if (kind === "wrong-schema") data.tools[0].schema.function.parameters = { type: "object" }
		if (kind === "wrong-call") (history[0].content as Anthropic.ToolUseBlockParam[])[0].name = "read_file"
		if (kind === "duplicate") results.push(structuredClone(result))
		if (kind === "version") data.version = 2
		result.content =
			kind === "malformed"
				? "{"
				: kind === "oversize"
					? " ".repeat(DISCOVERY_OUTPUT_LIMIT + 1)
					: JSON.stringify(data)
		const restored = await capture({
			...options,
			catalogCache: new TaskToolCatalogCache(),
			discoveryHistory: history,
		})
		expect(restored.isCallable(target)).toBe(false)
	})

	it("closes failed, empty and cancelled discovery calls without promoting tools", async () => {
		const { options } = fixture()
		const initial = await capture(options)
		for (const args of [{ query: "" }, { query: "qzxvnoresults" }, { query: "calendar", limit: 99 }]) {
			const calls = [call("tool_search", args)]
			const result = await execute(initial, calls)
			const emptySuccess = args.query === "qzxvnoresults"
			expect(result.outcome.results[0].status).toBe(emptySuccess ? "success" : "error")
			expect(result.executionHost.userMessageContent[0]).toMatchObject({ is_error: !emptySuccess })
			expect(
				(await capture({ ...options, discoveryHistory: receipt(calls, result.executionHost) })).isCallable(
					target,
				),
			).toBe(false)
		}
		const controller = new AbortController()
		controller.abort()
		const cancelled = await execute(initial, [call("tool_search", { query: "calendar" })], {
			signal: controller.signal,
		})
		expect(cancelled.outcome.results[0].status).toBe("cancelled")
		expect(cancelled.executionHost.userMessageContent[0]).toMatchObject({ is_error: true })
		const failed = await execute(initial, [call("tool_search", { query: "calendar" })], { failFence: true })
		expect(failed.outcome.status).toBe("failed")
		expect((await capture(options)).isCallable(target)).toBe(false)
	})

	it("bounds selected tools and discovery output while keeping oversized single schemas reachable", async () => {
		const { options, server } = fixture(40)
		server.tools!.push({
			name: "oversized",
			description: "Large contract. ".repeat(3_000),
			inputSchema: { type: "object" },
		})
		const initial = await capture(options)
		expect(initial.isCallable("mcp--calendar--oversized")).toBe(true)
		const calls = Array.from({ length: 40 }, (_, i) =>
			call("tool_search", { query: `lookup_${String(i).padStart(2, "0")}`, limit: 1 }, `discover-${i}`),
		)
		const result = await execute(initial, calls)
		for (const item of result.outcome.results) {
			expect(item.status).toBe("success")
			expect((item.content as string).length).toBeLessThanOrEqual(DISCOVERY_OUTPUT_LIMIT)
		}
		const overflowResult = await execute(initial, [call("tool_search", { query: "39", limit: 1 }, "overflow")])
		const overflow = JSON.parse(String(overflowResult.outcome.results[0].content))
		expect(overflow).toMatchObject({ status: "success", tools: [], message: expect.stringContaining("next step") })
		const next = await capture({ ...options, discoveryHistory: receipt(calls, result.executionHost) })
		expect(next.allowedFunctionNames.filter((name) => name.startsWith("mcp--calendar--lookup_"))).toHaveLength(32)
		const promisedNames = result.outcome.results.flatMap((item) => {
			const content = JSON.parse(String(item.content)) as { tools: Array<{ name: string }> }
			return content.tools.map((tool) => tool.name)
		})
		expect(new Set(promisedNames).size).toBe(32)
		for (const name of promisedNames) expect(next.isCallable(name)).toBe(true)
	})

	it("advertises only searchable permitted sources from the captured catalog", async () => {
		const { options, server, hub, connection } = fixture()
		const hidden = { ...server, name: "hidden-source" }
		const disconnected = { ...server, name: "disconnected-source", status: "disconnected" as const }
		const disabled = { ...server, name: "disabled-source", disabled: true }
		hub.connections.push({ ...connection, server: hidden })
		hub.getServers = () => [server, hidden, disconnected, disabled]
		options.disabledTools = hidden.tools!.map((tool) => `mcp--hidden-source--${tool.name}`)
		const surface = await capture(options)
		const schema = surface.schemas.find((tool) => tool.type === "function" && tool.function.name === "tool_search")
		expect(schema?.type).toBe("function")
		if (schema?.type !== "function") throw new Error("Expected discovery schema")
		expect(schema.function.description).toContain("- calendar")
		expect(schema.function.description).not.toContain("hidden-source")
		expect(schema.function.description).not.toContain("disconnected-source")
		expect(schema.function.description).not.toContain("disabled-source")
	})

	it("starts a new discovery capacity window only at the next captured history boundary", async () => {
		const { options } = fixture(40)
		const initial = await capture(options)
		const calls = Array.from({ length: 32 }, (_, index) =>
			call("tool_search", { query: `lookup_${String(index).padStart(2, "0")}`, limit: 1 }, `search-${index}`),
		)
		const result = await execute(initial, calls)
		expect(await capture(options)).toBe(initial)
		expect(await discoverNames(initial, "39", 1)).toEqual([])
		const firstHistory = receipt(calls, result.executionHost)
		const next = await capture({ ...options, discoveryHistory: firstHistory })
		const nextCalls = [call("tool_search", { query: "lookup_39", limit: 1 }, "next-search")]
		const nextResult = await execute(next, nextCalls)
		expect(next.isCallable("mcp--calendar--lookup_39")).toBe(false)
		const promoted = await capture({
			...options,
			discoveryHistory: [...firstHistory, ...receipt(nextCalls, nextResult.executionHost)],
		})
		expect(promoted.isCallable("mcp--calendar--lookup_39")).toBe(true)
		expect(promoted.allowedFunctionNames.filter((name) => name.startsWith("mcp--calendar--lookup_"))).toHaveLength(
			32,
		)
	})

	it.each(["policy", "task allow-list"] as const)(
		"omits sources unavailable under the captured %s",
		async (authority) => {
			const { options, server, hub, connection } = fixture()
			const initial = await capture(options)
			const permittedNames = initial.registry.list().map((tool) => tool.name)
			const hidden = { ...server, name: "unauthorized-source" }
			hub.connections.push({ ...connection, server: hidden })
			hub.getServers = () => [server, hidden]
			if (authority === "policy") {
				options.policy = createToolPolicySnapshot({
					visibleTools: [
						...permittedNames,
						...hidden.tools!.map((tool) => `mcp--unauthorized-source--${tool.name}`),
					],
					allowedTools: permittedNames,
				})
			} else options.allowedToolNames = permittedNames
			const surface = await capture(options)
			const schema = surface.registry.resolve("tool_search")!.schema
			if (schema.type !== "function") throw new Error("Expected discovery schema")
			expect(schema.function.description).toContain("- calendar")
			expect(schema.function.description).not.toContain("unauthorized-source")
		},
	)

	it("bounds, deduplicates, and orders the available-source inventory", () => {
		const sources = Array.from(
			{ length: 1_000 },
			(_, index) => `source-${String(index).padStart(4, "0")}-${"é".repeat(40)}`,
		)
		const schema = createToolSearchTool([...sources.reverse(), sources[0]])
		const inventory = schema.function.description.split("sources:\n")[1]
		expect(Buffer.byteLength(inventory, "utf8")).toBeLessThanOrEqual(TOOL_SEARCH_SOURCE_INVENTORY_MAX_BYTES)
		const lines = inventory.trim().split("\n")
		expect(lines).toEqual([...new Set(lines)].sort())
		expect(lines[0]).toContain("source-0000")
	})
})
