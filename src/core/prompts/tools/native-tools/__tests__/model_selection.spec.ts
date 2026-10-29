import { describe, expect, it } from "vitest"
import { getNativeTools } from "../index"
import { NativeToolCallParser } from "../../../../assistant-message/NativeToolCallParser"
import { getToolCapabilities, ToolRegistry } from "../../../../tools/ToolRegistry"
import { isToolAllowedForMode } from "../../../../tools/validateToolUse"

describe("saved profile discovery in model selection tools", () => {
	it("directs subagents and independent chats to fresh discovery and stable profile IDs", () => {
		const tools = getNativeTools({
			crossTaskRole: "root",
			includeCreateThreadSchema: true,
			includeForkThreadSchema: true,
		})
		for (const name of ["spawn_agent", "create_thread", "fork_thread", "send_message_to_thread"]) {
			const tool = tools.find((tool) => tool.type === "function" && tool.function.name === name)
			expect(tool?.type).toBe("function")
			if (tool?.type !== "function") throw new Error(`Missing ${name}`)
			const properties = tool.function.parameters?.properties as Record<string, { description: string }>
			expect(properties.profile.description).toContain("list_provider_profiles")
			expect(properties.profile.description).toContain("returned ID")
			expect(properties.profile.description).toContain("Omit model")
			expect(properties.model.description).toContain("profile names are not model IDs")
		}
	})

	it("exposes discovery eagerly as a read-only Code and Plan tool without approval", () => {
		const registry = new ToolRegistry()
		expect(registry.resolve("list_provider_profiles")).toBeDefined()
		expect(registry.resolve("list_provider_profiles")?.exposure).not.toBe("deferred")
		expect(getToolCapabilities("list_provider_profiles")).toEqual({
			concurrency: "serial",
			sideEffects: "none",
			controlFlow: false,
			requiresApproval: false,
		})
		for (const mode of ["code", "architect"]) {
			expect(isToolAllowedForMode("list_provider_profiles", mode, [])).toBe(true)
		}
	})

	it.each([{}, { query: "Research", cursor: null }])("parses bounded discovery arguments %j", (input) => {
		const parsed = NativeToolCallParser.parseToolCall({
			id: "profiles",
			name: "list_provider_profiles",
			arguments: JSON.stringify(input),
		})
		expect(parsed?.type).toBe("tool_use")
		if (parsed?.type !== "tool_use") throw new Error("Discovery call was not parsed")
		expect(parsed.nativeArgs).toEqual(input)
	})

	it("rejects credential fields at the discovery input boundary", () => {
		expect(
			NativeToolCallParser.parseToolCall({
				id: "profiles",
				name: "list_provider_profiles",
				arguments: JSON.stringify({ apiKey: "must-not-be-accepted" }),
			}),
		).toBeNull()
	})
})
