import { toolNames, type CustomToolDefinition } from "@alpha-code/types"
import type OpenAI from "openai"

import { TOOL_ALIASES } from "../../shared/tools"

type CatalogCustomTool = { definition: CustomToolDefinition; schema: OpenAI.Chat.ChatCompletionTool }

const reservedNames = new Set<string>([...toolNames, ...Object.keys(TOOL_ALIASES)])

/** External definitions cannot claim a built-in name, alias, or MCP namespace. */
export function availableCustomTools<T extends CatalogCustomTool>(tools: readonly T[]): T[] {
	return tools.filter(({ definition }) => {
		const name = definition.name
		return !reservedNames.has(name) && !name.startsWith("mcp--") && !name.startsWith("mcp__")
	})
}
