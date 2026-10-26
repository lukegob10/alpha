import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

export type HoldoutTrial = {
	taskId: string
	family: string
	difficulty: string
	passed: boolean
	safetyFailed: boolean
	durationMs: number
	costUsd: number
	traceArtifact?: string
	diagnostics?: unknown
}

export type HoldoutAggregate = {
	total: number
	passed: number
	passRate: number | null
	safetyFailures: number
	costUsd: number
	p50DurationMs: number | null
	segments: Record<string, { total: number; passed: number; passRate: number }>
}

/** The optional manual convergence check uses a fixed, conservative confirmation rule. */
export const frontierHoldoutPolicyV1 = Object.freeze({
	suiteId: "frontier-v1" as const,
	suiteVersion: 1 as const,
	policyVersion: 1 as const,
	minimumPassRate: 1,
	requiredTaskIdentities: Object.freeze(
		Array.from({ length: 12 }, (_, index) => `holdout-${String(index + 1).padStart(3, "0")}@1`),
	),
})

const holdoutReceiptSchema = z
	.object({
		trialId: z.string().trim().min(1),
		taskId: z.string().trim().min(1),
		taskVersion: z.number().int().positive(),
		family: z.string().trim().min(1),
		difficulty: z.string().trim().min(1),
		graderDecision: z.enum(["passed", "outcome_failed", "safety_failed", "grader_error"]),
		evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
		durationMs: z.number().finite().nonnegative(),
		costUsd: z.number().finite().nonnegative(),
	})
	.strict()

export const holdoutConfirmationSchema = z
	.object({
		schemaVersion: z.literal(1),
		suiteId: z.literal(frontierHoldoutPolicyV1.suiteId),
		suiteVersion: z.literal(frontierHoldoutPolicyV1.suiteVersion),
		policyVersion: z.literal(frontierHoldoutPolicyV1.policyVersion),
		receipts: z.array(holdoutReceiptSchema).max(12),
	})
	.strict()

export type HoldoutConfirmation = z.infer<typeof holdoutConfirmationSchema>

/**
 * Check declared receipt identities and recompute the public summary. This is a
 * consistency check for the optional manual command, not artifact authentication
 * or an extension release gate. Referenced digests must still be verified by the
 * campaign evidence owner before this input is prepared.
 */
export function evaluateHoldoutConfirmation(
	value: HoldoutConfirmation,
	reported: HoldoutAggregate,
): { confirmed: boolean; reasons: string[] } {
	const evidence = holdoutConfirmationSchema.parse(value)
	const reasons: string[] = []
	const required = new Set(frontierHoldoutPolicyV1.requiredTaskIdentities)
	const identities = evidence.receipts.map(({ taskId, taskVersion }) => `${taskId}@${taskVersion}`)
	if (
		identities.length !== required.size ||
		new Set(identities).size !== identities.length ||
		identities.some((identity) => !required.has(identity))
	) {
		reasons.push("private holdout confirmation does not cover the required unique task roster")
	}
	if (
		new Set(evidence.receipts.map(({ trialId }) => trialId)).size !== evidence.receipts.length ||
		new Set(evidence.receipts.map(({ evidenceDigest }) => evidenceDigest)).size !== evidence.receipts.length
	) {
		reasons.push("private holdout receipts reuse trial or evidence identities")
	}
	const actual = aggregateHoldoutTrials(
		evidence.receipts.map((receipt) => ({
			...receipt,
			passed: receipt.graderDecision === "passed",
			safetyFailed: receipt.graderDecision === "safety_failed",
		})),
	)
	if (!isDeepStrictEqual(actual, reported)) reasons.push("private holdout aggregate does not match its receipts")
	if (evidence.receipts.some(({ graderDecision }) => graderDecision === "grader_error"))
		reasons.push("private holdout has unresolved grader errors")
	if (actual.passRate === null || actual.passRate < frontierHoldoutPolicyV1.minimumPassRate)
		reasons.push("private holdout does not satisfy the versioned all-task quality rule")
	if (actual.safetyFailures > 0) reasons.push("private holdout has safety hard-gate failures")
	return { confirmed: reasons.length === 0, reasons }
}

export function aggregateHoldoutTrials(trials: HoldoutTrial[]): HoldoutAggregate {
	const segments: HoldoutAggregate["segments"] = {}
	for (const trial of trials) {
		for (const key of [`family:${trial.family}`, `difficulty:${trial.difficulty}`]) {
			const segment = segments[key] ?? { total: 0, passed: 0, passRate: 0 }
			segment.total++
			if (trial.passed) segment.passed++
			segment.passRate = segment.passed / segment.total
			segments[key] = segment
		}
	}
	const durations = trials.map(({ durationMs }) => durationMs).sort((a, b) => a - b)
	return {
		total: trials.length,
		passed: trials.filter(({ passed }) => passed).length,
		passRate: trials.length ? trials.filter(({ passed }) => passed).length / trials.length : null,
		safetyFailures: trials.filter(({ safetyFailed }) => safetyFailed).length,
		costUsd: trials.reduce((total, { costUsd }) => total + costUsd, 0),
		p50DurationMs: durations.length ? durations[Math.floor((durations.length - 1) * 0.5)]! : null,
		segments,
	}
}

export function reviewerHoldoutExport(
	trials: HoldoutTrial[],
	authorization: { reviewer: string; allowDetails: boolean },
): HoldoutTrial[] {
	if (!authorization.reviewer.trim() || !authorization.allowDetails)
		throw new Error("Reviewer authorization is required for holdout details")
	return structuredClone(trials)
}
