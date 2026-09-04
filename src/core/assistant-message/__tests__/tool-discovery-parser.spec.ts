import { discoverToolsParamsSchema } from "@alpha-code/types"

import { NativeToolCallParser } from "../NativeToolCallParser"
import { ALWAYS_AVAILABLE_TOOLS, TOOL_GROUPS } from "../../../shared/tools"

describe("NativeToolCallParser discover_tools", () => {
	it("uses the shared argument schema and applies its default", () => {
		const result = NativeToolCallParser.parseToolCall({
			id: "discover-valid",
			name: "discover_tools",
			arguments: JSON.stringify({ query: "  calendar events  " }),
		})

		expect(result?.type).toBe("tool_use")
		if (result?.type === "tool_use") {
			expect(result.nativeArgs).toEqual(discoverToolsParamsSchema.parse({ query: "calendar events" }))
		}
	})

	it("preserves an explicit bounded limit", () => {
		const result = NativeToolCallParser.parseToolCall({
			id: "discover-limited",
			name: "discover_tools",
			arguments: JSON.stringify({ query: "calendar", limit: 5 }),
		})

		expect(result?.type).toBe("tool_use")
		if (result?.type === "tool_use") {
			expect(result.nativeArgs).toEqual({ query: "calendar", limit: 5 })
		}
	})

	it("registers discover_tools only under the MCP group", () => {
		expect(TOOL_GROUPS.mcp.tools).toContain("discover_tools")
		expect(ALWAYS_AVAILABLE_TOOLS).not.toContain("discover_tools")
	})

	it.each([
		{ query: "", limit: 3, label: "an empty query" },
		{ query: "calendar", limit: 6, label: "a limit above the maximum" },
		{ query: "calendar", limit: 1.5, label: "a fractional limit" },
		{ query: "calendar", limit: null, label: "a null limit" },
		{ query: "calendar", limit: 3, extra: true, label: "an unknown argument" },
	])("returns null for $label", (payload) => {
		const { label, ...args } = payload
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		const result = NativeToolCallParser.parseToolCall({
			id: `discover-invalid-${label}`,
			name: "discover_tools",
			arguments: JSON.stringify(args),
		})

		expect(result).toBeNull()
		errorSpy.mockRestore()
	})
})
