import {
	type AlphaAsk,
	type AlphaSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	type SubagentAutoApprovalPolicy,
	type ApprovalMode,
	deriveAutoApprovalFlags,
	effectiveCommandAllowlistForMode,
	inferApprovalModeFromPolicy,
	isApprovalMode,
	isNonBlockingAsk,
	migrateApprovalMode,
} from "@alpha-code/types"

import { AlphaAskResponse } from "../../shared/WebviewMessage"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools"
import { isMcpToolAlwaysAllowed } from "./mcp"
import { getCommandDecision, getSubagentCommandDecision } from "./commands"

// We have auto-approval actions for different categories.
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowTickets"
	| "alwaysAllowMcp"
	| "alwaysAllowSubtasks"
	| "alwaysAllowSubagents"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"

// Some of these actions have additional settings associated with them.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "approvalMode"
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "followupAutoApproveTimeoutMs" // For `alwaysAllowFollowupQuestions`.
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"

function resolveApprovalMode(
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>,
): ApprovalMode | undefined {
	return state && isApprovalMode(state.approvalMode) ? state.approvalMode : undefined
}

function flagsFromState(
	state: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>,
	mode: ApprovalMode | undefined,
) {
	if (mode) {
		return deriveAutoApprovalFlags(mode, {
			alwaysAllowWriteProtected: state.alwaysAllowWriteProtected === true,
			alwaysAllowMcp: state.alwaysAllowMcp === true,
		})
	}
	return {
		autoApprovalEnabled: state.autoApprovalEnabled === true,
		alwaysAllowReadOnly: state.alwaysAllowReadOnly === true,
		alwaysAllowReadOnlyOutsideWorkspace: state.alwaysAllowReadOnlyOutsideWorkspace === true,
		alwaysAllowWrite: state.alwaysAllowWrite === true,
		alwaysAllowWriteOutsideWorkspace: state.alwaysAllowWriteOutsideWorkspace === true,
		alwaysAllowWriteProtected: state.alwaysAllowWriteProtected === true,
		alwaysAllowTickets: state.alwaysAllowTickets === true,
		alwaysAllowMcp: state.alwaysAllowMcp === true,
		alwaysAllowSubtasks: state.alwaysAllowSubtasks === true,
		alwaysAllowSubagents: state.alwaysAllowSubagents === true,
		alwaysAllowExecute: state.alwaysAllowExecute === true,
		alwaysAllowFollowupQuestions: state.alwaysAllowFollowupQuestions === true,
	}
}

function effectiveCommandAllowlist(mode: ApprovalMode | undefined, allowedCommands: string[]): string[] {
	return mode ? effectiveCommandAllowlistForMode(mode, allowedCommands) : allowedCommands
}

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	| { decision: "deny" }
	| { decision: "ask" }
	| {
			decision: "timeout"
			timeout: number
			fn: () => { askResponse: AlphaAskResponse; text?: string; images?: string[] }
	  }

export interface CheckAutoApprovalInput {
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	ask: AlphaAsk
	text?: string
	isProtected?: boolean
	/** Trusted execution-boundary requirement; settings cannot turn this into automatic approval. */
	requiresExplicitApproval?: boolean
}

export async function checkAutoApproval({
	state,
	ask,
	text,
	isProtected,
	requiresExplicitApproval,
}: CheckAutoApprovalInput): Promise<CheckAutoApprovalResult> {
	if (isNonBlockingAsk(ask)) {
		return { decision: "approve" }
	}

	if (!state) {
		return { decision: "ask" }
	}

	const mode = resolveApprovalMode(state)
	const flags = flagsFromState(state, mode)
	if (!mode && !flags.autoApprovalEnabled) {
		return { decision: "ask" }
	}

	if (ask === "followup") {
		if (flags.alwaysAllowFollowupQuestions) {
			try {
				const suggestion = (JSON.parse(text || "{}") as FollowUpData).suggest?.[0]
				const timeout =
					typeof state.followupAutoApproveTimeoutMs === "number" && state.followupAutoApproveTimeoutMs > 0
						? state.followupAutoApproveTimeoutMs
						: mode === "bypass"
							? 1
							: 0

				if (suggestion && timeout > 0) {
					return {
						decision: "timeout",
						timeout,
						fn: () => ({ askResponse: "messageResponse", text: suggestion.answer }),
					}
				}
				return { decision: "ask" }
			} catch {
				return { decision: "ask" }
			}
		}
		return { decision: "ask" }
	}

	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}

		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse

			if (mcpServerUse.type === "use_mcp_tool") {
				return mode === "bypass" ||
					(flags.alwaysAllowMcp && isMcpToolAlwaysAllowed(mcpServerUse, state.mcpServers))
					? { decision: "approve" }
					: { decision: "ask" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return flags.alwaysAllowMcp ? { decision: "approve" } : { decision: "ask" }
			}
		} catch {
			return { decision: "ask" }
		}

		return { decision: "ask" }
	}

	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}

		const decision = getCommandDecision(
			text,
			effectiveCommandAllowlist(mode, state.allowedCommands || []),
			state.deniedCommands || [],
		)
		if (decision === "auto_deny") {
			return { decision: "deny" }
		}
		if (mode === "ask") {
			return decision === "auto_approve" &&
				(state.allowedCommands || []).some((command) => command.trim() !== "*") &&
				!requiresExplicitApproval
				? { decision: "approve" }
				: { decision: "ask" }
		}
		if (mode === "auto") {
			return decision === "auto_approve" && !requiresExplicitApproval
				? { decision: "approve" }
				: { decision: "ask" }
		}
		if (mode === "bypass") {
			return decision === "auto_approve" ? { decision: "approve" } : { decision: "ask" }
		}
		return flags.alwaysAllowExecute && decision === "auto_approve" && !requiresExplicitApproval
			? { decision: "approve" }
			: { decision: "ask" }
	}

	if (ask === "tool") {
		let tool: AlphaSayTool | undefined

		try {
			tool = JSON.parse(text || "{}")
		} catch (error) {
			console.error("Failed to parse tool:", error)
		}

		if (!tool) {
			return { decision: "ask" }
		}

		const toolName: string = tool.tool
		if (toolName === "delegateTask" || toolName === "spawnAgent") {
			return !requiresExplicitApproval && flags.alwaysAllowSubagents
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (requiresExplicitApproval && mode !== "bypass") return { decision: "ask" }

		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		if (tool.tool === "ticket") {
			const activity = tool.ticketActivity
			return flags.alwaysAllowTickets &&
				activity?.state === "pending" &&
				(activity.operation === "create" || activity.operation === "update")
				? { decision: "approve" }
				: { decision: "ask" }
		}

		// The skill tool only loads pre-defined instructions from global or project skills.
		if (tool.tool === "skill") {
			return { decision: "approve" }
		}

		if (tool?.tool === "switchMode") {
			return { decision: "deny" }
		}

		if (["newTask", "finishTask"].includes(tool?.tool)) {
			return { decision: "approve" }
		}

		const isOutsideWorkspace =
			!!tool.isOutsideWorkspace ||
			(Array.isArray(tool.batchFiles) && tool.batchFiles.some((file) => file.isOutsideWorkspace))

		if (isReadOnlyToolAction(tool)) {
			return flags.alwaysAllowReadOnly && (!isOutsideWorkspace || flags.alwaysAllowReadOnlyOutsideWorkspace)
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (isWriteToolAction(tool)) {
			if (isOutsideWorkspace) {
				return mode === "bypass" ? { decision: "approve" } : { decision: "ask" }
			}
			return flags.alwaysAllowWrite && (!isProtected || flags.alwaysAllowWriteProtected)
				? { decision: "approve" }
				: { decision: "ask" }
		}
	}

	return { decision: "ask" }
}

/**
 * Apply the live and captured approval modes to managed-child actions.
 * Ask at either boundary requires review; Auto and Bypass skip per-action
 * review while explicit command denials remain authoritative.
 */
export async function checkAutoApprovalWithInheritedPolicy({
	inheritedState,
	...input
}: CheckAutoApprovalInput & {
	inheritedState?: SubagentAutoApprovalPolicy
}): Promise<CheckAutoApprovalResult> {
	if (!inheritedState) return checkAutoApproval(input)
	const checkInheritedPolicy = async (): Promise<CheckAutoApprovalResult> => {
		if (input.ask !== "command") return checkAutoApproval({ ...input, state: inheritedState })
		if (!inheritedState.autoApprovalEnabled || !inheritedState.alwaysAllowExecute || !input.text) {
			return { decision: "ask" }
		}
		const decisions = [inheritedState.commandApproval, ...(inheritedState.commandApprovalCeilings ?? [])].map(
			(policy) => getSubagentCommandDecision(input.text!, policy),
		)
		if (decisions.some((decision) => decision === "auto_deny")) return { decision: "deny" }
		if (decisions.every((decision) => decision === "auto_approve")) return { decision: "approve" }
		return { decision: "ask" }
	}

	const [liveResult, inheritedResult] = await Promise.all([checkAutoApproval(input), checkInheritedPolicy()])
	const results = [liveResult, inheritedResult]

	if (results.some(({ decision }) => decision === "deny")) return { decision: "deny" }
	const isSubagentAction = input.ask === "tool" || input.ask === "command"
	const liveMode = input.state ? migrateApprovalMode(input.state) : "ask"
	const inheritedMode = inferApprovalModeFromPolicy(inheritedState)
	if (isSubagentAction && liveMode !== "ask" && inheritedMode !== "ask") {
		// Auto and Full Access authorize the child action without asking the user.
		// Keep explicit command denials above this check; hard tool and path policy
		// is enforced before Task.ask and is unaffected by approval routing.
		return { decision: "approve" }
	}
	if (results.some(({ decision }) => decision === "ask")) return { decision: "ask" }

	const timeouts = results.filter(
		(result): result is Extract<CheckAutoApprovalResult, { decision: "timeout" }> => result.decision === "timeout",
	)
	if (timeouts.length > 0) {
		return timeouts.reduce((longest, current) => (current.timeout > longest.timeout ? current : longest))
	}

	return { decision: "approve" }
}

export { AutoApprovalHandler } from "./AutoApprovalHandler"
