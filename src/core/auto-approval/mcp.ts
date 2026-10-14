import type { McpServerUse, McpServer, McpTool } from "@alpha-code/types"

export function isMcpToolAlwaysAllowed(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): boolean {
	if (mcpServerUse.type === "use_mcp_tool" && mcpServerUse.toolName) {
		const matchingServers = mcpServers?.filter((server) => server.name === mcpServerUse.serverName) ?? []
		const server =
			mcpServerUse.source === undefined
				? matchingServers[0]
				: (matchingServers.find((candidate) => candidate.source === mcpServerUse.source) ??
					(matchingServers.length === 1 && matchingServers[0].source === undefined
						? matchingServers[0]
						: undefined))
		const tool = server?.tools?.find((t: McpTool) => t.name === mcpServerUse.toolName)
		return tool?.alwaysAllow || false
	}

	return false
}
