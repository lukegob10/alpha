import { isApprovalMode, type ApprovalMode } from "@alpha-code/types"

import type { ToolPolicySnapshot } from "../agent/ToolPolicy"

export const APPROVAL_CONTEXT_ORIGIN = "approval-context" as const

export interface ApprovalContextInstructionPart {
	role: "developer"
	origin: typeof APPROVAL_CONTEXT_ORIGIN
	content: string
}

const APPROVAL_MODE_INSTRUCTIONS: Record<ApprovalMode, string> = {
	ask: `The current approval mode is Ask. Wait for the user's decision whenever the host requests approval for an action. A tool may proceed without a prompt only when the host's captured policy permits it. A denial, cancellation, or missing approval is not authorization; stop that action or choose a safe alternative.`,
	auto: `The current approval mode is Auto. The host may automatically approve actions covered by the captured auto-approval rules. Follow the available tool schemas, command rules, and any approval request returned by the host. Actions that require explicit approval still wait for the user; a denial or cancellation is not authorization.`,
	bypass: `The current approval mode is Bypass. The host may skip ordinary approval requests covered by the captured Bypass rules. Host-enforced denials, unavailable tools, and forced or explicit approval requirements remain authoritative. Follow any approval request returned by the host, and do not claim an action is approved before the host permits it.`,
}

function resolveCapturedApprovalMode(policy?: Pick<ToolPolicySnapshot, "approval">): ApprovalMode {
	const mode: unknown = policy?.approval.mode
	return isApprovalMode(mode) ? mode : "ask"
}

/** Build the prompt fragment from the immutable mode captured at the turn boundary. */
export function buildApprovalContextInstructionPartForMode(capturedMode: ApprovalMode): ApprovalContextInstructionPart {
	const mode: unknown = capturedMode
	const effectiveMode = isApprovalMode(mode) ? mode : "ask"
	return Object.freeze({
		role: "developer",
		origin: APPROVAL_CONTEXT_ORIGIN,
		content: APPROVAL_MODE_INSTRUCTIONS[effectiveMode],
	})
}

/**
 * Render approval guidance only from the immutable step policy. Legacy snapshots
 * without a captured mode conservatively use Ask.
 */
export function buildApprovalContextInstructionPart(
	policy?: Pick<ToolPolicySnapshot, "approval">,
): ApprovalContextInstructionPart {
	return buildApprovalContextInstructionPartForMode(resolveCapturedApprovalMode(policy))
}
