import { describe, expect, it } from "vitest"

import { getLegacyFileToolSchemas, getNativeTools } from "../../prompts/tools/native-tools"
import { canonicalizeToolName, getToolCapabilities, ToolRegistry } from "../ToolRegistry"
import { discoverTools, toolSearch } from "../../prompts/tools/native-tools/discover_tools"
import { createTaskToolSurface } from "../TaskToolSurface"
import { createToolPolicySnapshot } from "../../agent/ToolPolicy"

function schema(name: string) {
	return {
		type: "function" as const,
		function: {
			name,
			description: `${name} fixture`,
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	}
}

describe("ToolRegistry", () => {
	it.each(["descriptor", "alias"])("keeps rejected registration atomic after a %s conflict", (conflict) => {
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const fixture = (name: string, aliases: string[]) => ({
			name,
			aliases,
			schema: schema(name),
			capabilities: {
				concurrency: "serial" as const,
				sideEffects: "none" as const,
				controlFlow: false,
				requiresApproval: false,
			},
			execute: async () => {},
		})
		registry.register(fixture("existing", conflict === "alias" ? ["occupied"] : []))
		const beforeSchemas = registry.getSchemas()
		const beforeAliases = registry.getAliases()

		expect(() =>
			registry.register(fixture("rejected", ["new_alias", conflict === "alias" ? "occupied" : "existing"])),
		).toThrow(/alias/)

		expect(registry.getSchemas()).toEqual(beforeSchemas)
		expect(registry.getAliases()).toEqual(beforeAliases)
		expect(registry.resolve("rejected")).toBeUndefined()
		expect(registry.resolve("new_alias")).toBeUndefined()
		registry.register(fixture("rejected", ["new_alias"]))
		expect(registry.resolve("new_alias")?.name).toBe("rejected")
	})

	it("does not advertise or execute the retired image-generation provider", () => {
		const registry = new ToolRegistry()
		expect(registry.resolve("generate_image")).toBeUndefined()
		expect(registry.getSchema("generate_image")).toBeUndefined()
	})
	it("exposes Codex model tools and keeps retired task controls out of the catalog", () => {
		const registry = new ToolRegistry()
		const names = registry.getSchemas().flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(registry.resolve("switch_mode")).toBeUndefined()
		expect(names).not.toContain("switch_mode")
		expect(names).not.toContain("update_todo_list")
		expect(names).toEqual(expect.arrayContaining(["apply_patch", "exec_command", "write_stdin", "update_plan"]))
		expect(names).toEqual(
			expect.arrayContaining([
				"spawn_agent",
				"list_agents",
				"wait_agent",
				"send_message",
				"followup_task",
				"interrupt_agent",
			]),
		)
		for (const retiredName of [
			"new_task",
			"attempt_completion",
			"ask_followup_question",
			"write_to_file",
			"edit",
		]) {
			expect(registry.resolve(retiredName), retiredName).toBeUndefined()
			expect(names, retiredName).not.toContain(retiredName)
		}
		expect(registry.has("spawn_agent")).toBe(true)
		expect(registry.getSchema("spawn_agent")).toMatchObject({
			function: {
				name: "spawn_agent",
				parameters: { properties: { task_name: { type: "string" }, message: { type: "string" } } },
			},
		})
		const planRegistry = new ToolRegistry({ nativeTools: getNativeTools({ planMode: true }) })
		expect(planRegistry.getSchema("request_user_input")).toMatchObject({
			function: { name: "request_user_input" },
		})
	})
	it("registers the built-in tools with their provider schemas", () => {
		const registry = new ToolRegistry()

		expect(registry.resolve("wait_agent")?.capabilities.concurrency).toBe("barrier")
		expect(registry.resolve("exec_command")?.capabilities.concurrency).toBe("serial")
		expect(registry.resolve("exec_command")?.schema).toMatchObject({ function: { name: "exec_command" } })
		for (const name of ["read_file", "list_files", "search_files", "codebase_search"]) {
			expect(registry.resolve(name), name).toBeUndefined()
		}
		expect(registry.resolve("write_stdin")?.capabilities.sideEffects).toBe("workspace")
		expect(registry.resolve("spawn_agent")?.capabilities).toMatchObject({
			concurrency: "serial",
			sideEffects: "task",
			controlFlow: false,
		})
		expect(registry.resolve("list_agents")?.capabilities).toMatchObject({
			concurrency: "parallel",
			sideEffects: "none",
			controlFlow: false,
		})
		expect(registry.resolve("wait_agent")?.capabilities).toMatchObject({
			concurrency: "barrier",
			sideEffects: "task",
			controlFlow: true,
		})
		for (const name of ["send_message", "followup_task", "interrupt_agent"]) {
			expect(registry.resolve(name)?.capabilities).toMatchObject({
				concurrency: "serial",
				sideEffects: "task",
				controlFlow: false,
			})
		}
		for (const name of ["delegate_task", "report_progress", "cancel_agent", "close_agent"]) {
			expect(registry.resolve(name)).toBeUndefined()
		}
		expect(registry.resolve("open_browser_page")?.capabilities).toMatchObject({
			concurrency: "serial",
			sideEffects: "external",
			controlFlow: false,
		})
		expect(registry.resolve("run_playwright_code")?.schema).toMatchObject({
			type: "function",
			function: { name: "run_playwright_code" },
		})
	})
	it("does not register retired file tools or the generic MCP wrapper even when old schemas are supplied", () => {
		const catalog = getNativeTools()
		const registry = new ToolRegistry({
			nativeTools: [...catalog, ...getLegacyFileToolSchemas()],
		})
		const catalogNames = catalog.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		for (const name of ["read_file", "list_files", "search_files", "codebase_search"]) {
			expect(catalogNames, name).not.toContain(name)
			expect(registry.resolve(name), name).toBeUndefined()
		}
		expect(new ToolRegistry({ nativeTools: [schema("use_mcp_tool")] }).resolve("use_mcp_tool")).toBeUndefined()
		expect(
			new ToolRegistry({ mcpTools: [schema("mcp--filesystem--read_file")] }).resolve(
				"mcp--filesystem--read_file",
			),
		).toBeDefined()
	})

	it("uses exec_command as the canonical descriptor and preserves command aliases", () => {
		const registry = new ToolRegistry()

		expect(registry.resolve("exec_command")?.name).toBe("exec_command")
		expect(registry.resolve("write_stdin")?.name).toBe("write_stdin")
		expect(registry.resolve("shell")?.name).toBe("exec_command")
		expect(registry.resolve("execute_command")?.name).toBe("exec_command")
		expect(registry.resolve("shell")?.schema).toMatchObject({
			function: { name: "exec_command" },
		})
		expect(registry.resolve("update_plan")?.name).toBe("update_plan")
		expect(registry.resolve("update_todo_list")?.name).toBe("update_plan")
		expect(registry.getSchema("update_plan")).toMatchObject({
			function: { name: "update_plan" },
		})
		expect(registry.getSchema("update_todo_list")).toMatchObject({
			function: { name: "update_plan" },
		})
		expect(registry.canonicalName("exec_command")).toBe("exec_command")
		expect(registry.canonicalName("shell")).toBe("exec_command")
		expect(registry.canonicalName("execute_command")).toBe("exec_command")
		expect(registry.canonicalName("update_plan")).toBe("update_plan")
		expect(registry.canonicalName("update_todo_list")).toBe("update_plan")
		expect(canonicalizeToolName("discover_tools")).toBe("tool_search")
		expect(canonicalizeToolName("tool_search")).toBe("tool_search")
		expect(registry.getSchema("exec_command")).toMatchObject({
			function: { name: "exec_command" },
		})
		expect(registry.getSchema("write_stdin")).toMatchObject({ function: { name: "write_stdin" } })
		expect(getToolCapabilities("exec_command")).toEqual(getToolCapabilities("shell"))
		expect(getToolCapabilities("exec_command").parallelCommandRead).toBe(true)
		expect(getToolCapabilities("write_stdin").sideEffects).toBe("workspace")
		expect(
			registry.getSchemas().some((tool) => tool.type === "function" && tool.function.name === "execute_command"),
		).toBe(false)
		expect(registry.resolve("read_command_output")).toBeUndefined()
	})

	it("captures command schema, policy, and approval metadata under the live tool name", () => {
		const registry = new ToolRegistry()
		const command = registry.resolve("exec_command")!
		const surface = createTaskToolSurface({
			registry,
			schemas: [command.schema],
			visibleToolNames: ["exec_command"],
			allowedToolNames: ["exec_command"],
			policy: createToolPolicySnapshot({
				visibleTools: ["exec_command"],
				allowedTools: ["exec_command"],
				approvalMode: "ask",
				capabilities: { exec_command: command.capabilities },
			}),
			applyProfile: false,
		})

		expect(command.name).toBe("exec_command")
		expect(surface.schemas.map((tool) => (tool.type === "function" ? tool.function.name : ""))).toEqual([
			"exec_command",
		])
		expect(surface.policy.visibleTools).toEqual(["exec_command"])
		expect(surface.policy.allowedTools).toEqual(["exec_command"])
		expect(surface.policy.approval.mode).toBe("ask")
		expect(surface.policy.capabilities.exec_command).toMatchObject({
			sideEffects: "workspace",
			requiresApproval: true,
		})
		expect(surface.isCallable("exec_command")).toBe(true)
		expect(surface.isCallable("shell")).toBe(true)
		expect(surface.resolve("shell")?.name).toBe("exec_command")
	})

	it("registers the canonical tool_search descriptor without advertising its legacy schema", () => {
		const registry = new ToolRegistry({ nativeTools: [toolSearch, discoverTools] })

		expect(registry.resolve("tool_search")?.name).toBe("tool_search")
		expect(registry.resolve("discover_tools")?.name).toBe("tool_search")
		expect(registry.getSchema("tool_search")).toMatchObject({ function: { name: "tool_search" } })
		expect(
			registry
				.getSchemas()
				.filter((item) => item.type === "function")
				.map((item) => item.function.name),
		).toContain("tool_search")
		expect(
			registry
				.getSchemas()
				.filter((item) => item.type === "function")
				.map((item) => item.function.name),
		).not.toContain("discover_tools")
	})

	it("registers retired agent executors only when historical schemas are explicit", () => {
		const historicalNames = ["delegate_task", "report_progress", "cancel_agent", "close_agent"]
		const registry = new ToolRegistry({
			nativeTools: historicalNames.map((name) => ({
				type: "function" as const,
				function: {
					name,
					description: `${name} historical fixture`,
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			})),
		})

		for (const name of historicalNames) {
			expect(registry.resolve(name)?.name).toBe(name)
			expect(registry.resolve(name)?.execute).toBeTypeOf("function")
		}
	})

	it("rejects unknown tools without inventing a descriptor", () => {
		const registry = new ToolRegistry()

		expect(registry.resolve("does_not_exist")).toBeUndefined()
		expect(registry.has("does_not_exist")).toBe(false)
	})

	it("adapts dynamic MCP schemas into serial descriptors", () => {
		const registry = new ToolRegistry({
			mcpTools: [schema("mcp--filesystem--read_file")],
		})

		expect(registry.resolve("mcp--filesystem--read_file")?.capabilities.concurrency).toBe("serial")
		expect(registry.resolve("mcp--filesystem--read_file")?.statusSource).toBe("handler")
		expect(registry.resolve("mcp__filesystem__read_file")?.name).toBe("mcp--filesystem--read_file")
		expect(registry.getSchema("mcp--filesystem--read_file")).toMatchObject({
			function: { name: "mcp--filesystem--read_file" },
		})
	})

	it("keeps captured MCP read-only scheduling separate from approval and side-effect policy", () => {
		const readOnly = "mcp--calendar--lookup"
		const ambiguous = "mcp--calendar--update"
		const registry = new ToolRegistry({
			nativeTools: [],
			mcpTools: [schema(readOnly), schema(ambiguous)],
			mcpToolTargets: new Map([
				[readOnly, { serverName: "calendar", toolName: "lookup", parallelRead: true }],
				[ambiguous, { serverName: "calendar", toolName: "update", parallelRead: false }],
			]),
		})

		expect(registry.resolve(readOnly)?.capabilities).toEqual({
			concurrency: "serial",
			sideEffects: "external",
			controlFlow: false,
			requiresApproval: true,
			parallelMcpRead: true,
		})
		expect(registry.resolve(ambiguous)?.capabilities).toEqual({
			concurrency: "serial",
			sideEffects: "external",
			controlFlow: false,
			requiresApproval: true,
		})
	})

	it("assigns custom tool result status to the handler instead of returned text", () => {
		const registry = new ToolRegistry({
			includeBuiltIns: false,
			customTools: [
				{
					definition: {
						name: "custom_result",
						description: "Returns opaque JSON",
						execute: async () => JSON.stringify({ status: "error" }),
					},
					schema: schema("custom_result"),
				},
			],
		})
		expect(registry.resolve("custom_result")?.statusSource).toBe("handler")
	})

	it("prefers the canonical dynamic MCP schema when an alias appears first", () => {
		const alias = schema("mcp__filesystem__read_file")
		alias.function.description = "legacy MCP alias schema"
		const canonical = schema("mcp--filesystem--read_file")
		canonical.function.description = "canonical MCP schema"

		const registry = new ToolRegistry({ nativeTools: [], mcpTools: [alias, canonical] })

		expect(registry.resolve("mcp--filesystem--read_file")?.schema).toMatchObject({
			function: { name: "mcp--filesystem--read_file", description: "canonical MCP schema" },
		})
	})

	it("supports fixture descriptors without changing the built-in registry", () => {
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			name: "fixture_read",
			aliases: ["fixture_read_alias"],
			schema: schema("fixture_read"),
			capabilities: {
				concurrency: "parallel",
				sideEffects: "none",
				controlFlow: false,
				requiresApproval: false,
			},
			execute: async () => {},
		})

		expect(registry.resolve("fixture_read_alias")?.name).toBe("fixture_read")
		expect(registry.getSchemas()).toHaveLength(1)
	})
})
