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
import type { ToolReviewPolicy } from "../agent/ToolPolicy"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools"
import { getMcpToolApprovalGrant } from "./mcp"
import { captureMcpApprovalPolicy, getMcpToolApprovalDecision } from "./mcpApprovalPolicy"
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

/** Capture optional review grants before request preparation can observe later global changes. */
export function captureToolReviewPolicy(
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>,
): ToolReviewPolicy {
	const mode = resolveApprovalMode(state)
	const flags = state ? flagsFromState(state, mode) : undefined
	const enabled = flags?.autoApprovalEnabled === true
	return Object.freeze({
		protectedWriteAllowed: enabled && flags?.alwaysAllowWriteProtected === true,
		mcp: captureMcpApprovalPolicy(enabled && flags?.alwaysAllowMcp === true, state?.mcpServers),
	})
}

/** Shared by question timers and the captured choice of blocking question tools. */
export function getFollowupAutoApprovalTimeoutMs(
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>,
): number {
	if (!state) return 0
	const flags = flagsFromState(state, resolveApprovalMode(state))
	const timeout = state.followupAutoApproveTimeoutMs
	return flags.autoApprovalEnabled &&
		flags.alwaysAllowFollowupQuestions &&
		typeof timeout === "number" &&
		Number.isFinite(timeout) &&
		timeout > 0 &&
		timeout <= 2_147_483_647
		? timeout
		: 0
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
	/** Optional only for legacy callers without an admitted model step. */
	reviewPolicy?: ToolReviewPolicy
	/** Invoking step's immutable command ceiling; live settings may only narrow this boundary. */
	commandPolicy?: {
		allowedPrefixes: readonly string[]
		deniedPrefixes: readonly string[]
	}
	ask: AlphaAsk
	text?: string
	isProtected?: boolean
	/** Trusted execution-boundary requirement; settings cannot turn this into automatic approval. */
	requiresExplicitApproval?: boolean
}

function parseToolApprovalMetadata(text: string | undefined): AlphaSayTool | undefined {
	let tool: AlphaSayTool
	try {
		tool = JSON.parse(text || "{}")
	} catch {
		return undefined
	}
	if (!tool || typeof tool !== "object" || Array.isArray(tool) || typeof tool.tool !== "string") return undefined
	// Malformed metadata must not crash preflight or silently drop its workspace boundary.
	if (
		(tool.isOutsideWorkspace !== undefined && typeof tool.isOutsideWorkspace !== "boolean") ||
		(tool.batchFiles !== undefined &&
			(!Array.isArray(tool.batchFiles) ||
				tool.batchFiles.some(
					(file) =>
						!file ||
						typeof file !== "object" ||
						Array.isArray(file) ||
						(file.isOutsideWorkspace !== undefined && typeof file.isOutsideWorkspace !== "boolean"),
				)))
	) {
		return undefined
	}
	return tool
}

export async function checkAutoApproval({
	state,
	commandPolicy,
	reviewPolicy,
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
				// Zero keeps answers user-owned even in Full Access. Timed defaults are Alpha's
				// explicit alternative to Codex Plan's blocking request_user_input (retrieved 2026-10-26).
				const timeout = getFollowupAutoApprovalTimeoutMs(state)

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
				const resolvedGrant = getMcpToolApprovalGrant(mcpServerUse, state.mcpServers)
				const explicitMcpGrant = flags.alwaysAllowMcp && resolvedGrant !== undefined
				return {
					decision: getMcpToolApprovalDecision(
						mode,
						mcpServerUse,
						explicitMcpGrant,
						reviewPolicy?.mcp,
						resolvedGrant,
					),
				}
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return flags.alwaysAllowMcp && (!reviewPolicy || reviewPolicy.mcp.enabled)
					? { decision: "approve" }
					: { decision: "ask" }
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

		const decisions = [
			getCommandDecision(
				text,
				effectiveCommandAllowlist(mode, state.allowedCommands || []),
				state.deniedCommands || [],
			),
		]
		if (commandPolicy) {
			decisions.push(
				getCommandDecision(
					text,
					effectiveCommandAllowlist(mode, [...commandPolicy.allowedPrefixes]),
					commandPolicy.deniedPrefixes,
				),
			)
		}
		if (decisions.includes("auto_deny")) {
			return { decision: "deny" }
		}
		if (
			isProtected &&
			(!flags.alwaysAllowWriteProtected || (reviewPolicy && !reviewPolicy.protectedWriteAllowed))
		) {
			return { decision: "ask" }
		}
		const decision = decisions.every((decision) => decision === "auto_approve") ? "auto_approve" : "ask_user"
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
		const tool = parseToolApprovalMetadata(text)
		if (!tool) return { decision: "ask" }

		const toolName: string = tool.tool
		if (toolName === "delegateTask" || toolName === "spawnAgent") {
			return !requiresExplicitApproval && flags.alwaysAllowSubagents
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (requiresExplicitApproval && mode !== "bypass") return { decision: "ask" }
		if (toolName === "create_thread" || toolName === "fork_thread") {
			return mode === "auto" || mode === "bypass" ? { decision: "approve" } : { decision: "ask" }
		}
		if (toolName === "create_task") {
			const workspaceMode = (tool as { workspaceMode?: unknown }).workspaceMode
			if (workspaceMode !== "shared" && workspaceMode !== "worktree") return { decision: "ask" }
			return (mode === "auto" && workspaceMode === "shared") || mode === "bypass"
				? { decision: "approve" }
				: { decision: "ask" }
		}
		if (
			toolName === "send_task_message" ||
			toolName === "steer_task" ||
			toolName === "stop_task" ||
			toolName === "send_message_to_thread" ||
			toolName === "set_thread_title" ||
			toolName === "set_thread_archived"
		) {
			return mode === "auto" || mode === "bypass" ? { decision: "approve" } : { decision: "ask" }
		}

		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		if (tool.tool === "ticket") {
			const activity = tool.ticketActivity
			// TicketStore binds these operations to the current project even though its files live under the user profile.
			return flags.alwaysAllowTickets &&
				activity?.state === "pending" &&
				(activity.operation === "create" || activity.operation === "update" || activity.operation === "delete")
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
			if (isProtected && reviewPolicy && !reviewPolicy.protectedWriteAllowed) {
				return { decision: "ask" }
			}
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
 * Ask at either boundary requires review. Auto must pass both live and captured
 * action checks; only Full Access skips per-action review, while explicit command
 * denials remain authoritative.
 */
export async function checkAutoApprovalWithInheritedPolicy({
	inheritedState,
	...input
}: CheckAutoApprovalInput & {
	inheritedState?: SubagentAutoApprovalPolicy
}): Promise<CheckAutoApprovalResult> {
	if (!inheritedState) return checkAutoApproval(input)
	if (isNonBlockingAsk(input.ask)) return { decision: "approve" }
	if (input.ask === "tool" && !parseToolApprovalMetadata(input.text)) return { decision: "ask" }
	const inheritedMode = inferApprovalModeFromPolicy(inheritedState)
	const checkInheritedPolicy = async (): Promise<CheckAutoApprovalResult> => {
		if (input.ask === "use_mcp_server") {
			return checkAutoApproval({
				...input,
				state: { ...input.state, ...inheritedState, approvalMode: inheritedMode },
				reviewPolicy: {
					protectedWriteAllowed: inheritedState.alwaysAllowWriteProtected,
					mcp: inheritedState.mcpApproval ?? { enabled: false, grants: [] },
				},
			})
		}
		if (input.ask !== "command") return checkAutoApproval({ ...input, state: inheritedState })
		if (!input.text) return { decision: "ask" }
		const decisions = [inheritedState.commandApproval, ...(inheritedState.commandApprovalCeilings ?? [])].map(
			(policy) => getSubagentCommandDecision(input.text!, policy),
		)
		if (decisions.some((decision) => decision === "auto_deny")) return { decision: "deny" }
		if (input.isProtected && !inheritedState.alwaysAllowWriteProtected) return { decision: "ask" }
		if (!inheritedState.autoApprovalEnabled || !inheritedState.alwaysAllowExecute) return { decision: "ask" }
		if (input.requiresExplicitApproval && inheritedMode !== "bypass") return { decision: "ask" }
		if (decisions.every((decision) => decision === "auto_approve")) return { decision: "approve" }
		return { decision: "ask" }
	}

	const [liveResult, inheritedResult] = await Promise.all([checkAutoApproval(input), checkInheritedPolicy()])
	const results = [liveResult, inheritedResult]

	if (results.some(({ decision }) => decision === "deny")) return { decision: "deny" }
	const liveMode = input.state ? migrateApprovalMode(input.state) : "ask"
	if (liveMode === "ask" || inheritedMode === "ask") return { decision: "ask" }
	if (liveMode === "bypass" && inheritedMode === "bypass") {
		if (input.ask === "use_mcp_server" && inheritedResult.decision !== "approve") return { decision: "ask" }
		if (
			input.reviewPolicy &&
			(input.ask === "use_mcp_server" || (input.ask === "tool" && input.isProtected)) &&
			liveResult.decision !== "approve"
		) {
			return { decision: "ask" }
		}
		// Full Access can skip per-action review only when both the live and captured
		// grants authorize it. Auto still applies each action's narrower policy.
		if (input.ask === "command") {
			if (
				!input.text ||
				liveResult.decision !== "approve" ||
				(input.isProtected && inheritedResult.decision !== "approve")
			)
				return { decision: "ask" }
			const capturedDenials = [
				inheritedState.commandApproval,
				...(inheritedState.commandApprovalCeilings ?? []),
			].map((policy) => getSubagentCommandDecision(input.text!, { ...policy, allowAll: true }))
			// Bypassing an allowlist miss cannot bypass an opaque or unresolved deny ceiling.
			if (capturedDenials.some((decision) => decision !== "auto_approve")) {
				return { decision: "ask" }
			}
		}
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
