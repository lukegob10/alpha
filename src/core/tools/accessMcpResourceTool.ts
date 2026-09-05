import type { ClineAskUseMcpServer } from "@alpha-code/types"

import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface AccessMcpResourceParams {
	server_name: string
	uri: string
}

export class AccessMcpResourceTool extends BaseTool<"access_mcp_resource"> {
	readonly name = "access_mcp_resource" as const

	async execute(params: AccessMcpResourceParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult, signal } = callbacks
		const { server_name, uri } = params
		signal?.throwIfAborted()

		try {
			if (!server_name) {
				task.consecutiveMistakeCount++
				task.recordToolError("access_mcp_resource")
				this.markFailure(task, callbacks)
				pushToolResult(await task.sayAndCreateMissingParamError("access_mcp_resource", "server_name"))
				return
			}

			if (!uri) {
				task.consecutiveMistakeCount++
				task.recordToolError("access_mcp_resource")
				this.markFailure(task, callbacks)
				pushToolResult(await task.sayAndCreateMissingParamError("access_mcp_resource", "uri"))
				return
			}

			task.consecutiveMistakeCount = 0

			const completeMessage = JSON.stringify({
				type: "access_mcp_resource",
				serverName: server_name,
				uri,
			} satisfies ClineAskUseMcpServer)

			const didApprove = await askApproval("use_mcp_server", completeMessage)

			if (!didApprove) {
				pushToolResult(formatResponse.toolDenied())
				return
			}

			// Now execute the tool
			signal?.throwIfAborted()
			const mcpHub = task.providerRef.deref()?.getMcpHub()
			if (!mcpHub) {
				throw new Error("No MCP hub is available")
			}
			await task.say("mcp_server_request_started")
			signal?.throwIfAborted()
			const resourceResult = await (signal === undefined
				? mcpHub.readResource(server_name, uri)
				: mcpHub.readResource(server_name, uri, undefined, signal))
			signal?.throwIfAborted()
			if (!resourceResult) {
				throw new Error("No response from MCP server")
			}

			const resourceResultPretty =
				resourceResult.contents
					.map((item) => {
						if (item.text) {
							return item.text
						}
						return ""
					})
					.filter(Boolean)
					.join("\n\n") || "(Empty response)"

			// Handle images (image must contain mimetype and blob)
			const images: string[] = []

			resourceResult.contents.forEach((item) => {
				if (item.mimeType?.startsWith("image") && item.blob) {
					if (item.blob.startsWith("data:")) {
						images.push(item.blob)
					} else {
						images.push(`data:${item.mimeType};base64,` + item.blob)
					}
				}
			})

			signal?.throwIfAborted()
			await task.say("mcp_server_response", resourceResultPretty, images)
			signal?.throwIfAborted()
			pushToolResult(formatResponse.toolResult(resourceResultPretty, images))
		} catch (error) {
			// Let ToolScheduler turn an aborted MCP request into its one canonical
			// cancelled receipt. Direct callers still receive ordinary errors.
			if (signal?.aborted) {
				throw error
			}
			this.markFailure(task, callbacks)
			await handleError("accessing MCP resource", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private markFailure(task: Task, callbacks: ToolCallbacks): void {
		task.didToolFailInCurrentTurn = true
		callbacks.setResultMetadata?.({ status: "error" })
	}

	override async handlePartial(task: Task, block: ToolUse<"access_mcp_resource">): Promise<void> {
		const server_name = block.params.server_name ?? ""
		const uri = block.params.uri ?? ""

		const partialMessage = JSON.stringify({
			type: "access_mcp_resource",
			serverName: server_name,
			uri: uri,
		} satisfies ClineAskUseMcpServer)

		await task.ask("use_mcp_server", partialMessage, block.partial).catch(() => {})
	}
}

export const accessMcpResourceTool = new AccessMcpResourceTool()
