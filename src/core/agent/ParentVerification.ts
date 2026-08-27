import type {
	ParentVerificationObligation,
	ParentVerificationStatus,
	ParentVerificationSummary,
} from "@alpha-code/types"

const STATUS_PRIORITY: Record<ParentVerificationStatus, number> = {
	failed: 0,
	pending: 1,
	required: 2,
	satisfied: 3,
	superseded: 4,
	not_applicable: 5,
}

export interface ParentCompletionDecision {
	allowed: boolean
	blockingObligations: ParentVerificationObligation[]
	message?: string
}

export const parentVerificationObligationId = (changeSetId: string): string => `worker-change:${changeSetId}`

export const isBlockingParentVerificationStatus = (status: ParentVerificationStatus): boolean =>
	status === "pending" || status === "failed"

export function summarizeParentVerification(
	obligations: readonly ParentVerificationObligation[],
): ParentVerificationSummary | undefined {
	if (obligations.length === 0) return undefined

	const ordered = [...obligations].sort(
		(left, right) =>
			STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] || right.updatedAt - left.updatedAt,
	)
	const representative = ordered[0]
	const blocking = obligations.some((item) => isBlockingParentVerificationStatus(item.status))
	const unresolvedCount = obligations.filter((item) => ["required", "pending", "failed"].includes(item.status)).length
	const message =
		representative.status === "failed"
			? `Parent verification failed; rerun execute_command with verification.change_set_ids including "${representative.changeSetId}".`
			: representative.status === "pending"
				? `Applied changes need a passing execute_command scoped to change set "${representative.changeSetId}".`
				: representative.status === "required"
					? "Worker changes are quarantined for review."
					: representative.status === "satisfied"
						? "Applied Worker changes were reviewed and verified."
						: representative.status === "superseded"
							? "The quarantined proposal was superseded."
							: "Parent verification is not applicable."

	return {
		status: representative.status,
		blocking,
		obligationCount: obligations.length,
		unresolvedCount,
		changeSetId: representative.changeSetId,
		updatedAt: Math.max(...obligations.map((item) => item.updatedAt)),
		message,
	}
}

export function decideParentCompletion(obligations: readonly ParentVerificationObligation[]): ParentCompletionDecision {
	const blockingObligations = obligations
		.filter((item) => isBlockingParentVerificationStatus(item.status))
		.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
		.map((item) => structuredClone(item))
	if (blockingObligations.length === 0) return { allowed: true, blockingObligations: [] }

	const details = blockingObligations.map((item) => {
		const worker = item.workerPath ? `${item.workerNickname} (${item.workerPath})` : item.workerNickname
		const failure = item.status === "failed" ? "; the latest scoped verification command failed" : ""
		return `${worker}, change set ${item.changeSetId} (${item.changedFiles.length} file${item.changedFiles.length === 1 ? "" : "s"})${failure}`
	})
	const count = blockingObligations.length
	return {
		allowed: false,
		blockingObligations,
		message:
			`Cannot complete while ${count} applied Worker change set${count === 1 ? "" : "s"} ` +
			`await${count === 1 ? "s" : ""} parent verification. ` +
			`Run a genuine verification command in the parent task and name each covered change set in verification.change_set_ids, then retry attempt_completion. ` +
			`Needs attention: ${details.join("; ")}.`,
	}
}
