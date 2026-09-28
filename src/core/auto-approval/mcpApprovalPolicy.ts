import type { McpServerUse } from "@alpha-code/types"

export type McpToolApprovalDecision = "approve" | "ask"

function isMcpToolUse(value: unknown): value is McpServerUse & { type: "use_mcp_tool"; toolName: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false

	const use = value as Record<string, unknown>
	return (
		use.type === "use_mcp_tool" &&
		typeof use.serverName === "string" &&
		use.serverName.trim().length > 0 &&
		typeof use.toolName === "string" &&
		use.toolName.trim().length > 0 &&
		(use.source === undefined || use.source === "global" || use.source === "project")
	)
}

/**
 * Resolve MCP approval using Alpha's captured three-tier mode and an exact
 * user-configured grant. MCP annotations are untrusted hints shown with the
 * approval request; they do not authorize a call in Ask or Auto.
 */
export function getMcpToolApprovalDecision(
	mode: unknown,
	use: unknown,
	explicitlyAllowed: boolean,
): McpToolApprovalDecision {
	if (!isMcpToolUse(use)) return "ask"
	if (mode === "bypass") return "approve"
	// `undefined` is the persisted legacy-settings path; an explicit MCP grant
	// remains valid there when the legacy auto-approval surface is enabled.
	if (mode !== undefined && mode !== "ask" && mode !== "auto") return "ask"
	return explicitlyAllowed ? "approve" : "ask"
}
