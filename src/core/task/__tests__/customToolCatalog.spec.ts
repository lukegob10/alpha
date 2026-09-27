import { customToolRegistry } from "@alpha-code/core"
import { parametersSchema as z, type CustomToolDefinition, type McpServer } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

const testState = vi.hoisted(() => ({
	codeIndex: { isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false },
}))

vi.mock("../../../services/browser/VSCodeBrowserTools", () => ({
	getAvailableVSCodeBrowserToolNames: () => [],
}))
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: () => testState.codeIndex },
}))

import type { AlphaProvider } from "../../webview/AlphaProvider"
import type { Task } from "../Task"
import type { ToolCallbacks } from "../../tools/BaseTool"
import type { ToolUse } from "../../../shared/tools"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../build-tools"

afterEach(() => customToolRegistry.clear())

function register(name: string) {
	const execute = vi.fn(async () => `${name} result`)
	const definition: CustomToolDefinition = {
		name,
		description: `${name} fixture`,
		parameters: z.object({ value: z.string() }),
		execute,
	}
	customToolRegistry.register(definition)
	return execute
}

function options(): BuildToolsOptions {
	const provider = { context: {}, getMcpHub: () => undefined }
	return {
		provider: provider as unknown as AlphaProvider,
		cwd: process.cwd(),
		mode: "code",
		customModes: undefined,
		experiments: { customTools: true },
		apiConfiguration: { apiProvider: "vertex" },
	}
}

describe("custom tool catalog names", () => {
	it.each([
		"exec_command",
		"execute_command",
		"write_file",
		"update_todo_list",
		"tool_search",
		"mcp--server--read",
		"mcp__server__read",
	])("keeps reserved custom name %s outside the executable and provider catalog", async (name) => {
		const execute = register(name)
		const result = await buildNativeToolsArrayWithRestrictions(options())
		const customSchemas = result.tools.filter(
			(tool) => tool.type === "function" && tool.function.description === `${name} fixture`,
		)

		expect(customSchemas).toEqual([])
		expect(
			result.registry
				?.list()
				.filter(
					(descriptor) =>
						descriptor.schema.type === "function" &&
						descriptor.schema.function.description === `${name} fixture`,
				),
		).toEqual([])
		expect(execute).not.toHaveBeenCalled()
		expect(result.surface?.resolve("list_tickets")?.exposure).toBe("eager")
		expect(result.surface?.resolve("exec_command")?.name).toBe("exec_command")
	})

	it("keeps a distinct custom tool callable", async () => {
		const execute = register("fixture_custom_tool")
		const result = await buildNativeToolsArrayWithRestrictions(options())
		const descriptor = result.surface?.resolve("fixture_custom_tool")
		expect(descriptor?.execute).toBeTypeOf("function")
		const outputs: unknown[] = []
		await descriptor!.execute({
			task: { getTaskMode: async () => "code" } as Task,
			call: {
				type: "tool_use",
				id: "custom-call",
				name: "custom_tool",
				params: {},
				partial: false,
				nativeArgs: { value: "test" },
			} as ToolUse,
			callbacks: {
				pushToolResult: (value: unknown) => {
					outputs.push(value)
				},
			} as unknown as ToolCallbacks,
		})
		expect(outputs).toEqual(["fixture_custom_tool result"])
		expect(execute).toHaveBeenCalledOnce()
	})

	it("keeps an MCP descriptor when a custom tool claims its name", async () => {
		register("mcp--server--read")
		const server: McpServer = {
			name: "server",
			config: "{}",
			status: "connected",
			source: "global",
			tools: [
				{
					name: "read",
					description: "MCP read fixture",
					inputSchema: { type: "object", properties: {} },
				},
			],
		}
		const hub = { connections: [], getServers: () => [server] }
		const provider = { context: {}, getMcpHub: () => hub }
		const result = await buildNativeToolsArrayWithRestrictions({
			...options(),
			provider: provider as unknown as AlphaProvider,
		})
		const descriptor = result.surface?.resolve("mcp--server--read")
		expect(descriptor?.schema).toMatchObject({
			function: { name: "mcp--server--read", description: "MCP read fixture" },
		})
		expect(descriptor?.exposure).toBe("deferred")
	})
})
