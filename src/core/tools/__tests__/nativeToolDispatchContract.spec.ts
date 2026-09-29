import type Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it } from "vitest"

import { getLegacyFileToolSchemas, getNativeTools } from "../../prompts/tools/native-tools"
import { ALWAYS_AVAILABLE_TOOLS, TOOL_GROUPS } from "../../../shared/tools"
import { createAgentResponse, type AgentToolCall } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import type { Task } from "../../task/Task"
import { ToolRegistry } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"
import { isValidToolName } from "../validateToolUse"

const lifecycleToolNames = [
	"spawn_agent",
	"list_agents",
	"wait_agent",
	"send_message",
	"followup_task",
	"interrupt_agent",
] as const

const retiredAgentToolNames = ["delegate_task", "report_progress", "cancel_agent", "close_agent"] as const

describe("native tool production dispatch contract", () => {
	it("exposes native schemas through the captured executable registry", () => {
		const schemas = getNativeTools()
		const surface = createTaskToolSurface({
			registry: new ToolRegistry({ nativeTools: schemas }),
			schemas,
			mode: "code",
		})
		const exposedNames = schemas.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(exposedNames).toContain("update_plan")
		expect(exposedNames).toContain("apply_patch")
		expect(exposedNames).toContain("request_user_input")
		expect(exposedNames).not.toContain("update_todo_list")
		expect(ALWAYS_AVAILABLE_TOOLS).toContain("update_plan")
		expect(ALWAYS_AVAILABLE_TOOLS).not.toContain("update_todo_list")
		expect(surface.registry.resolve("update_plan")?.name).toBe("update_plan")
		expect(surface.resolve("update_plan")?.name).toBe("update_plan")
		expect(surface.allowedFunctionNames).toContain("update_plan")
		expect(surface.allowedFunctionNames).not.toContain("update_todo_list")
		const retiredNames = [
			"attempt_completion",
			"ask_followup_question",
			"edit",
			"write_to_file",
			"manage_command",
			"new_task",
		]
		for (const name of retiredNames) {
			expect(exposedNames).not.toContain(name)
			expect(surface.isCallable(name), name).toBe(false)
			expect(surface.resolve(name), name).toBeUndefined()
			expect(surface.registry.resolve(name), name).toBeUndefined()
		}
		expect(exposedNames).toEqual(expect.arrayContaining([...lifecycleToolNames]))
		expect(exposedNames).not.toEqual(expect.arrayContaining([...retiredAgentToolNames]))
		for (const name of exposedNames) {
			expect(surface.isCallable(name), name).toBe(true)
			expect(surface.resolve(name)?.execute, name).toBeTypeOf("function")
		}
		for (const name of lifecycleToolNames) {
			expect(isValidToolName(name), name).toBe(true)
			expect(ALWAYS_AVAILABLE_TOOLS).not.toContain(name)
			expect(Object.values(TOOL_GROUPS).flatMap((group) => group.tools)).toContain(name)
		}
		for (const name of retiredAgentToolNames) {
			expect(isValidToolName(name), name).toBe(true)
			expect(Object.values(TOOL_GROUPS).flatMap((group) => group.tools)).not.toContain(name)
		}
	})

	it("registers Plan input without Code checklist or legacy schemas", () => {
		const planSchemas = getNativeTools({ planMode: true })
		const registry = new ToolRegistry({ nativeTools: planSchemas })
		const names = planSchemas.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(names).toContain("request_user_input")
		expect(names).not.toContain("update_plan")
		expect(names).not.toContain("update_todo_list")
		expect(isValidToolName("request_user_input")).toBe(true)
		expect(registry.resolve("request_user_input")?.execute).toBeTypeOf("function")
		expect(registry.resolve("update_plan")).toBeUndefined()
		expect(registry.resolve("ask_followup_question")).toBeUndefined()
	})

	it("rejects attempted dispatches for hidden legacy tool names", async () => {
		const schemas = getNativeTools()
		const surface = createTaskToolSurface({
			registry: new ToolRegistry({ nativeTools: schemas }),
			schemas,
			mode: "code",
		})
		const results: Anthropic.ToolResultBlockParam[] = []
		const host: ToolExecutionHost = {
			taskId: "hidden-legacy-tool-contract",
			cwd: process.cwd(),
			userMessageContent: results,
			taskFacade: {} as unknown as Task,
			ask: async () => ({ response: "yesButtonClicked" as const }),
			say: async () => {},
			recordToolUsage: () => {},
			pushToolResultToUserContent(result: Anthropic.ToolResultBlockParam) {
				results.push(result)
				return true
			},
		} as unknown as ToolExecutionHost
		const hiddenNames = [
			"attempt_completion",
			"ask_followup_question",
			"edit",
			"write_to_file",
			"manage_command",
			"new_task",
		] as const
		const calls: AgentToolCall[] = hiddenNames.map((name, index) => ({
			type: "tool_call",
			id: `hidden-${index}`,
			name,
			arguments: {},
		}))

		const outcome = await new ToolScheduler({
			executionHost: host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
		}).run(createAgentResponse(calls))

		expect(outcome.results.map((result) => result.status)).toEqual(hiddenNames.map(() => "error"))
		expect(JSON.stringify(outcome.results)).toContain("not registered")
		expect(results).toHaveLength(hiddenNames.length)
	})

	it.each([
		{ name: "Code", mode: "code", schemas: getNativeTools() },
		{ name: "Plan", mode: "architect", schemas: getNativeTools({ planMode: true }) },
	])("never registers retired file descriptors on the $name surface", ({ mode, schemas }) => {
		const registry = new ToolRegistry({
			nativeTools: [...schemas, ...getLegacyFileToolSchemas()],
		})
		const surface = createTaskToolSurface({ registry, schemas, mode })
		const names = schemas.flatMap((schema) => (schema.type === "function" ? [schema.function.name] : []))

		for (const name of ["read_file", "list_files", "search_files", "codebase_search"]) {
			expect(names, name).not.toContain(name)
			expect(registry.resolve(name), name).toBeUndefined()
			expect(surface.resolve(name), name).toBeUndefined()
			expect(surface.isCallable(name), name).toBe(false)
		}
	})

	it("does not register request_user_input for Plan subagents", () => {
		const subagentPlanSchemas = getNativeTools({ planMode: true, taskKind: "subagent" })
		const names = subagentPlanSchemas.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(names).not.toContain("request_user_input")
	})

	it("keeps retired agent executors available only through explicit historical schemas", () => {
		const schemas = retiredAgentToolNames.map((name) => ({
			type: "function" as const,
			function: {
				name,
				description: `${name} historical fixture`,
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		}))
		const registry = new ToolRegistry({ nativeTools: schemas })

		for (const name of retiredAgentToolNames) {
			expect(registry.resolve(name)?.execute, name).toBeTypeOf("function")
			expect(registry.getSchemas().some((tool) => tool.type === "function" && tool.function.name === name)).toBe(
				true,
			)
		}
	})

	it("captures dynamic MCP aliases without granting disabled names authority", () => {
		const mcpTools = [
			{
				type: "function" as const,
				function: {
					name: "mcp--docs--lookup",
					description: "Look up a document",
					parameters: { type: "object", properties: {} },
				},
			},
		]
		const registry = new ToolRegistry({ mcpTools })
		const surface = createTaskToolSurface({
			registry,
			disabledTools: ["mcp__docs__lookup"],
			includeAllToolsWithRestrictions: true,
		})
		expect(registry.resolve("mcp__docs__lookup")).toBe(registry.resolve("mcp--docs--lookup"))
		expect(registry.resolve("mcp--docs--lookup")?.execute).toBeTypeOf("function")
		expect(surface.resolve("mcp--docs--lookup")).toBeUndefined()
		expect(surface.resolve("mcp__docs__lookup")).toBeUndefined()
	})
})
