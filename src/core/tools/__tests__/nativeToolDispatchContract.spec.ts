import { describe, expect, it } from "vitest"

import { getNativeTools } from "../../prompts/tools/native-tools"
import { ALWAYS_AVAILABLE_TOOLS, TOOL_GROUPS } from "../../../shared/tools"
import { ToolRegistry } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"
import { isValidToolName } from "../validateToolUse"

const lifecycleToolNames = [
	"delegate_task",
	"spawn_agent",
	"list_agents",
	"wait_agent",
	"send_message",
	"report_progress",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
] as const

describe("native tool production dispatch contract", () => {
	it("exposes native schemas through the captured executable registry", () => {
		const schemas = getNativeTools()
		const surface = createTaskToolSurface({
			registry: new ToolRegistry({ nativeTools: schemas }),
			schemas,
			mode: "code",
		})
		const exposedNames = schemas.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(exposedNames).toEqual(expect.arrayContaining([...lifecycleToolNames]))
		for (const name of exposedNames) {
			expect(surface.isCallable(name), name).toBe(true)
			expect(surface.resolve(name)?.execute, name).toBeTypeOf("function")
		}
		for (const name of lifecycleToolNames) {
			expect(isValidToolName(name), name).toBe(true)
			expect(ALWAYS_AVAILABLE_TOOLS).not.toContain(name)
			expect(Object.values(TOOL_GROUPS).flatMap((group) => group.tools)).toContain(name)
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
