import { discoverToolsParamsSchema, toolSearchParamsSchema } from "@alpha-code/types"

import { NativeToolCallParser } from "../NativeToolCallParser"
import { ALWAYS_AVAILABLE_TOOLS, TOOL_GROUPS } from "../../../shared/tools"

describe("NativeToolCallParser tool search", () => {
	it("parses fresh tool_search calls to the canonical name with its default", () => {
		const result = NativeToolCallParser.parseToolCall({
			id: "search-valid",
			name: "tool_search",
			arguments: JSON.stringify({ query: "  calendar events  " }),
		})

		expect(result).toMatchObject({ type: "tool_use", name: "tool_search" })
		if (result?.type === "tool_use") {
			expect(result.nativeArgs).toEqual(toolSearchParamsSchema.parse({ query: "calendar events" }))
			expect(result).not.toHaveProperty("originalName")
		}
	})

	it("accepts tool_search limits through Alpha's configured maximum", () => {
		const result = NativeToolCallParser.parseToolCall({
			id: "search-limited",
			name: "tool_search",
			arguments: JSON.stringify({ query: "calendar", limit: 32 }),
		})

		expect(result?.type).toBe("tool_use")
		if (result?.type === "tool_use") {
			expect(result.nativeArgs).toEqual({ query: "calendar", limit: 32 })
		}
	})

	it("parses saved discover_tools calls through the canonical descriptor and retains their wire name", () => {
		const result = NativeToolCallParser.parseToolCall({
			id: "legacy-discovery",
			name: "discover_tools",
			arguments: JSON.stringify({ query: "calendar", limit: 5 }),
		})

		expect(result).toMatchObject({
			type: "tool_use",
			name: "tool_search",
			originalName: "discover_tools",
		})
		if (result?.type === "tool_use") {
			expect(result.nativeArgs).toEqual(discoverToolsParamsSchema.parse({ query: "calendar", limit: 5 }))
		}
	})

	it("lists only canonical tool_search in the MCP group and makes it always available", () => {
		expect(TOOL_GROUPS.mcp.tools).toContain("tool_search")
		expect(TOOL_GROUPS.mcp.tools).not.toContain("discover_tools")
		expect(ALWAYS_AVAILABLE_TOOLS).toContain("tool_search")
		expect(ALWAYS_AVAILABLE_TOOLS).not.toContain("discover_tools")
	})

	it.each([
		{ query: "", limit: 8, label: "an empty query" },
		{ query: "calendar", limit: 33, label: "a limit above the maximum" },
		{ query: "calendar", limit: 1.5, label: "a fractional limit" },
		{ query: "calendar", limit: null, label: "a null limit" },
		{ query: "calendar", limit: 8, extra: true, label: "an unknown argument" },
	])("returns null for $label", (payload) => {
		const { label, ...args } = payload
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		const result = NativeToolCallParser.parseToolCall({
			id: `search-invalid-${label}`,
			name: "tool_search",
			arguments: JSON.stringify(args),
		})

		expect(result).toBeNull()
		errorSpy.mockRestore()
	})
})
