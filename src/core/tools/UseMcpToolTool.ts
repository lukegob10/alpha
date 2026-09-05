import type { ClineAskUseMcpServer, McpExecutionStatus } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import type { ToolUse } from "../../shared/tools"
import { toolNamesMatch } from "../../utils/mcp-name"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface UseMcpToolParams {
	server_name: string
	tool_name: string
	arguments?: Record<string, unknown>
}

type ValidationResult =
	| { isValid: false }
	| {
			isValid: true
			serverName: string
			toolName: string
			parsedArguments?: Record<string, unknown>
	  }

export class UseMcpToolTool extends BaseTool<"use_mcp_tool"> {
	readonly name = "use_mcp_tool" as const

	async execute(params: UseMcpToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, signal } = callbacks
		signal?.throwIfAborted()

		try {
			// Validate parameters
			const validation = await this.validateParams(task, params, callbacks)
			if (!validation.isValid) {
				return
			}

			const { serverName, toolName, parsedArguments } = validation

			// Validate that the tool exists on the server
			const toolValidation = await this.validateToolExists(
				task,
				serverName,
				toolName,
				callbacks,
				callbacks.mcpSource,
			)
			if (!toolValidation.isValid) {
				return
			}

			// Use the resolved tool name (original name from the server) for MCP calls
			// This handles cases where models mangle hyphens to underscores
			const resolvedToolName = toolValidation.resolvedToolName ?? toolName

			// Reset mistake count on successful validation
			task.consecutiveMistakeCount = 0

			// Get user approval
			const completeMessage = JSON.stringify({
				type: "use_mcp_tool",
				serverName,
				toolName: resolvedToolName,
				arguments: params.arguments ? JSON.stringify(params.arguments) : undefined,
			} satisfies ClineAskUseMcpServer)

			const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()
			const didApprove = await askApproval("use_mcp_server", completeMessage)

			if (!didApprove) {
				return
			}
			signal?.throwIfAborted()

			// Execute the tool and process results
			await this.executeToolAndProcessResult(
				task,
				serverName,
				resolvedToolName,
				parsedArguments,
				executionId,
				callbacks,
			)
		} catch (error) {
			// Keep cancellation as a rejection so ToolScheduler can emit its one
			// canonical cancelled receipt. Other failures use the legacy adapter
			// error path for direct callers.
			if (signal?.aborted) {
				throw error
			}
			this.markFailure(task, callbacks)
			await handleError("executing MCP tool", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"use_mcp_tool">): Promise<void> {
		const params = block.params
		const partialMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: params.server_name ?? "",
			toolName: params.tool_name ?? "",
			arguments: params.arguments,
		} satisfies ClineAskUseMcpServer)

		await task.ask("use_mcp_server", partialMessage, true).catch(() => {})
	}

	private async validateParams(
		task: Task,
		params: UseMcpToolParams,
		callbacks: ToolCallbacks,
	): Promise<ValidationResult> {
		if (!params.server_name) {
			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			this.markFailure(task, callbacks)
			callbacks.pushToolResult(await task.sayAndCreateMissingParamError("use_mcp_tool", "server_name"))
			return { isValid: false }
		}

		if (!params.tool_name) {
			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			this.markFailure(task, callbacks)
			callbacks.pushToolResult(await task.sayAndCreateMissingParamError("use_mcp_tool", "tool_name"))
			return { isValid: false }
		}

		// Native-only: arguments are already a structured object.
		let parsedArguments: Record<string, unknown> | undefined
		if (params.arguments !== undefined) {
			if (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments)) {
				task.consecutiveMistakeCount++
				task.recordToolError("use_mcp_tool")
				await task.say("error", t("mcp:errors.invalidJsonArgument", { toolName: params.tool_name }))
				this.markFailure(task, callbacks)
				callbacks.pushToolResult(
					formatResponse.toolError(
						formatResponse.invalidMcpToolArgumentError(params.server_name, params.tool_name),
					),
				)
				return { isValid: false }
			}
			parsedArguments = params.arguments
		}

		return {
			isValid: true,
			serverName: params.server_name,
			toolName: params.tool_name,
			parsedArguments,
		}
	}

	private async validateToolExists(
		task: Task,
		serverName: string,
		toolName: string,
		callbacks: ToolCallbacks,
		source?: "global" | "project",
	): Promise<{ isValid: boolean; availableTools?: string[]; resolvedToolName?: string }> {
		// Get the MCP hub to access server information. Validation cannot be
		// authoritative when the hub is absent, so fail before approval/dispatch.
		const provider = task.providerRef.deref()
		const mcpHub = provider?.getMcpHub()

		if (!mcpHub) {
			const message = t("mcp:errors.serverNotFound", {
				serverName,
				availableServers: "No servers available",
			})
			await task.say("error", message)
			this.markFailure(task, callbacks)
			callbacks.pushToolResult(formatResponse.unknownMcpServerError(serverName, []))
			return { isValid: false, availableTools: [] }
		}

		// Get all servers to find the specific one
		const servers = mcpHub.getAllServers()
		const server = servers.find((s) => s.name === serverName && (source === undefined || s.source === source))

		if (!server) {
			// Fail fast when server is unknown
			const availableServersArray = servers.map((s) => s.name)
			const availableServers =
				availableServersArray.length > 0 ? availableServersArray.join(", ") : "No servers available"

			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			await task.say("error", t("mcp:errors.serverNotFound", { serverName, availableServers }))
			this.markFailure(task, callbacks)

			callbacks.pushToolResult(formatResponse.unknownMcpServerError(serverName, availableServersArray))
			return { isValid: false, availableTools: [] }
		}

		// Check if the server has tools defined
		if (!server.tools || server.tools.length === 0) {
			// No tools available on this server
			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			await task.say(
				"error",
				t("mcp:errors.toolNotFound", {
					toolName,
					serverName,
					availableTools: "No tools available",
				}),
			)
			this.markFailure(task, callbacks)

			callbacks.pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, []))
			return { isValid: false, availableTools: [] }
		}

		// Check if the requested tool exists (using fuzzy matching to handle model mangling of hyphens)
		const tool =
			server.tools.find((t) => t.name === toolName) ?? server.tools.find((t) => toolNamesMatch(t.name, toolName))

		if (!tool) {
			// Tool not found - provide list of available tools
			const availableToolNames = server.tools.map((tool) => tool.name)

			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			await task.say(
				"error",
				t("mcp:errors.toolNotFound", {
					toolName,
					serverName,
					availableTools: availableToolNames.join(", "),
				}),
			)
			this.markFailure(task, callbacks)

			callbacks.pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, availableToolNames))
			return { isValid: false, availableTools: availableToolNames }
		}

		// Check if the tool is disabled (enabledForPrompt is false)
		if (tool.enabledForPrompt === false) {
			// Tool is disabled - only show enabled tools
			const enabledTools = server.tools.filter((t) => t.enabledForPrompt !== false)
			const enabledToolNames = enabledTools.map((t) => t.name)

			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			await task.say(
				"error",
				t("mcp:errors.toolDisabled", {
					toolName,
					serverName,
					availableTools:
						enabledToolNames.length > 0 ? enabledToolNames.join(", ") : "No enabled tools available",
				}),
			)
			this.markFailure(task, callbacks)

			callbacks.pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, enabledToolNames))
			return { isValid: false, availableTools: enabledToolNames }
		}

		// Tool exists and is enabled - return the original tool name for use with the server.
		return { isValid: true, availableTools: server.tools.map((t) => t.name), resolvedToolName: tool.name }
	}

	private markFailure(task: Task, callbacks: ToolCallbacks): void {
		task.didToolFailInCurrentTurn = true
		callbacks.setResultMetadata?.({ status: "error" })
	}

	private async sendExecutionStatus(task: Task, status: McpExecutionStatus): Promise<void> {
		try {
			await task.providerRef.deref()?.postMessageToWebview({
				type: "mcpExecutionStatus",
				text: JSON.stringify(status),
			})
		} catch {
			// Presentation delivery is best-effort and must not replace the canonical tool result.
		}
	}

	private processToolContent(toolResult: any): { text: string; images: string[] } {
		if (!toolResult?.content || toolResult.content.length === 0) {
			return { text: "", images: [] }
		}

		const images: string[] = []

		const textContent = toolResult.content
			.map((item: any) => {
				if (item.type === "text") {
					return item.text
				}
				if (item.type === "resource") {
					const resource = item.resource
					if (!resource || typeof resource !== "object") {
						return ""
					}

					const resourceRecord = resource as Record<string, unknown>
					const mimeType = typeof resourceRecord.mimeType === "string" ? resourceRecord.mimeType : undefined
					const blob = resourceRecord.blob
					if (mimeType?.toLowerCase().startsWith("image/") && typeof blob === "string" && blob.length > 0) {
						images.push(blob.startsWith("data:") ? blob : `data:${mimeType};base64,${blob}`)
						return ""
					}

					if (typeof resourceRecord.text === "string") {
						// Text resources remain a structured representation so URI,
						// MIME type, and any server-provided metadata stay visible.
						const metadata = { ...resourceRecord }
						delete metadata.blob
						return JSON.stringify(metadata, null, 2)
					}

					if (blob !== undefined) {
						// Binary payloads other than images are not useful as model text.
						// Report bounded metadata and size without copying the payload.
						return JSON.stringify(
							{
								status: "unsupported_binary_resource",
								uri:
									typeof resourceRecord.uri === "string"
										? resourceRecord.uri.slice(0, 256)
										: undefined,
								mimeType: mimeType?.slice(0, 128) ?? "application/octet-stream",
								base64Characters: typeof blob === "string" ? blob.length : undefined,
								message: "Unsupported binary MCP resource omitted from tool text output.",
							},
							null,
							2,
						)
					}

					return JSON.stringify(resourceRecord, null, 2)
				}
				if (item.type === "image") {
					// Handle image content (MCP image content has mimeType and data properties)
					if (typeof item.mimeType === "string" && typeof item.data === "string" && item.data.length > 0) {
						if (item.data.startsWith("data:")) {
							images.push(item.data)
						} else {
							images.push(`data:${item.mimeType};base64,${item.data}`)
						}
					}
					return ""
				}
				return ""
			})
			.filter(Boolean)
			.join("\n\n")

		return { text: textContent, images }
	}

	private async executeToolAndProcessResult(
		task: Task,
		serverName: string,
		toolName: string,
		parsedArguments: Record<string, unknown> | undefined,
		executionId: string,
		callbacks: ToolCallbacks,
	): Promise<void> {
		const { beforeMcpDispatch, mcpSource: source, pushToolResult, signal } = callbacks
		signal?.throwIfAborted()
		await task.say("mcp_server_request_started")
		signal?.throwIfAborted()

		// Send started status
		await this.sendExecutionStatus(task, {
			executionId,
			status: "started",
			serverName,
			toolName,
		})
		let terminalStatusSent = false
		const finishExecution = async (status: McpExecutionStatus) => {
			if (terminalStatusSent) return
			terminalStatusSent = true
			await this.sendExecutionStatus(
				task,
				signal?.aborted ? { executionId, status: "error", error: "MCP tool execution was cancelled" } : status,
			)
		}

		try {
			// McpHub selects its connection and starts client.request synchronously. Keep this guard
			// immediately before dispatch, with no await between the guard and call.
			signal?.throwIfAborted()
			beforeMcpDispatch?.(serverName, toolName, source)
			signal?.throwIfAborted()
			const mcpHub = task.providerRef.deref()?.getMcpHub()
			if (!mcpHub) {
				throw new Error("No MCP hub is available")
			}
			const toolResult = await (source === undefined
				? signal === undefined
					? mcpHub.callTool(serverName, toolName, parsedArguments)
					: mcpHub.callTool(serverName, toolName, parsedArguments, undefined, signal)
				: signal === undefined
					? mcpHub.callTool(serverName, toolName, parsedArguments, source)
					: mcpHub.callTool(serverName, toolName, parsedArguments, source, signal))
			signal?.throwIfAborted()

			if (!toolResult) {
				throw new Error("No response from MCP server")
			}

			let toolResultPretty = "(No response)"
			let images: string[] = []

			if (toolResult.isError) {
				// MCP reports application-level failures in a successful JSON-RPC
				// response. Preserve that failure in the scheduler receipt and task
				// state instead of relying on the rendered "Error:" prefix.
				this.markFailure(task, callbacks)
			}
			const { text: outputText, images: extractedImages } = this.processToolContent(toolResult)
			images = extractedImages

			if (outputText || images.length > 0) {
				signal?.throwIfAborted()
				await this.sendExecutionStatus(task, {
					executionId,
					status: "output",
					response: outputText || (images.length > 0 ? `[${images.length} image(s)]` : ""),
				})

				toolResultPretty =
					(toolResult.isError ? "Error:\n" : "") +
					(outputText || (images.length > 0 ? `[${images.length} image(s) received]` : ""))
			}

			signal?.throwIfAborted()
			await task.say("mcp_server_response", toolResultPretty, images)
			signal?.throwIfAborted()
			pushToolResult(formatResponse.toolResult(toolResultPretty, images))
			await finishExecution(
				toolResult.isError
					? { executionId, status: "error", error: "Error executing MCP tool" }
					: { executionId, status: "completed", response: toolResultPretty },
			)
		} catch (error) {
			await finishExecution({
				executionId,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			})
			throw error
		}
	}
}

export const useMcpToolTool = new UseMcpToolTool()
