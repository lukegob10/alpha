import { createHash } from "crypto"
import type { AlphaAskUseMcpServer, McpServer } from "@alpha-code/types"

import type { Task } from "../task/Task"
import type { McpHub } from "../../services/mcp/McpHub"
import {
	collectPaginatedCatalog,
	DEFAULT_MCP_PAGINATION_TIMEOUT_MS,
	MAX_MCP_CATALOG_ITEMS,
	validateMcpPaginationCursor,
} from "../../services/mcp/pagination"
import { formatResponse } from "../prompts/responses"
import { BaseTool, type ToolCallbacks } from "./BaseTool"

type ListParams = { server?: string; cursor?: string }
type ResourcePage<T extends object> = { items: T[]; nextCursor?: string }

const MAX_LISTED_RESOURCES = 10_000

function mcpHub(task: Task): McpHub {
	const hub = task.providerRef.deref()?.getMcpHub()
	if (!hub) throw new Error("No MCP hub is available")
	return hub
}

function connectedServers(hub: McpHub): McpServer[] {
	return hub.getServers().filter((server) => !server.disabled && server.status === "connected")
}

async function approveResourceRequest(callbacks: ToolCallbacks, server: McpServer, uri: string): Promise<boolean> {
	const request = {
		type: "access_mcp_resource",
		serverName: server.name,
		uri,
	} satisfies AlphaAskUseMcpServer
	const approved = await callbacks.askApproval("use_mcp_server", JSON.stringify(request))
	callbacks.signal?.throwIfAborted()
	if (!approved) {
		callbacks.setResultMetadata?.({ status: "denied" })
		callbacks.pushToolResult(formatResponse.toolDenied())
	}
	return approved
}

async function listResources<T extends object>(
	params: ListParams,
	task: Task,
	callbacks: ToolCallbacks,
	field: "resources" | "resourceTemplates",
	fetchPage: (hub: McpHub, server: McpServer, cursor?: string, signal?: AbortSignal) => Promise<ResourcePage<T>>,
): Promise<void> {
	const { signal } = callbacks
	try {
		signal?.throwIfAborted()
		if (params.cursor !== undefined && !params.server) throw new Error("cursor requires a server")
		const method = field === "resources" ? "resources/list" : "resources/templates/list"
		validateMcpPaginationCursor(method, params.cursor)
		const hub = mcpHub(task)
		const available = connectedServers(hub)
		const targets = params.server
			? available.filter((candidate) => candidate.name === params.server)
			: available.sort((left, right) => left.name.localeCompare(right.name))
		if (params.server && targets.length === 0)
			throw new Error(`MCP server "${params.server}" is not connected or enabled`)
		const assertCurrentServer = (server: McpServer) => {
			signal?.throwIfAborted()
			if (!connectedServers(hub).includes(server)) {
				throw new Error(`MCP server "${server.name}" changed during resource listing`)
			}
		}
		for (const server of targets) {
			if (
				!(await approveResourceRequest(
					callbacks,
					server,
					field === "resources" ? "resources/list" : "resources/templates/list",
				))
			)
				return
		}
		if (params.server) {
			const server = targets[0]
			assertCurrentServer(server)
			await task.markMemoryExternalContext?.()
			assertCurrentServer(server)
			const page = await fetchPage(hub, server, params.cursor, signal)
			assertCurrentServer(server)
			if (page.items.length > MAX_MCP_CATALOG_ITEMS)
				throw new Error("MCP resource listing exceeded the item limit")
			validateMcpPaginationCursor(method, page.nextCursor)
			callbacks.pushToolResult(
				JSON.stringify({
					server: server.name,
					[field]: page.items.map((item) => ({ ...item, server: server.name })),
					...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
				}),
			)
			return
		}

		const items: Array<T & { server: string }> = []
		const deadline = performance.now() + DEFAULT_MCP_PAGINATION_TIMEOUT_MS
		for (const server of targets) {
			const serverItems = await collectPaginatedCatalog(
				method,
				async (params, pageSignal) => {
					assertCurrentServer(server)
					await task.markMemoryExternalContext?.()
					assertCurrentServer(server)
					const page = await fetchPage(hub, server, params?.cursor, pageSignal)
					assertCurrentServer(server)
					return page
				},
				{ signal, timeoutMs: Math.max(0, deadline - performance.now()) },
			)
			if (items.length + serverItems.length > MAX_LISTED_RESOURCES) {
				throw new Error("MCP resource listing exceeded the item limit")
			}
			items.push(...serverItems.map((item) => ({ ...item, server: server.name })))
		}
		for (const server of targets) assertCurrentServer(server)
		signal?.throwIfAborted()
		callbacks.pushToolResult(JSON.stringify({ [field]: items }))
	} catch (error) {
		if (signal?.aborted) throw error
		callbacks.setResultMetadata?.({ status: "error" })
		await callbacks.handleError("listing MCP resources", error instanceof Error ? error : new Error(String(error)))
	}
}

export class ListMcpResourcesTool extends BaseTool<"list_mcp_resources"> {
	readonly name = "list_mcp_resources" as const

	async execute(params: ListParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		await listResources(params, task, callbacks, "resources", async (hub, server, cursor, signal) => {
			const response = await hub.listResources(server.name, cursor, server.source, signal)
			return { items: response.resources, nextCursor: response.nextCursor }
		})
	}
}

export class ListMcpResourceTemplatesTool extends BaseTool<"list_mcp_resource_templates"> {
	readonly name = "list_mcp_resource_templates" as const

	async execute(params: ListParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		await listResources(params, task, callbacks, "resourceTemplates", async (hub, server, cursor, signal) => {
			const response = await hub.listResourceTemplates(server.name, cursor, server.source, signal)
			return { items: response.resourceTemplates, nextCursor: response.nextCursor }
		})
	}
}

export class ReadMcpResourceTool extends BaseTool<"read_mcp_resource"> {
	readonly name = "read_mcp_resource" as const

	async execute(params: { server: string; uri: string }, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { signal } = callbacks
		try {
			if (!params.server?.trim() || !params.uri?.trim()) throw new Error("server and uri are required")
			const hub = mcpHub(task)
			const server = connectedServers(hub).find((candidate) => candidate.name === params.server)
			if (!server) throw new Error(`MCP server "${params.server}" is not connected or enabled`)
			const assertCurrentServer = () => {
				signal?.throwIfAborted()
				if (!connectedServers(hub).includes(server)) {
					throw new Error(`MCP server "${server.name}" changed during resource read`)
				}
			}
			if (!(await approveResourceRequest(callbacks, server, params.uri))) return
			assertCurrentServer()
			await task.markMemoryExternalContext?.()
			assertCurrentServer()
			const result = await hub.readResource(server.name, params.uri, server.source, signal)
			assertCurrentServer()
			const output = JSON.stringify({ ...result, server: server.name, uri: params.uri })
			callbacks.pushToolResult(output)
			callbacks.setResultMetadata?.({
				status: "success",
				trustedProgress: {
					kind: "read",
					scope: `mcp-resource:${JSON.stringify([task.cwd, server.name, params.uri])}`,
					stateFingerprint: createHash("sha256").update(output).digest("hex"),
				},
			})
		} catch (error) {
			if (signal?.aborted) throw error
			callbacks.setResultMetadata?.({ status: "error" })
			await callbacks.handleError(
				"reading MCP resource",
				error instanceof Error ? error : new Error(String(error)),
			)
		}
	}
}

export const listMcpResourcesTool = new ListMcpResourcesTool()
export const listMcpResourceTemplatesTool = new ListMcpResourceTemplatesTool()
export const readMcpResourceTool = new ReadMcpResourceTool()
