import * as fs from "fs/promises"
import os from "os"
import path from "path"

import { customToolRegistry, type CatalogLoadResult } from "@alpha-code/core"
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
import type { ToolDescriptor } from "../../tools/ToolRegistry"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../build-tools"

afterEach(() => {
	customToolRegistry.clear()
	vi.restoreAllMocks()
})

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

async function invoke(descriptor: ToolDescriptor, nativeArgs: Record<string, unknown> = {}) {
	const outputs: unknown[] = []
	await descriptor.execute({
		task: { getTaskMode: async () => "code" } as Task,
		mode: "code",
		call: {
			type: "tool_use",
			id: "custom-call",
			name: "custom_tool",
			params: {},
			partial: false,
			nativeArgs,
		} as ToolUse,
		callbacks: {
			askApproval: async () => true,
			pushToolResult: (value: unknown) => outputs.push(value),
		} as unknown as ToolCallbacks,
	})
	return outputs
}

describe("custom tool catalog names", () => {
	it("advertises custom transform inputs and executes their parsed values", async () => {
		const execute = vi.fn(async ({ value }: { value: string }) => value)
		customToolRegistry.register({
			name: "transform_input",
			description: "Accepts a string before applying a local transform",
			parameters: z.object({ value: z.string().transform((value) => value.toUpperCase()) }),
			execute,
		})

		const result = await buildNativeToolsArrayWithRestrictions(options())
		const descriptor = result.surface?.resolve("transform_input")
		expect(descriptor?.schema).toMatchObject({
			function: { parameters: { properties: { value: { type: "string" } } } },
		})
		expect(await invoke(descriptor!, { value: "accepted input" })).toEqual(["ACCEPTED INPUT"])
		expect(execute).toHaveBeenCalledWith({ value: "ACCEPTED INPUT" }, expect.objectContaining({ mode: "code" }))
		expect(result.surface?.resolve("exec_command")).toBeDefined()
	})

	it.each(["exec_command", "mcp--server--read", "disabled_custom"])(
		"filters unavailable custom name %s before inspecting its schema",
		async (name) => {
			const readParameters = vi.fn((): CustomToolDefinition["parameters"] => {
				throw new Error("An unavailable custom schema must not be evaluated")
			})
			const definition: CustomToolDefinition = {
				name,
				description: "Unavailable custom definition",
				get parameters() {
					return readParameters()
				},
				execute: vi.fn(async () => "must not execute"),
			}
			vi.spyOn(customToolRegistry, "loadFromDirectoriesIfStale").mockResolvedValue({
				loaded: [name],
				failed: [],
				catalog: [definition],
			})

			const result = await buildNativeToolsArrayWithRestrictions({
				...options(),
				disabledTools: ["disabled_custom"],
			})
			expect(readParameters).not.toHaveBeenCalled()
			expect(result.surface?.resolve("exec_command")).toBeDefined()
			expect(result.surface?.resolve("list_tickets")).toBeDefined()
			expect(result.surface?.resolve("disabled_custom")).toBeUndefined()
			expect(
				result.tools.filter(
					(tool) => tool.type === "function" && tool.function.description === definition.description,
				),
			).toEqual([])
		},
	)

	it("keeps native and valid custom tools available when a loaded schema is rejected", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-custom-catalog-input-"))
		try {
			const directory = path.join(workspace, ".alpha", "tools")
			await fs.mkdir(directory, { recursive: true })
			await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }))
			await fs.writeFile(
				path.join(directory, "invalid.js"),
				'export default { name: "invalid_input", description: "Malformed schema", parameters: { _def: {} }, execute: async () => "unused" }',
			)
			await fs.writeFile(
				path.join(directory, "valid.js"),
				'export default { name: "valid_sibling", description: "Valid sibling", execute: async () => "available" }',
			)

			const result = await buildNativeToolsArrayWithRestrictions({ ...options(), cwd: workspace })
			expect(result.surface?.resolve("invalid_input")).toBeUndefined()
			expect(result.surface?.resolve("exec_command")).toBeDefined()
			expect(result.surface?.resolve("list_tickets")).toBeDefined()
			expect(await invoke(result.surface!.resolve("valid_sibling")!)).toEqual(["available"])
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
		}
	})

	it("captures each overlapping workspace load's owned definitions", async () => {
		const definitionA: CustomToolDefinition = {
			name: "workspace_a_tool",
			description: "workspace A",
			execute: async () => "A",
		}
		const definitionB: CustomToolDefinition = {
			name: "workspace_b_tool",
			description: "workspace B",
			execute: async () => "B",
		}
		let enterA!: () => void
		const enteredA = new Promise<void>((resolve) => (enterA = resolve))
		let releaseA!: (value: CatalogLoadResult) => void
		const loadingA = new Promise<CatalogLoadResult>((resolve) => (releaseA = resolve))
		vi.spyOn(customToolRegistry, "loadFromDirectoriesIfStale").mockImplementation(async (directories) => {
			if (directories.some((directory) => directory.includes("workspace-a"))) {
				enterA()
				return loadingA
			}
			return { loaded: [definitionB.name], failed: [], catalog: [definitionB] }
		})
		const pendingA = buildNativeToolsArrayWithRestrictions({ ...options(), cwd: "workspace-a" })
		await enteredA
		const capturedB = await buildNativeToolsArrayWithRestrictions({ ...options(), cwd: "workspace-b" })
		releaseA({ loaded: [definitionA.name], failed: [], catalog: [definitionA] })
		const capturedA = await pendingA

		expect(capturedB.surface?.resolve(definitionA.name)).toBeUndefined()
		expect(capturedA.surface?.resolve(definitionB.name)).toBeUndefined()
		expect(capturedA.surface?.resolve(definitionA.name)).toBeDefined()
		expect(capturedB.surface?.resolve(definitionB.name)).toBeDefined()
		expect(await invoke(capturedA.surface!.resolve(definitionA.name)!)).toEqual(["A"])
		expect(await invoke(capturedB.surface!.resolve(definitionB.name)!)).toEqual(["B"])
	})

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
			mode: "code",
			call: {
				type: "tool_use",
				id: "custom-call",
				name: "custom_tool",
				params: {},
				partial: false,
				nativeArgs: { value: "test" },
			} as ToolUse,
			callbacks: {
				askApproval: async () => true,
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
