import type { McpServer, McpServerUse } from "@alpha-code/types"

export type McpToolApprovalDecision = "approve" | "ask"

export interface McpToolApprovalGrant {
	serverName: string
	toolName: string
	source?: "global" | "project"
}

export interface McpApprovalPolicy {
	enabled: boolean
	grants: readonly McpToolApprovalGrant[]
}

function grantKey(grant: McpToolApprovalGrant): string {
	return JSON.stringify([grant.serverName, grant.source ?? null, grant.toolName])
}

/** Store only review authority, never MCP configuration, credentials, or mutable catalog objects. */
export function createMcpApprovalPolicySnapshot(policy?: McpApprovalPolicy): McpApprovalPolicy {
	const grants = new Map<string, McpToolApprovalGrant>()
	for (const grant of policy?.grants ?? []) {
		if (
			typeof grant.serverName !== "string" ||
			!grant.serverName.trim() ||
			typeof grant.toolName !== "string" ||
			!grant.toolName.trim() ||
			(grant.source !== undefined && grant.source !== "global" && grant.source !== "project")
		) {
			continue
		}
		grants.set(
			grantKey(grant),
			Object.freeze({
				serverName: grant.serverName,
				toolName: grant.toolName,
				...(grant.source === undefined ? {} : { source: grant.source }),
			}),
		)
	}
	return Object.freeze({
		enabled: policy?.enabled === true,
		grants: Object.freeze(
			[...grants.entries()]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([, grant]) => grant),
		),
	})
}

/** Preserve the existing exact-grant lookup, including legacy source-less server selection. */
export function captureMcpApprovalPolicy(enabled: boolean, mcpServers?: McpServer[]): McpApprovalPolicy {
	if (!enabled) return createMcpApprovalPolicySnapshot()
	const serversByName = new Map<string, McpServer[]>()
	for (const server of mcpServers ?? []) {
		const matching = serversByName.get(server.name) ?? []
		matching.push(server)
		serversByName.set(server.name, matching)
	}
	const grants: McpToolApprovalGrant[] = []
	for (const [serverName, servers] of serversByName) {
		const selected = new Map<McpServer["source"], McpServer>()
		for (const server of servers) {
			if (!selected.has(server.source)) {
				// Source-less requests select the first same-name server, even when a later legacy server exists.
				selected.set(server.source, server.source === undefined ? servers[0] : server)
			}
		}
		for (const server of new Set(selected.values())) {
			const seenTools = new Set<string>()
			for (const tool of server.tools ?? []) {
				const toolName = tool.name
				if (seenTools.has(toolName)) continue
				seenTools.add(toolName)
				if (tool.alwaysAllow) {
					grants.push({
						serverName,
						toolName,
						...(server.source === undefined ? {} : { source: server.source }),
					})
				}
			}
		}
	}
	return createMcpApprovalPolicySnapshot({ enabled: true, grants })
}

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
	capturedPolicy?: McpApprovalPolicy,
	resolvedGrant?: McpToolApprovalGrant,
): McpToolApprovalDecision {
	if (!isMcpToolUse(use)) return "ask"
	if (capturedPolicy && !capturedPolicy.enabled) return "ask"
	if (mode === "bypass") return "approve"
	// `undefined` is the persisted legacy-settings path; an explicit MCP grant
	// remains valid there when the legacy auto-approval surface is enabled.
	if (mode !== undefined && mode !== "ask" && mode !== "auto") return "ask"
	const capturedGrant =
		!capturedPolicy ||
		(resolvedGrant !== undefined &&
			capturedPolicy.grants.some((grant) => grantKey(grant) === grantKey(resolvedGrant)))
	return explicitlyAllowed && capturedGrant ? "approve" : "ask"
}
