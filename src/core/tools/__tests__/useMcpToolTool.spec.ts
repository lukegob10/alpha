// npx vitest core/tools/__tests__/useMcpToolTool.spec.ts

import { useMcpToolTool } from "../UseMcpToolTool"
import { Task } from "../../task/Task"
import { ToolUse } from "../../../shared/tools"

// Mock dependencies
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((result: string, images?: string[]) => {
			if (images && images.length > 0) {
				return `Tool result: ${result} [with ${images.length} image(s)]`
			}
			return `Tool result: ${result}`
		}),
		toolError: vi.fn((error: string) => `Tool error: ${error}`),
		invalidMcpToolArgumentError: vi.fn((server: string, tool: string) => `Invalid args for ${server}:${tool}`),
		unknownMcpToolError: vi.fn((server: string, tool: string, availableTools: string[]) => {
			const toolsList = availableTools.length > 0 ? availableTools.join(", ") : "No tools available"
			return `Tool '${tool}' does not exist on server '${server}'. Available tools: ${toolsList}`
		}),
		unknownMcpServerError: vi.fn((server: string, availableServers: string[]) => {
			const list = availableServers.length > 0 ? availableServers.join(", ") : "No servers available"
			return `Server '${server}' is not configured. Available servers: ${list}`
		}),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, params?: any) => {
		if (key === "mcp:errors.invalidJsonArgument" && params?.toolName) {
			return `Alpha tried to use ${params.toolName} with an invalid JSON argument. Retrying...`
		}
		if (key === "mcp:errors.toolNotFound" && params) {
			return `Tool '${params.toolName}' does not exist on server '${params.serverName}'. Available tools: ${params.availableTools}`
		}
		if (key === "mcp:errors.serverNotFound" && params) {
			return `MCP server '${params.serverName}' is not configured. Available servers: ${params.availableServers}`
		}
		return key
	}),
}))

describe("useMcpToolTool", () => {
	let mockTask: Partial<Task>
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let mockRemoveClosingTag: ReturnType<typeof vi.fn>
	let mockProviderRef: any

	function executionStatuses(postMessageToWebview: ReturnType<typeof vi.fn>) {
		return postMessageToWebview.mock.calls
			.map(([message]) => message)
			.filter((message) => message.type === "mcpExecutionStatus")
			.map((message) => JSON.parse(message.text))
	}

	beforeEach(() => {
		mockAskApproval = vi.fn()
		mockHandleError = vi.fn()
		mockPushToolResult = vi.fn()
		mockRemoveClosingTag = vi.fn((tag: string, value?: string) => value || "")

		mockProviderRef = {
			deref: vi.fn().mockReturnValue({
				getMcpHub: vi.fn().mockReturnValue({
					callTool: vi.fn(),
					getAllServers: vi.fn().mockReturnValue([]),
				}),
				postMessageToWebview: vi.fn(),
			}),
		}

		mockTask = {
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn(),
			say: vi.fn(),
			ask: vi.fn(),
			lastMessageTs: 123456789,
			providerRef: mockProviderRef,
		}
	})

	describe("parameter validation", () => {
		it("should handle missing server_name", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					tool_name: "test_tool",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "",
					tool_name: "test_tool",
					arguments: {},
				},
				partial: false,
			}

			mockTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing server_name error")

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("use_mcp_tool", "server_name")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing server_name error")
		})

		it("should handle missing tool_name", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "",
					arguments: {},
				},
				partial: false,
			}

			mockTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing tool_name error")

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("use_mcp_tool", "tool_name")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing tool_name error")
		})

		it("should handle invalid arguments type", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "invalid json",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
					// Native-only: invalid arguments are rejected unless they are an object.
					arguments: [] as unknown as any,
				},
				partial: false,
			}

			// Mock server exists so we get to the JSON validation step
			const mockServers = [
				{
					name: "test_server",
					tools: [{ name: "test_tool", description: "Test Tool" }],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("invalid JSON argument"))
			expect(mockPushToolResult).toHaveBeenCalledWith("Tool error: Invalid args for test_server:test_tool")
		})
	})

	describe("partial requests", () => {
		it("should handle partial requests", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "{}",
				},
				partial: true,
			}

			mockTask.ask = vi.fn().mockResolvedValue(true)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.ask).toHaveBeenCalledWith("use_mcp_server", expect.stringContaining("use_mcp_tool"), true)
		})
	})

	describe("successful execution", () => {
		it("should execute tool successfully with valid parameters", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: '{"param": "value"}',
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: { param: "value" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [{ type: "text", text: "Tool executed successfully" }],
				isError: false,
			}

			const postMessageToWebview = vi.fn(async (message: { text: string }) => {
				if (JSON.parse(message.text).status === "output") {
					throw new Error("webview unavailable")
				}
			})
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] },
						]),
					callTool: vi.fn().mockResolvedValue(mockToolResult),
				}),
				postMessageToWebview,
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "Tool executed successfully", [])
			expect(mockPushToolResult).toHaveBeenCalledWith("Tool result: Tool executed successfully")
			const statuses = executionStatuses(postMessageToWebview)
			expect(statuses.map(({ status }) => status)).toEqual(["started", "output", "completed"])
			expect(statuses.filter(({ status }) => status === "completed" || status === "error")).toHaveLength(1)
		})

		it("should handle user rejection", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: {},
				},
				partial: false,
			}

			// Ensure server/tool validation passes so we actually reach askApproval.
			mockProviderRef.deref.mockReturnValueOnce({
				getMcpHub: () => ({
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] },
						]),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			mockAskApproval.mockResolvedValue(false)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.say).not.toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("Tool result:"))
		})
	})

	describe("error handling", () => {
		it("fails closed with error metadata when no MCP hub is available", async () => {
			const setResultMetadata = vi.fn()
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => undefined,
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(
				mockTask as Task,
				{
					type: "tool_use",
					name: "use_mcp_tool",
					params: {},
					nativeArgs: { server_name: "missing", tool_name: "lookup" },
					partial: false,
				} as any,
				{
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					setResultMetadata,
				},
			)

			expect(setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("not configured"))
			expect(mockAskApproval).not.toHaveBeenCalled()
		})

		it("records an MCP isError response as a failed tool result", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				partial: false,
			}
			const setResultMetadata = vi.fn()

			mockAskApproval.mockResolvedValue(true)
			const postMessageToWebview = vi.fn()
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] },
						]),
					callTool: vi.fn().mockResolvedValue({
						isError: true,
						content: [{ type: "text", text: "Lookup failed" }],
					}),
				}),
				postMessageToWebview,
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				setResultMetadata,
			})

			expect(setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error:"))
			const statuses = executionStatuses(postMessageToWebview)
			expect(statuses.map(({ status }) => status)).toEqual(["started", "output", "error"])
			expect(statuses.filter(({ status }) => status === "completed" || status === "error")).toHaveLength(1)
		})

		it.each([
			["an undefined response", () => Promise.resolve(undefined)],
			["a rejected request", () => Promise.reject(new Error("MCP request failed"))],
		])("emits one terminal error for %s", async (_label, implementation) => {
			const setResultMetadata = vi.fn()
			const postMessageToWebview = vi.fn()
			mockAskApproval.mockResolvedValue(true)
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: () => [{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] }],
					callTool: vi.fn(implementation),
				}),
				postMessageToWebview,
			})

			await useMcpToolTool.handle(
				mockTask as Task,
				{
					type: "tool_use",
					name: "use_mcp_tool",
					params: {},
					nativeArgs: { server_name: "test_server", tool_name: "test_tool" },
					partial: false,
				} as any,
				{
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					setResultMetadata,
				},
			)

			expect(setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockHandleError).toHaveBeenCalledTimes(1)
			const statuses = executionStatuses(postMessageToWebview)
			expect(statuses.map(({ status }) => status)).toEqual(["started", "error"])
			expect(statuses.filter(({ status }) => status === "completed" || status === "error")).toHaveLength(1)
		})

		it("keeps an empty MCP content array successful", async () => {
			const setResultMetadata = vi.fn()
			const postMessageToWebview = vi.fn()
			mockAskApproval.mockResolvedValue(true)
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: () => [{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] }],
					callTool: vi.fn().mockResolvedValue({ content: [] }),
				}),
				postMessageToWebview,
			})

			await useMcpToolTool.handle(
				mockTask as Task,
				{
					type: "tool_use",
					name: "use_mcp_tool",
					params: {},
					nativeArgs: { server_name: "test_server", tool_name: "test_tool" },
					partial: false,
				} as any,
				{
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					setResultMetadata,
				},
			)

			expect(setResultMetadata).not.toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalledWith("Tool result: (No response)")
			expect(executionStatuses(postMessageToWebview).map(({ status }) => status)).toEqual([
				"started",
				"completed",
			])
		})

		it("should handle unexpected errors", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				partial: false,
			}

			// Ensure validation passes so askApproval is reached and throws
			mockProviderRef.deref.mockReturnValueOnce({
				getMcpHub: () => ({
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] },
						]),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const error = new Error("Unexpected error")
			mockAskApproval.mockRejectedValue(error)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledWith("executing MCP tool", error)
		})

		it("should reject unknown tool names", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.consecutiveMistakeCount = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [
						{ name: "existing-tool-1", description: "Tool 1" },
						{ name: "existing-tool-2", description: "Tool 2" },
					],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "non-existing-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				nativeArgs: {
					server_name: "test-server",
					tool_name: "non-existing-tool",
					arguments: { test: "data" },
				},
				partial: false,
			}

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("does not exist"))
			// Check that the error message contains available tools
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("existing-tool-1"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("existing-tool-2"))
		})

		it("should handle server with no tools", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.consecutiveMistakeCount = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "any-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				nativeArgs: {
					server_name: "test-server",
					tool_name: "any-tool",
					arguments: { test: "data" },
				},
				partial: false,
			}

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("does not exist"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("No tools available"))
		})

		it("should allow valid tool names", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.consecutiveMistakeCount = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [{ name: "valid-tool", description: "Valid Tool" }],
				},
			]

			const mockToolResult = {
				content: [{ type: "text", text: "Tool executed successfully" }],
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn().mockResolvedValue(mockToolResult),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "valid-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				nativeArgs: {
					server_name: "test-server",
					tool_name: "valid-tool",
					arguments: { test: "data" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "Tool executed successfully", [])
		})

		it("should reject unknown server names with available servers listed", async () => {
			// Arrange
			mockTask.consecutiveMistakeCount = 0

			const mockServers = [{ name: "s1", tools: [] }]
			const callToolMock = vi.fn()

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: callToolMock,
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: {},
				},
				partial: false,
			}

			// Act
			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Assert
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("not configured"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("s1"))
			expect(callToolMock).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})

		it("should reject unknown server names when no servers are available", async () => {
			// Arrange
			mockTask.consecutiveMistakeCount = 0

			const callToolMock = vi.fn()
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue([]),
					callTool: callToolMock,
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: {},
				},
				partial: false,
			}

			// Act
			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Assert
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("not configured"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("No servers available"))
			expect(callToolMock).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})

		it("should match tool names using fuzzy matching (hyphens vs underscores)", async () => {
			// This tests the scenario where models mangle hyphens to underscores
			// e.g., model sends "get_user_profile" but actual tool name is "get-user-profile"
			mockTask.consecutiveMistakeCount = 0

			const callToolMock = vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "Success" }],
			})

			const mockServers = [
				{
					name: "test-server",
					tools: [{ name: "get-user-profile", description: "Gets a user profile" }],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: callToolMock,
				}),
				postMessageToWebview: vi.fn(),
			})

			// Model sends the mangled version with underscores
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "get_user_profile", // Model mangled hyphens to underscores
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "test-server",
					tool_name: "get_user_profile", // Model mangled hyphens to underscores
					arguments: {},
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Tool should be found and executed
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")

			// The original tool name (with hyphens) should be passed to callTool
			expect(callToolMock).toHaveBeenCalledWith("test-server", "get-user-profile", {})
		})
	})

	describe("cancellation", () => {
		function validBlock(): ToolUse {
			return {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				partial: false,
			}
		}

		function installValidServer(callTool: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
			const postMessageToWebview = vi.fn()
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] },
						]),
					callTool,
				}),
				postMessageToWebview,
			})
			return postMessageToWebview
		}

		it("does not dispatch when the scheduler signal is already aborted", async () => {
			const controller = new AbortController()
			const reason = new Error("cancelled before dispatch")
			controller.abort(reason)
			const callTool = vi.fn()
			installValidServer(callTool)

			await expect(
				useMcpToolTool.handle(mockTask as Task, validBlock() as any, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					signal: controller.signal,
				}),
			).rejects.toThrow("cancelled before dispatch")
			expect(callTool).not.toHaveBeenCalled()
		})

		it("forwards the scheduler signal and rejects a late MCP settlement", async () => {
			let resolveRequest!: (result: unknown) => void
			let signalFromCall: AbortSignal | undefined
			let markStarted!: () => void
			const started = new Promise<void>((resolve) => {
				markStarted = resolve
			})
			const pending = new Promise<unknown>((resolve) => {
				resolveRequest = resolve
			})
			const callTool = vi.fn((...args: unknown[]) => {
				signalFromCall = args[4] as AbortSignal
				markStarted()
				return pending
			})
			const postMessageToWebview = installValidServer(callTool)
			mockAskApproval.mockResolvedValue(true)
			const controller = new AbortController()
			const running = useMcpToolTool.handle(mockTask as Task, validBlock() as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				signal: controller.signal,
			})

			await started
			expect(signalFromCall).toBe(controller.signal)
			controller.abort(new Error("cancelled while dispatched"))
			resolveRequest({ content: [{ type: "text", text: "late output" }] })

			await expect(running).rejects.toThrow("cancelled while dispatched")
			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(mockTask.say).not.toHaveBeenCalledWith("mcp_server_response", expect.anything(), expect.anything())
			const statuses = executionStatuses(postMessageToWebview)
			expect(statuses.map(({ status }) => status)).toEqual(["started", "error"])
			expect(statuses.filter(({ status }) => status === "completed" || status === "error")).toHaveLength(1)
		})

		it("settles when the forwarded MCP request observes cancellation", async () => {
			let markStarted!: () => void
			const started = new Promise<void>((resolve) => {
				markStarted = resolve
			})
			const callTool = vi.fn((...args: unknown[]) => {
				const requestSignal = args[4] as AbortSignal
				markStarted()
				return new Promise<never>((_, reject) => {
					requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true })
				})
			})
			const postMessageToWebview = installValidServer(callTool)
			mockAskApproval.mockResolvedValue(true)
			const controller = new AbortController()
			const running = useMcpToolTool.handle(mockTask as Task, validBlock() as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				signal: controller.signal,
			})

			await started
			controller.abort(new Error("request observed cancellation"))
			await expect(running).rejects.toThrow("request observed cancellation")
			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(executionStatuses(postMessageToWebview).map(({ status }) => status)).toEqual(["started", "error"])
		})
	})

	describe("image handling", () => {
		it("normalizes an embedded image resource into image content", () => {
			const result = (useMcpToolTool as any).processToolContent({
				content: [
					{
						type: "resource",
						resource: {
							uri: "file:///report.png",
							mimeType: "image/png",
							blob: "iVBORw0KGgo=",
						},
					},
				],
			})

			expect(result).toEqual({ text: "", images: ["data:image/png;base64,iVBORw0KGgo="] })
		})

		it("preserves metadata for embedded text resources", () => {
			const result = (useMcpToolTool as any).processToolContent({
				content: [
					{
						type: "resource",
						resource: {
							uri: "file:///report.txt",
							mimeType: "text/plain",
							text: "report contents",
							_meta: { source: "fixture" },
						},
					},
				],
			})

			expect(result.images).toEqual([])
			expect(result.text).toBe(
				JSON.stringify(
					{
						uri: "file:///report.txt",
						mimeType: "text/plain",
						text: "report contents",
						_meta: { source: "fixture" },
					},
					null,
					2,
				),
			)
		})

		it("describes unsupported binary resources without copying the blob", () => {
			const blob = "A".repeat(100_000)
			const result = (useMcpToolTool as any).processToolContent({
				content: [
					{
						type: "resource",
						resource: {
							uri: "file:///archive.zip",
							mimeType: "application/zip",
							blob,
						},
					},
				],
			})

			expect(result.images).toEqual([])
			expect(result.text).toContain("unsupported_binary_resource")
			expect(result.text).toContain('"base64Characters": 100000')
			expect(result.text).not.toContain(blob)
			expect(result.text.length).toBeLessThan(1024)
		})

		it("should handle tool response with image content", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "figma-server",
					tool_name: "get_screenshot",
					arguments: '{"nodeId": "123"}',
				},
				nativeArgs: {
					server_name: "figma-server",
					tool_name: "get_screenshot",
					arguments: { nodeId: "123" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
					},
				],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
					getAllServers: vi.fn().mockReturnValue([
						{
							name: "figma-server",
							tools: [{ name: "get_screenshot", description: "Get screenshot" }],
						},
					]),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "[1 image(s) received]", [
				"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
			])
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("with 1 image(s)"))
		})

		it("should handle tool response with both text and image content", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "figma-server",
					tool_name: "get_node_info",
					arguments: '{"nodeId": "123"}',
				},
				nativeArgs: {
					server_name: "figma-server",
					tool_name: "get_node_info",
					arguments: { nodeId: "123" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [
					{ type: "text", text: "Node name: Button" },
					{
						type: "image",
						mimeType: "image/png",
						data: "base64imagedata",
					},
				],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "figma-server", tools: [{ name: "get_node_info", description: "Get node info" }] },
						]),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "Node name: Button", [
				"data:image/png;base64,base64imagedata",
			])
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("with 1 image(s)"))
		})

		it("should handle image with data URL already formatted", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "figma-server",
					tool_name: "get_screenshot",
					arguments: '{"nodeId": "123"}',
				},
				nativeArgs: {
					server_name: "figma-server",
					tool_name: "get_screenshot",
					arguments: { nodeId: "123" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [
					{
						type: "image",
						mimeType: "image/jpeg",
						data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
					},
				],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
					getAllServers: vi.fn().mockReturnValue([
						{
							name: "figma-server",
							tools: [{ name: "get_screenshot", description: "Get screenshot" }],
						},
					]),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should not double-prefix the data URL
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "[1 image(s) received]", [
				"data:image/jpeg;base64,/9j/4AAQSkZJRg==",
			])
		})

		it("should handle multiple images in response", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "figma-server",
					tool_name: "get_screenshots",
					arguments: '{"nodeIds": ["1", "2"]}',
				},
				nativeArgs: {
					server_name: "figma-server",
					tool_name: "get_screenshots",
					arguments: { nodeIds: ["1", "2"] },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [
					{
						type: "image",
						mimeType: "image/png",
						data: "image1data",
					},
					{
						type: "image",
						mimeType: "image/png",
						data: "image2data",
					},
				],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
					getAllServers: vi.fn().mockReturnValue([
						{
							name: "figma-server",
							tools: [{ name: "get_screenshots", description: "Get screenshots" }],
						},
					]),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "[2 image(s) received]", [
				"data:image/png;base64,image1data",
				"data:image/png;base64,image2data",
			])
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("with 2 image(s)"))
		})
	})
})
