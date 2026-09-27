import { describe, expect, it } from "vitest"

import { getNativeTools } from ".."

describe("MCP resource catalog", () => {
	it("offers the Codex resource names without the legacy access schema on a fresh turn", () => {
		const names = getNativeTools({ mcpResourcesAvailable: true }).flatMap((tool) =>
			tool.type === "function" ? [tool.function.name] : [],
		)
		expect(names).toEqual(
			expect.arrayContaining(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]),
		)
		expect(names).not.toContain("access_mcp_resource")
	})
})
