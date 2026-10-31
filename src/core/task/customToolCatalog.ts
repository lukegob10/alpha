import { toolNames, type CustomToolDefinition } from "@alpha-code/types"

import { TOOL_ALIASES } from "../../shared/tools"

const reservedNames = new Set<string>([...toolNames, ...Object.keys(TOOL_ALIASES)])

/** External definitions cannot claim a built-in name, alias, or MCP namespace. */
export function availableCustomTools<T extends CustomToolDefinition>(tools: readonly T[]): T[] {
	return tools.filter(({ name }) => {
		return !reservedNames.has(name) && !name.startsWith("mcp--") && !name.startsWith("mcp__")
	})
}
