import type Anthropic from "@anthropic-ai/sdk"
import type { McpServer } from "@alpha-code/types"
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
import type { ApiMessage } from "../../task-persistence/apiMessages"
import type { TaskToolSurface } from "../../tools/TaskToolSurface"
import { getEffectiveApiHistory } from "../../condense"
import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import { McpHub } from "../../../services/mcp/McpHub"
import type { Task } from "../Task"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../build-tools"
import { TaskToolCatalogCache, DISCOVERY_OUTPUT_LIMIT } from "../TaskToolCatalogCache"

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
		apiConfiguration: { apiProvider: "anthropic" },
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
	input: { signal?: AbortSignal; mode?: string; executionHost?: ToolExecutionHost; failFence?: boolean } = {},
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
	const calls = [call("discover_tools", { query: "lookup_00", limit: 1 }, "discovery-1")]
	const result = await execute(surface, calls)
	expect(result.outcome.results[0].status).toBe("success")
	return receipt(calls, result.executionHost)
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
	return { executionHost, requests }
}

afterEach(() => vi.restoreAllMocks())

describe("TaskToolCatalogCache", () => {
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
			first.schemas.some((schema) => schema.type === "function" && schema.function.name === "discover_tools"),
		).toBe(true)
		expect(first.isCallable(target)).toBe(false)
		expect(first.isCallable("read_file")).toBe(true)
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
			call("discover_tools", { query: "lookup_00", limit: 1 }),
			call(target),
			call(targetAlias),
			call("use_mcp_tool", { server_name: "calendar", tool_name: "lookup_00" }),
		])
		expect(result.outcome.results.map((item) => item.status)).toEqual(["success", "error", "error", "error"])
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
			if (settle === "resolve") load.resolve({ loaded: [], failed: [] })
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
			apiConfiguration: { apiProvider: "gemini" },
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
			apiConfiguration: { apiProvider: "gemini" },
		})
		expect(gemini.registry.has(target)).toBe(true)
		expect(gemini.schemas.some((schema) => schema.type === "function" && schema.function.name === target)).toBe(
			true,
		)
		expect(gemini.isCallable(target)).toBe(false)
		expect(gemini.allowedFunctionNames).not.toContain(target)
	})

	it.each(["gemini", "vertex", "vscode-lm"] as const)(
		"keeps ordinary eager schemas for the %s fallback",
		async (apiProvider) => {
			const { options } = fixture()
			const fallback = await capture({
				...options,
				apiConfiguration: { apiProvider },
				includeAllToolsWithRestrictions: apiProvider !== "vscode-lm",
			})
			expect(fallback.isCallable(target)).toBe(true)
			expect(fallback.isCallable("discover_tools")).toBe(false)
			expect(fallback.schemas.every((schema) => schema.type === "function")).toBe(true)
		},
	)

	it.each(["gemini", "vertex"] as const)(
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
				fallback.schemas.some(
					(schema) => schema.type === "function" && schema.function.name === "discover_tools",
				),
			).toBe(true)
			expect(fallback.allowedFunctionNames).not.toContain("discover_tools")
			expect(fallback.isCallable(target)).toBe(true)
			const rejected = await execute(fallback, [call("discover_tools", { query: "calendar" })])
			expect(rejected.outcome.results[0].status).toBe("error")
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
		expect(surface.isCallable("discover_tools")).toBe(false)
		const large = fixture()
		const disabled = await capture({ ...large.options, disabledTools: ["discover_tools"] })
		expect(disabled.isCallable(target)).toBe(true)
		expect(disabled.isCallable("discover_tools")).toBe(false)
		const noMcp = await capture({ ...large.options, disabledTools: ["use_mcp_tool"] })
		expect(noMcp.isCallable(target)).toBe(false)
		expect(noMcp.isCallable("discover_tools")).toBe(false)
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
			const calls = [call("discover_tools", args)]
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
		const cancelled = await execute(initial, [call("discover_tools", { query: "calendar" })], {
			signal: controller.signal,
		})
		expect(cancelled.outcome.results[0].status).toBe("cancelled")
		expect(cancelled.executionHost.userMessageContent[0]).toMatchObject({ is_error: true })
		const failed = await execute(initial, [call("discover_tools", { query: "calendar" })], { failFence: true })
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
			call("discover_tools", { query: `lookup_${String(i).padStart(2, "0")}`, limit: 1 }, `discover-${i}`),
		)
		const result = await execute(initial, calls)
		for (const item of result.outcome.results) {
			expect(item.status).toBe("success")
			expect((item.content as string).length).toBeLessThanOrEqual(DISCOVERY_OUTPUT_LIMIT)
		}
		const next = await capture({ ...options, discoveryHistory: receipt(calls, result.executionHost) })
		expect(next.allowedFunctionNames.filter((name) => name.startsWith("mcp--calendar--lookup_"))).toHaveLength(32)
	})
})
