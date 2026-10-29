import type { ManagedWorkerArtifact } from "@alpha-code/core"
import type { AgentRecord, AlphaMessage, HistoryItem, SubagentGroupState } from "@alpha-code/types"

type WorkerArtifactIdentity = Pick<ManagedWorkerArtifact, "id" | "taskId" | "groupId" | "runId">

export interface WorkerArtifactRecoveryTarget {
	group: SubagentGroupState
	agent: SubagentGroupState["agents"][number]
	currentAttempt: boolean
	currentHistory: boolean
}

/** Recover an exact proposal or admitted attempt without reassigning an older artifact to a reused task ID. */
export function resolveWorkerArtifactRecoveryTarget(
	artifact: WorkerArtifactIdentity,
	childHistory: HistoryItem,
	record: AgentRecord | undefined,
	messages: readonly AlphaMessage[],
): WorkerArtifactRecoveryTarget | undefined {
	const candidates = messages.flatMap((message) => {
		const group = message.subagentGroup
		if (!group || group.parentTaskId !== childHistory.parentTaskId) return []
		return group.agents
			.filter((agent) => agent.taskId === artifact.taskId && agent.role === "worker")
			.map((agent) => ({ group, agent }))
	})
	const metadata = record?.snapshot?.metadata
	const currentAttempt =
		record?.taskId === artifact.taskId &&
		record.parentTaskId === childHistory.parentTaskId &&
		record.groupId === childHistory.subagentGroupId &&
		metadata?.workerArtifactId === artifact.id &&
		(artifact.runId === undefined || metadata.workerRunId === artifact.runId)
	const projected = candidates.filter(
		({ group, agent }) =>
			agent.changeSet?.id === artifact.id &&
			(artifact.groupId === undefined || group.groupId === artifact.groupId),
	)
	const retained = currentAttempt
		? candidates.filter(
				({ group }) =>
					group.groupId === childHistory.subagentGroupId &&
					(artifact.groupId === undefined || group.groupId === artifact.groupId),
			)
		: projected
	// Legacy artifacts remain readable through their original proposal reference.
	// An unprojected or ambiguous legacy artifact has no trustworthy attempt owner.
	if (retained.length !== 1) return undefined
	const target = retained[0]
	return {
		...target,
		currentAttempt,
		currentHistory:
			(currentAttempt ||
				(childHistory.subagentChangeSet?.id === artifact.id &&
					(metadata?.workerArtifactId === undefined || metadata.workerArtifactId === artifact.id))) &&
			(childHistory.subagentGroupId === undefined || childHistory.subagentGroupId === target.group.groupId),
	}
}
