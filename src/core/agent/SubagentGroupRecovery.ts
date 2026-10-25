import type { SubagentGroupState, SubagentGroupStatus, SubagentRunState, SubagentStopReason } from "@alpha-code/types"

const ACTIVE_STATUSES = new Set(["pending", "running", "cancelling"])

/** Resolve durable child outcomes using the same blocking and asynchronous group semantics as live finalization. */
export function aggregateSubagentGroupTerminalStatus(
	outcomes: readonly { status: SubagentRunState["status"] | "denied"; stopReason?: SubagentStopReason }[],
	executionMode: SubagentGroupState["executionMode"] = "blocking",
): Exclude<SubagentGroupStatus, "pending" | "running" | "cancelling"> {
	if (outcomes.some(({ status }) => ACTIVE_STATUSES.has(status))) {
		throw new Error("Cannot aggregate an active sub-agent group")
	}
	const statuses = outcomes.map(({ status, stopReason }) =>
		status === "failed" && stopReason === "authority_denied" ? "denied" : status,
	)
	if (executionMode === "async" && statuses.length === 1) {
		const status = statuses[0]
		if (status === "completed" || status === "cancelled" || status === "timed_out" || status === "interrupted") {
			return status
		}
		return status === "denied" ? "cancelled" : "failed"
	}
	const completed = statuses.filter((status) => status === "completed").length
	if (statuses.length > 0 && completed === statuses.length) return "completed"
	if (completed > 0) return "partial"
	if (statuses.length > 0 && statuses.every((status) => status === "cancelled")) return "cancelled"
	if (statuses.length > 0 && statuses.every((status) => status === "timed_out")) return "timed_out"
	return "failed"
}

const wasPreparedButNeverLaunched = (group: SubagentGroupState): boolean =>
	group.status === "pending" &&
	group.executionMode === undefined &&
	group.startedAt === undefined &&
	group.agents.every((agent) => agent.status === "pending" && agent.startedAt === undefined)

/**
 * Reconcile a persisted active group after reload once the caller has proven
 * that none of its unfinished children is still live.
 */
export const reconcileSubagentGroupAfterReload = (
	group: SubagentGroupState,
	completedAt: number,
	getStopReason: (taskId: string) => SubagentStopReason | undefined = () => undefined,
): boolean => {
	if (!ACTIVE_STATUSES.has(group.status)) return false

	const neverLaunched = wasPreparedButNeverLaunched(group)
	const hadUnfinishedChildren = group.agents.some((agent) => ACTIVE_STATUSES.has(agent.status))
	for (const agent of group.agents) {
		if (!ACTIVE_STATUSES.has(agent.status)) continue

		agent.status = neverLaunched ? "cancelled" : "interrupted"
		agent.stopReason = neverLaunched ? "never_launched" : (getStopReason(agent.taskId) ?? "interrupted")
		delete agent.phase
		delete agent.phaseStartedAt
		delete agent.pendingApproval
		agent.completedAt ??= completedAt
		agent.error ??= neverLaunched
			? "The prepared sub-agent was never launched before the extension reloaded. Start a new spawn request to retry."
			: "The extension reloaded before this sub-agent finished. The parent can resume it with followup_task."
		agent.usage.durationMs = Math.max(
			agent.usage.durationMs,
			completedAt - (agent.startedAt ?? group.startedAt ?? group.createdAt),
		)
	}

	// Child reports can be durable before the aggregate terminal status is written.
	group.status = neverLaunched
		? "cancelled"
		: hadUnfinishedChildren
			? "interrupted"
			: aggregateSubagentGroupTerminalStatus(group.agents, group.executionMode)
	group.completedAt ??= completedAt
	return true
}
