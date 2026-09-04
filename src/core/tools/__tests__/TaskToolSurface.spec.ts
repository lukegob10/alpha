import { describe, expect, it } from "vitest"

import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry, type ToolDescriptor } from "../ToolRegistry"

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

function descriptor(name: string, capabilities: ToolDescriptor["capabilities"]): ToolDescriptor {
	return {
		name,
		aliases: [],
		schema: schema(name),
		capabilities,
		execute: async () => {},
	}
}

const readCapabilities = {
	concurrency: "serial" as const,
	sideEffects: "none" as const,
	controlFlow: false,
	requiresApproval: false,
}
const writeCapabilities = {
	concurrency: "serial" as const,
	sideEffects: "workspace" as const,
	controlFlow: false,
	requiresApproval: true,
}

function registry() {
	const result = new ToolRegistry({ includeBuiltIns: false })
	result.register(descriptor("read_file", readCapabilities))
	result.register(descriptor("write_to_file", writeCapabilities))
	return result
}

describe("TaskToolSurface", () => {
	it("keeps an explicitly empty projection empty even when the sealed registry has descriptors", () => {
		const source = registry()
		const surface = createTaskToolSurface({ registry: source, schemas: [] })
		expect(source.has("read_file")).toBe(true)
		expect(source.isSealed()).toBe(true)
		expect(surface.schemas).toEqual([])
		expect(surface.allowedFunctionNames).toEqual([])
		expect(surface.isCallable("read_file")).toBe(false)
		expect(surface.resolve("read_file")).toBeUndefined()
	})

	it("keeps visible schemas and executable descriptors in one canonical namespace", () => {
		const surface = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file"), schema("write_file"), schema("write_to_file")],
			allowedToolNames: ["read_file", "write_file"],
			disabledTools: ["write_file"],
			mode: "code",
		})

		expect(surface.schemas.map((tool) => tool.type === "function" && tool.function.name)).toEqual(["read_file"])
		expect(surface.allowedFunctionNames).toEqual(["read_file"])
		expect(surface.resolve("read_file")?.name).toBe("read_file")
		expect(surface.resolve("write_file")).toBeUndefined()
		expect(surface.isCallable("write_file")).toBe(false)
		expect(surface.policy.disabledTools).toEqual(["write_to_file"])
	})

	it.each([
		["work", ["read_file", "write_to_file"]],
		["plan", ["read_file"]],
	] as const)("applies the %s profile once to callable names", (profile, expected) => {
		const surface = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file"), schema("write_to_file")],
			allowedToolNames: ["read_file", "write_to_file"],
			profile,
		})

		expect(surface.allowedFunctionNames).toEqual(expected)
		expect(surface.schemas.map((tool) => tool.type === "function" && tool.function.name)).toEqual(expected)
	})

	it("retains a provider schema superset while failing closed for disallowed calls", () => {
		const surface = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file"), schema("write_to_file")],
			allowedToolNames: ["read_file"],
			includeAllToolsWithRestrictions: true,
		})

		expect(surface.schemas.map((tool) => tool.type === "function" && tool.function.name)).toEqual([
			"read_file",
			"write_to_file",
		])
		expect(surface.allowedFunctionNames).toEqual(["read_file"])
		expect(surface.registry.resolve("write_to_file")).toBeDefined()
		expect(surface.resolve("write_to_file")).toBeUndefined()
		expect(surface.policy.visibleTools).toEqual(["read_file", "write_to_file"])
	})

	it("computes policy and surface digests instead of trusting caller values", () => {
		const input = {
			visibleTools: ["read_file"],
			allowedTools: ["read_file"],
			digest: "caller-controlled",
		}
		const firstPolicy = createToolPolicySnapshot(input)
		const secondPolicy = createToolPolicySnapshot({ ...input, digest: "a-different-value" })

		expect(firstPolicy.digest).not.toBe("caller-controlled")
		expect(firstPolicy.digest).toBe(secondPolicy.digest)

		const first = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file")],
			policy: firstPolicy,
		})
		const second = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file")],
			policy: secondPolicy,
		})
		expect(first.digest).toBe(second.digest)
	})

	it("normalizes dynamic MCP names while preserving one descriptor", () => {
		const mcpRegistry = new ToolRegistry({
			nativeTools: [],
			mcpTools: [schema("mcp--filesystem--read_file")],
		})
		const surface = createTaskToolSurface({
			registry: mcpRegistry,
			schemas: [schema("mcp__filesystem__read_file")],
		})

		expect(surface.schemas).toHaveLength(1)
		expect(surface.schemas[0]).toMatchObject({ function: { name: "mcp--filesystem--read_file" } })
		expect(surface.registry.resolve("mcp__filesystem__read_file")?.name).toBe("mcp--filesystem--read_file")
		expect(surface.isCallable("mcp__filesystem__read_file")).toBe(true)
	})
})
