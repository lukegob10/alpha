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

function missingVerification(obligation: ParentVerificationObligation): string {
	if (obligation.mutationReservations?.length) return "an admitted mutation still needs its final content receipt"
	if (obligation.scopeUnresolved) return "mutation scope could not be observed; report an explicit unverified outcome"
	const missing = new Set<string>()
	for (const file of obligation.changedFiles) {
		const required = obligation.verificationRequirements?.[file] ?? []
		const passed = obligation.verifiedChecks?.[file] ?? []
		if (required.length === 0 && passed.length === 0) missing.add("a supported check covering the changed files")
		for (const kind of required) if (!passed.includes(kind)) missing.add(kind)
	}
	return [...missing].join(", ") || "current scoped evidence"
}

/** Compact durable facts for the existing environment snapshot and its delta delivery. */
export function formatParentVerificationContext(
	obligations: readonly ParentVerificationObligation[],
): string | undefined {
	const active = obligations.filter((item) => isBlockingParentVerificationStatus(item.status))
	if (active.length === 0) return undefined
	const entries = active
		.slice(0, 16)
		.map(
			(item) =>
				`${item.changeSetId} (version ${item.contentVersion ?? "legacy"}, ${item.status}): needs ${missingVerification(item)}; changed files: ${item.changedFiles.slice(0, 8).join(", ") || "receipt pending"}${item.changedFiles.length > 8 ? `, and ${item.changedFiles.length - 8} more` : ""}`,
		)
	return `Workspace verification is pending. Include the exact covered IDs in execute_command verification.change_set_ids. Passing checks count only for current content and supported scope.\n${entries.join("\n")}${active.length > 16 ? `\n${active.length - 16} additional change sets remain.` : ""}`
}

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
						? "Applied changes were verified."
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
		return `${worker}, change set ${item.changeSetId} (${item.changedFiles.length} file${item.changedFiles.length === 1 ? "" : "s"})${failure}; needs ${missingVerification(item)}`
	})
	const count = blockingObligations.length
	return {
		allowed: false,
		blockingObligations,
		message:
			`Cannot complete while ${count} applied change set${count === 1 ? "" : "s"} ` +
			`await${count === 1 ? "s" : ""} parent verification. ` +
			`Run a genuine verification command in the owning task and name each covered change set in verification.change_set_ids, then report the outcome. If validation is unavailable, report an explicit blocked or unverified outcome with the missing evidence. ` +
			`Needs attention: ${details.join("; ")}.`,
	}
}
