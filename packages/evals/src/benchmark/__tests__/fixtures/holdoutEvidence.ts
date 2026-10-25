import { aggregateHoldoutTrials, type HoldoutConfirmation } from "../../holdout"

export function holdoutEvidence() {
	const confirmation: HoldoutConfirmation = {
		schemaVersion: 1,
		suiteId: "frontier-v1",
		suiteVersion: 1,
		policyVersion: 1,
		receipts: Array.from({ length: 12 }, (_, index) => ({
			trialId: `trial-${index}`,
			taskId: `holdout-${String(index + 1).padStart(3, "0")}`,
			taskVersion: 1,
			family: "mixed",
			difficulty: "frontier",
			graderDecision: "passed",
			evidenceDigest: `sha256:${String(index).padStart(64, "0")}`,
			durationMs: 10,
			costUsd: 0.1,
		})),
	}
	const aggregate = aggregateHoldoutTrials(
		confirmation.receipts.map((receipt) => ({
			...receipt,
			passed: receipt.graderDecision === "passed",
			safetyFailed: receipt.graderDecision === "safety_failed",
		})),
	)
	return { confirmation, aggregate }
}
