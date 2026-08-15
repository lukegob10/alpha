import { describe, expect, it } from "vitest"

import { ToolRegistry } from "../ToolRegistry"

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
	it("registers the built-in tools with their provider schemas", () => {
		const registry = new ToolRegistry()

		expect(registry.resolve("read_file")?.schema).toMatchObject({
			type: "function",
			function: { name: "read_file" },
		})
		expect(registry.resolve("attempt_completion")?.capabilities.concurrency).toBe("barrier")
		expect(registry.resolve("list_files")?.capabilities.concurrency).toBe("parallel")
		expect(registry.resolve("execute_command")?.capabilities.concurrency).toBe("serial")
		expect(registry.resolve("spawn_agent")?.capabilities).toMatchObject({
			concurrency: "serial",
			sideEffects: "task",
			controlFlow: false,
		})
	})

	it("resolves aliases to the canonical descriptor", () => {
		const registry = new ToolRegistry()

		expect(registry.resolve("search_and_replace")?.name).toBe("edit")
		expect(registry.resolve("write_file")?.name).toBe("write_to_file")
		expect(registry.canonicalName("search_and_replace")).toBe("edit")
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
		expect(registry.resolve("mcp__filesystem__read_file")?.name).toBe("mcp--filesystem--read_file")
		expect(registry.getSchema("mcp--filesystem--read_file")).toMatchObject({
			function: { name: "mcp--filesystem--read_file" },
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
