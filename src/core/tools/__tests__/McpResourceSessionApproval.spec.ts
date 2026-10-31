import type Anthropic from "@anthropic-ai/sdk"
import type { McpServer } from "@alpha-code/types"
import { describe, expect, it, vi } from "vitest"

import { createAgentResponse } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { clearTaskSessionApprovalGrants } from "../../auto-approval/taskSessionApprovalGrants"
import type { Task } from "../../task/Task"
import { ToolRegistry } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"

const tools = ["access_mcp_resource", "read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates"] as const

function fixture(tool: (typeof tools)[number], taskId: string) {
	const server: McpServer = { name: "docs", source: "project", status: "connected", config: "{}" }
	const connection = { server, client: {} }
	const listResources = vi.fn(async () => ({ resources: [{ uri: "doc://one", name: "One" }] }))
	const listResourceTemplates = vi.fn(async () => ({
		resourceTemplates: [{ uriTemplate: "doc://{id}", name: "One" }],
	}))
	const readResource = vi.fn(async () => ({ contents: [{ uri: "doc://one", text: "content" }] }))
	const initialHub = {
		connections: [connection],
		getServers() {
			return this.connections.map((item) => item.server)
		},
		listResources,
		listResourceTemplates,
		readResource,
	}
	let activeHub = initialHub
	const requestToolApproval = vi.fn(async () => ({ decision: "approve_session" as const }))
	const method =
		tool === "list_mcp_resources"
			? listResources
			: tool === "list_mcp_resource_templates"
				? listResourceTemplates
				: readResource
	const args =
		tool === "access_mcp_resource"
			? { server_name: "docs", uri: "doc://one" }
			: tool === "read_mcp_resource"
				? { server: "docs", uri: "doc://one" }
				: { server: "docs" }
	const run = async (id: string, argumentsValue: Record<string, unknown> = args) => {
		const registry = new ToolRegistry({
			nativeTools: [
				{ type: "function", function: { name: tool, description: tool, parameters: { type: "object" } } },
			],
		})
		const surface = createTaskToolSurface({ registry, mode: "code", cwd: process.cwd(), taskKind: "primary" })
		const results: Anthropic.ToolResultBlockParam[] = []
		const executionHost: ToolExecutionHost = {
			taskId,
			cwd: process.cwd(),
			userMessageContent: results,
			say: vi.fn(async () => undefined),
			recordToolUsage: vi.fn(),
			requestToolApproval,
			taskFacade: {
				cwd: process.cwd(),
				providerRef: { deref: () => ({ getMcpHub: () => activeHub }) },
				say: vi.fn(async () => undefined),
				markMemoryExternalContext: vi.fn(async () => undefined),
			} as unknown as Task,
			pushToolResultToUserContent(result) {
				results.push(result)
				return true
			},
		}
		return new ToolScheduler({ executionHost, registry, policy: surface.policy, mode: "code" }).run(
			createAgentResponse([{ type: "tool_call", id, name: tool, arguments: argumentsValue }]),
		)
	}
	return {
		server,
		connection,
		initialHub,
		requestToolApproval,
		method,
		run,
		replaceHub: () => {
			activeHub = { ...initialHub }
		},
	}
}

describe("MCP resource session authority", () => {
	for (const tool of tools) {
		it.each(["unchanged", "hub", "connection", "client", "source", "server", "unrelated"] as const)(
			`${tool} binds a session grant to its selected resource authority after %s changes`,
			async (change) => {
				const taskId = `resource-session-${tool}-${change}`
				const context = fixture(tool, taskId)
				try {
					expect((await context.run("first")).results[0].status).toBe("success")
					if (change === "hub") context.replaceHub()
					if (change === "connection") context.initialHub.connections = [{ ...context.connection }]
					if (change === "client") context.connection.client = {}
					if (change === "source") context.server.source = "global"
					if (change === "server") context.connection.server = { ...context.server }
					if (change === "unrelated")
						context.initialHub.connections.push({
							server: { ...context.server, name: "other" },
							client: {},
						})
					expect((await context.run("second")).results[0].status).toBe("success")
					expect(context.method).toHaveBeenCalledTimes(2)
					expect(context.requestToolApproval).toHaveBeenCalledTimes(
						change === "unchanged" || change === "unrelated" ? 1 : 2,
					)
				} finally {
					clearTaskSessionApprovalGrants(taskId)
				}
			},
		)

		it(`${tool} rejects a client replacement while its resource approval is pending`, async () => {
			const taskId = `resource-session-pending-${tool}`
			const context = fixture(tool, taskId)
			context.requestToolApproval.mockImplementation(async () => {
				context.connection.client = {}
				return { decision: "approve_session" }
			})
			try {
				expect((await context.run("pending")).results[0].status).toBe("error")
				expect(context.method).not.toHaveBeenCalled()
			} finally {
				clearTaskSessionApprovalGrants(taskId)
			}
		})
	}

	it.each(["list_mcp_resources", "list_mcp_resource_templates"] as const)(
		"%s keeps same-name global and project resource grants distinct",
		async (tool) => {
			const taskId = `resource-session-sources-${tool}`
			const context = fixture(tool, taskId)
			context.initialHub.connections.push({ server: { ...context.server, source: "global" }, client: {} })
			try {
				expect((await context.run("first", {})).results[0].status).toBe("success")
				expect(context.requestToolApproval).toHaveBeenCalledTimes(2)
				expect((await context.run("second", {})).results[0].status).toBe("success")
				expect(context.requestToolApproval).toHaveBeenCalledTimes(2)
				expect(context.method).toHaveBeenCalledTimes(4)
			} finally {
				clearTaskSessionApprovalGrants(taskId)
			}
		},
	)
})
