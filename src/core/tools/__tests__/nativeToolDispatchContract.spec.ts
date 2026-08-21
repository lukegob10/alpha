import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { getNativeTools } from "../../prompts/tools/native-tools"
import { ALWAYS_AVAILABLE_TOOLS, TOOL_GROUPS } from "../../../shared/tools"
import { ToolRegistry } from "../ToolRegistry"
import { isValidToolName } from "../validateToolUse"

const functionNames = () =>
	getNativeTools()
		.filter((tool) => tool.type === "function")
		.map((tool) => tool.function.name)

const lifecycleToolNames = [
	"list_agents",
	"wait_agent",
	"send_message",
	"report_progress",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
] as const

function productionDispatcherSource(): string {
	return fs.readFileSync(
		fileURLToPath(new URL("../../assistant-message/presentAssistantMessage.ts", import.meta.url)),
		"utf8",
	)
}

function directlyDispatchedToolNames(source: string): Set<string> {
	const switchStart = source.indexOf("switch (block.name)")
	const defaultStart = source.indexOf("default: {", switchStart)

	expect(switchStart).toBeGreaterThanOrEqual(0)
	expect(defaultStart).toBeGreaterThan(switchStart)

	const executionSwitch = source.slice(switchStart, defaultStart)
	return new Set(Array.from(executionSwitch.matchAll(/case\s+["']([^"']+)["']\s*:/g), (match) => match[1]))
}

describe("native tool production dispatch contract", () => {
	it("exposes only native tools with a production dispatcher and registry descriptor", () => {
		const exposedNames = functionNames()
		const dispatchNames = directlyDispatchedToolNames(productionDispatcherSource())
		const registry = new ToolRegistry()

		expect(exposedNames).toContain("delegate_task")
		expect(exposedNames).toContain("spawn_agent")
		expect(exposedNames).toEqual(expect.arrayContaining([...lifecycleToolNames]))
		expect(exposedNames.filter((name) => !dispatchNames.has(name))).toEqual([])
		expect(exposedNames.filter((name) => !registry.has(name))).toEqual([])
		expect(registry.has("delegate_task")).toBe(true)
		expect(registry.has("spawn_agent")).toBe(true)
		for (const name of lifecycleToolNames) expect(registry.has(name)).toBe(true)
		expect(directlyDispatchedToolNames(productionDispatcherSource())).toContain("delegate_task")
		expect(directlyDispatchedToolNames(productionDispatcherSource())).toContain("spawn_agent")
		for (const name of lifecycleToolNames) {
			expect(directlyDispatchedToolNames(productionDispatcherSource())).toContain(name)
		}
		expect(isValidToolName("delegate_task")).toBe(true)
		expect(isValidToolName("spawn_agent")).toBe(true)
		for (const name of lifecycleToolNames) expect(isValidToolName(name)).toBe(true)
		expect(ALWAYS_AVAILABLE_TOOLS).not.toContain("delegate_task")
		expect(ALWAYS_AVAILABLE_TOOLS).not.toContain("spawn_agent")
		for (const name of lifecycleToolNames) expect(ALWAYS_AVAILABLE_TOOLS).not.toContain(name)
		expect(Object.values(TOOL_GROUPS).flatMap((group) => group.tools)).toContain("delegate_task")
		expect(Object.values(TOOL_GROUPS).flatMap((group) => group.tools)).toContain("spawn_agent")
		for (const name of lifecycleToolNames) {
			expect(Object.values(TOOL_GROUPS).flatMap((group) => group.tools)).toContain(name)
		}
	})

	it("retains explicit production boundaries for dynamic MCP and custom tools", () => {
		const source = productionDispatcherSource()

		expect(source).toContain('case "mcp_tool_use"')
		expect(source).toContain("customToolRegistry.get(block.name)")
	})
})
