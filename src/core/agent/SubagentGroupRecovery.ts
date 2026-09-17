import type { SubagentGroupState, SubagentStopReason } from "@alpha-code/types"

const ACTIVE_STATUSES = new Set(["pending", "running", "cancelling"])

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

	group.status = neverLaunched ? "cancelled" : "interrupted"
	group.completedAt ??= completedAt
	return true
}
