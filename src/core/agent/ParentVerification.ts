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

export const isBlockingParentVerificationStatus = (status: ParentVerificationStatus): boolean =>
	status === "pending" || status === "failed"

/** Primary receipts describe effects; inferred verifier coverage is not an execution/completion policy. */
export function isBlockingParentVerification(obligation: ParentVerificationObligation): boolean {
	if (obligation.origin === "primary") {
		return Boolean(obligation.scopeUnresolved || obligation.mutationReservations?.length)
	}
	return isBlockingParentVerificationStatus(obligation.status)
}

function requiresVerificationProjection(obligation: ParentVerificationObligation): boolean {
	return obligation.origin !== "primary" || isBlockingParentVerification(obligation)
}

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
	const active = obligations.filter(isBlockingParentVerification)
	if (active.length === 0) return undefined
	const entries = active
		.slice(0, 16)
		.map((item) =>
			item.origin === "primary"
				? `Primary operation: ${missingVerification(item)}.`
				: `${item.changeSetId} (version ${item.contentVersion ?? "legacy"}, ${item.status}): needs ${missingVerification(item)}; changed files: ${item.changedFiles.slice(0, 8).join(", ") || "receipt pending"}${item.changedFiles.length > 8 ? `, and ${item.changedFiles.length - 8} more` : ""}`,
		)
	const guidance = active.some((item) => item.origin !== "primary")
		? "Worker verification is pending. Include the exact covered IDs in execute_command verification.change_set_ids. Passing checks count only for current content and supported scope."
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
			STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] || right.updatedAt - left.updatedAt,
	)
	const representative = ordered[0]
	const blocking = obligations.some(isBlockingParentVerification)
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
			`await${count === 1 ? "s" : ""} parent verification. ` +
			(blockingObligations.some((item) => item.scopeUnresolved)
				? "Validation is unavailable because the mutation scope could not be captured. Report the completed work and this missing evidence as an explicit blocked/unverified outcome. "
				: blockingObligations.some((item) => item.mutationReservations?.length)
					? "An admitted mutation still needs its durable content receipt. Let the runtime settle that receipt before selecting another verification command. "
					: "Run the missing supported checks in the owning task for the current content version and include the exact covered IDs in verification.change_set_ids. Reuse accepted checks; if validation is unavailable, report an explicit blocked/unverified outcome with the missing evidence. ") +
			`Needs attention: ${details.join("; ")}.`,
	}
}
