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
	activeDescendantCount?: number
	unconsumedResultCount?: number
}

export const parentVerificationObligationId = (changeSetId: string): string => `worker-change:${changeSetId}`

const isPrimaryObligation = (obligation: ParentVerificationObligation): boolean => obligation.origin === "primary"

/**
 * Review and effect settlement are completion gates. An approved Worker change
 * may have missing or failed optional process evidence without blocking the
 * parent; malformed applied records still fail closed.
 */
export function isBlockingParentVerification(obligation: ParentVerificationObligation): boolean {
	if (obligation.scopeUnresolved || obligation.mutationReservations?.length) return true
	if (isPrimaryObligation(obligation)) return false
	if (
		obligation.status === "required" ||
		obligation.status === "superseded" ||
		obligation.status === "not_applicable"
	)
		return false
	return obligation.review?.decision !== "approved" || obligation.appliedAt === undefined
}

function requiresVerificationProjection(obligation: ParentVerificationObligation): boolean {
	return !isPrimaryObligation(obligation) || isBlockingParentVerification(obligation)
}

function missingVerification(obligation: ParentVerificationObligation): string {
	if (obligation.mutationReservations?.length) return "an admitted mutation still needs its final content receipt"
	if (obligation.scopeUnresolved) return "mutation scope could not be observed; report an explicit unverified outcome"
	if (!isPrimaryObligation(obligation)) {
		const missing: string[] = []
		if (obligation.review?.decision !== "approved") missing.push("an approved review decision")
		if (obligation.appliedAt === undefined) missing.push("a durable applied effect receipt")
		return missing.join(" and ") || "the parent-owned change-set ledger"
	}
	return "the parent-owned workspace receipt"
}

/** Compact durable facts for the existing environment snapshot and its delta delivery. */
export function formatParentVerificationContext(
	obligations: readonly ParentVerificationObligation[],
): string | undefined {
	const active = obligations.filter(isBlockingParentVerification)
	if (active.length === 0) return undefined
	const entries = active
		.slice(0, 16)
		.map((item) =>
			isPrimaryObligation(item)
				? `Primary operation: ${missingVerification(item)}.`
				: `${item.changeSetId} (version ${item.contentVersion ?? "legacy"}, ${item.status}): needs ${missingVerification(item)}; changed files: ${item.changedFiles.slice(0, 8).join(", ") || "receipt pending"}${item.changedFiles.length > 8 ? `, and ${item.changedFiles.length - 8} more` : ""}`,
		)
	const guidance = active.some((item) => !isPrimaryObligation(item))
		? "Applied Worker records have unresolved review or effect settlement. Resolve the parent-owned ledger state before completing."
		: "Workspace operations remain unresolved. Let admitted operations settle; report interrupted or unknown outcomes explicitly."
	return `${guidance}\n${entries.join("\n")}${active.length > 16 ? `\n${active.length - 16} additional change sets remain.` : ""}`
}

export function summarizeParentVerification(
	obligations: readonly ParentVerificationObligation[],
): ParentVerificationSummary | undefined {
	obligations = obligations.filter(requiresVerificationProjection)
	if (obligations.length === 0) return undefined

	const ordered = [...obligations].sort(
		(left, right) =>
			Number(isBlockingParentVerification(right)) - Number(isBlockingParentVerification(left)) ||
			STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
			right.updatedAt - left.updatedAt,
	)
	const representative = ordered[0]
	const blocking = obligations.some(isBlockingParentVerification)
	const unresolvedCount = obligations.filter(
		(item) => item.status === "required" || isBlockingParentVerification(item),
	).length
	const message = blocking
		? `The change set "${representative.changeSetId}" needs ${missingVerification(representative)}.`
		: parentEvidenceMessage(representative)

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

function parentEvidenceMessage(obligation: ParentVerificationObligation): string {
	switch (obligation.status) {
		case "failed":
			return `Optional command evidence failed for "${obligation.changeSetId}"; completion remains available.`
		case "pending":
			return `Optional command evidence is incomplete for "${obligation.changeSetId}"; completion remains available.`
		case "required":
			return "Worker changes are quarantined for review."
		case "satisfied":
			return obligation.verification?.assurance === "process"
				? "An associated process completed successfully against the captured content; test coverage is not established."
				: "Legacy command evidence satisfies the persisted advisory checks."
		case "superseded":
			return "The quarantined proposal was superseded."
		case "not_applicable":
			return "Parent verification is not applicable."
	}
}

export function decideParentCompletion(obligations: readonly ParentVerificationObligation[]): ParentCompletionDecision {
	const blockingObligations = obligations
		.filter(isBlockingParentVerification)
		.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
		.map((item) => structuredClone(item))
	if (blockingObligations.length === 0) return { allowed: true, blockingObligations: [] }

	const details = blockingObligations.map((item) => {
		const worker = item.workerPath ? `${item.workerNickname} (${item.workerPath})` : item.workerNickname
		const failure = item.status === "failed" ? "; the latest scoped verification command failed" : ""
		return `${worker}, change set ${item.changeSetId}, content version ${item.contentVersion ?? "legacy"} (${item.changedFiles.length} file${item.changedFiles.length === 1 ? "" : "s"})${failure}; needs ${missingVerification(item)}`
	})
	const count = blockingObligations.length
	return {
		allowed: false,
		blockingObligations,
		message:
			`Cannot complete while ${count} applied change set${count === 1 ? "" : "s"} ` +
			`await${count === 1 ? "s" : ""} review or effect settlement. ` +
			(blockingObligations.some((item) => item.scopeUnresolved)
				? "Validation is unavailable because the mutation scope could not be captured. Report the completed work and this missing evidence as an explicit blocked/unverified outcome. "
				: blockingObligations.some((item) => item.mutationReservations?.length)
					? "An admitted mutation still needs its durable content receipt. Let the runtime settle that receipt before completing. "
					: blockingObligations.some((item) => !isPrimaryObligation(item))
						? "An applied Worker record lacks an approved review or durable effect receipt. Resolve that ledger state before completing. "
						: "Resolve the parent-owned workspace receipt before completing. ") +
			`Needs attention: ${details.join("; ")}.`,
	}
}
