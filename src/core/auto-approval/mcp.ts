import type { McpServerUse, McpServer, McpTool } from "@alpha-code/types"
import type { McpToolApprovalGrant } from "./mcpApprovalPolicy"

/** Resolve the exact configured grant before comparing it with the invoking step's ceiling. */
export function getMcpToolApprovalGrant(
	mcpServerUse: McpServerUse,
	mcpServers: McpServer[] | undefined,
): McpToolApprovalGrant | undefined {
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
		if (server && tool?.alwaysAllow) {
			return {
				serverName: server.name,
				toolName: tool.name,
				...(server.source === undefined ? {} : { source: server.source }),
			}
		}
	}

	return undefined
}

export function isMcpToolAlwaysAllowed(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): boolean {
	return getMcpToolApprovalGrant(mcpServerUse, mcpServers) !== undefined
}
