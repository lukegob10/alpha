import type { ParentVerificationObligation } from "@alpha-code/types"
import type { Task } from "../task/Task"

/** Diagnostic projection only: never refresh, settle, or disclose workspace contents while reporting a failure. */
export function settlementDiagnostics(task: Task, obligations: readonly ParentVerificationObligation[]) {
	const allCommands = task.getCommandExecutionEvidence()
	const commands = allCommands.slice(-32)
	return {
		taskId: task.taskId,
		instanceId: task.instanceId,
		completion: task.getCompletionStageMetrics(),
		commands: commands.map(({ toolCallId, executionId, status, startedAt, completedAt, exitCode }) => ({
			toolCallId,
			executionId,
			status,
			startedAt,
			completedAt,
			exitCode,
		})),
		obligations: obligations.slice(-16).map((item) => ({
			changeSetId: item.changeSetId,
			origin: item.origin,
			contentVersion: item.contentVersion,
			fileCount: item.changedFiles.length,
			status: item.status,
			scopeUnresolved: item.scopeUnresolved === true,
			observationIncomplete: item.observationIncomplete === true,
			updatedAt: item.updatedAt,
			pendingReservations: (item.mutationReservations ?? []).slice(-32).map((token) => ({
				token,
				commandStatus: commands.find((command) => command.executionId === token)?.status,
			})),
		})),
		truncated:
			obligations.length > 16 ||
			allCommands.length > 32 ||
			obligations.some((item) => (item.mutationReservations?.length ?? 0) > 32),
	}
}
