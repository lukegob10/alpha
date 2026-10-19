import type { AgentResponse, AgentToolCall } from "./AgentResponse"
import type { ToolSchedulerOutcome } from "./ToolScheduler"

export interface CommittedReadonlyRecoveryDispatch {
	/** Only dispatches admitted by the host's audited early read lane belong here. */
	call: AgentToolCall
	outcome?: Pick<ToolSchedulerOutcome, "status" | "results" | "failure">
	resultCommitStarted?: boolean
	error?: unknown
	/** The original call has a paired result in committed provider history. */
	receiptPersisted: boolean
}

export interface CommittedHistoryToolRecoveryInput {
	response: AgentResponse
	toolIntentObserved: boolean
	reservedToolCalls: readonly AgentToolCall[]
	earlyReadDispatches: readonly CommittedReadonlyRecoveryDispatch[]
}

function sameCall(left: AgentToolCall, right: AgentToolCall): boolean {
	return (
		left.id === right.id &&
		left.name === right.name &&
		JSON.stringify(left.arguments) === JSON.stringify(right.arguments)
	)
}

/**
 * Admit a new model step from committed history, never replay an interrupted tool batch.
 * The caller retains ownership, cancellation, provider-error, durability and retry-budget guards.
 * A receipt synthesized for an unexecuted or indeterminate call is insufficient: every call
 * must match an already settled audited read and its original persisted result.
 */
export function canContinueFromCommittedHistoryTools(input: CommittedHistoryToolRecoveryInput): boolean {
	const { response, toolIntentObserved, reservedToolCalls, earlyReadDispatches } = input
	if (
		response.items.some(
			(item) => item.type === "error" && (item.callId !== undefined || item.toolName !== undefined),
		)
	) {
		return false
	}
	if (response.toolCalls.length === 0) {
		return !toolIntentObserved && reservedToolCalls.length === 0 && earlyReadDispatches.length === 0
	}
	if (
		response.toolCalls.length !== reservedToolCalls.length ||
		response.toolCalls.length !== earlyReadDispatches.length ||
		new Set(response.toolCalls.map((call) => call.id)).size !== response.toolCalls.length
	) {
		return false
	}
	return response.toolCalls.every((call, index) => {
		const reserved = reservedToolCalls[index]!
		const dispatch = earlyReadDispatches[index]!
		const outcome = dispatch.outcome
		const result = outcome?.results[0]
		return (
			call.id.length > 0 &&
			sameCall(call, reserved) &&
			sameCall(call, dispatch.call) &&
			dispatch.resultCommitStarted === true &&
			dispatch.receiptPersisted &&
			dispatch.error === undefined &&
			outcome?.status === "completed" &&
			!outcome.failure &&
			outcome.results.length === 1 &&
			result !== undefined &&
			result.callId === call.id &&
			result.name === call.name &&
			(result.status === "success" || result.status === "error") &&
			result.executionStatus !== "running" &&
			result.executionStatus !== "cancelled" &&
			result.executionStatus !== "denied" &&
			result.failure?.outcome !== "unknown"
		)
	})
}
