/**
 * Pure policy helpers for bounded context recovery.
 *
 * The task loop owns when recovery is attempted.  Keeping the arithmetic here
 * makes it possible for callers that cannot yet be changed to still use the
 * same target and progress rules without introducing another retry loop.
 */

/** A bounded recovery operation's terminal state. */
export type ContextRecoveryStatus = "reduced" | "no_progress" | "exhausted"

/** The default minimum reduction required from a compaction attempt. */
export const DEFAULT_MIN_REDUCTION_PERCENT = 10

/** The target percentage of usable context after reserving response tokens. */
export const DEFAULT_COMPACTION_TARGET_PERCENT = 75

export type CompactionTargetOptions = {
	contextWindow: number
	/** Preferred name for the output reservation. */
	reservedTokens?: number
	/** Backward-friendly spelling used by context-management callers. */
	maxTokens?: number
	targetPercent?: number
}

/**
 * Returns the context available for input after reserving response tokens.
 * Invalid/negative values are treated conservatively as zero available input.
 */
export function getUsableContextTokens(contextWindow: number, reservedTokens: number): number {
	const window = Number.isFinite(contextWindow) ? Math.max(0, contextWindow) : 0
	const reserved = Number.isFinite(reservedTokens) ? Math.max(0, reservedTokens) : 0
	return Math.max(0, window - reserved)
}

/**
 * Returns the desired post-compaction input budget.
 *
 * The default is 75% of the usable context (context window minus output
 * reservation), rather than 75% of the raw model window.
 */
export function getCompactionTargetTokens({
	contextWindow,
	reservedTokens,
	maxTokens,
	targetPercent = DEFAULT_COMPACTION_TARGET_PERCENT,
}: CompactionTargetOptions): number {
	const normalizedPercent = Number.isFinite(targetPercent) ? Math.max(0, targetPercent) : 0
	const outputReservation = reservedTokens ?? maxTokens ?? 0
	return Math.floor((getUsableContextTokens(contextWindow, outputReservation) * normalizedPercent) / 100)
}

/** Alias for callers that describe the result as a target context budget. */
export const getTargetContextTokens = getCompactionTargetTokens

/** Returns the percentage reduction from `beforeTokens` to `afterTokens`. */
export function calculateReductionPercent(beforeTokens: number, afterTokens: number): number {
	const before = Number.isFinite(beforeTokens) ? Math.max(0, beforeTokens) : 0
	const after = Number.isFinite(afterTokens) ? Math.max(0, afterTokens) : before
	if (before === 0) {
		return after === 0 ? 0 : -Infinity
	}
	return ((before - after) / before) * 100
}

export type CompactionProgressOptions = {
	/** Input token count before compaction. */
	beforeTokens: number
	/** Input token count after compaction. Omit when the caller cannot measure it. */
	afterTokens?: number | null
	/** Desired post-compaction input budget. */
	targetTokens?: number | null
	/** Minimum reduction when the input starts above the target. */
	minReductionPercent?: number
}

export type CompactionProgress = {
	status: ContextRecoveryStatus
	beforeTokens: number
	afterTokens?: number
	reductionTokens: number
	reductionPercent: number
	targetTokens?: number
	targetReached: boolean
	alreadyUnderTarget: boolean
}

/**
 * Classifies one compaction result without scheduling a retry.
 *
 * A result is successful when it makes the default (10%) measurable reduction.
 * If the input was already under target, no reduction is required.  Reaching
 * the target is reported separately but does not waive the progress guard when
 * the input started above target.  Missing/invalid measurements are
 * deliberately classified as `no_progress` so a caller cannot silently accept
 * an unchanged request.
 */
export function evaluateCompactionProgress({
	beforeTokens,
	afterTokens,
	targetTokens,
	minReductionPercent = DEFAULT_MIN_REDUCTION_PERCENT,
}: CompactionProgressOptions): CompactionProgress {
	const before = Number.isFinite(beforeTokens) ? Math.max(0, beforeTokens) : 0
	const hasAfter = afterTokens !== null && afterTokens !== undefined && Number.isFinite(afterTokens)
	const after = hasAfter ? Math.max(0, afterTokens as number) : undefined
	const target =
		targetTokens === null || targetTokens === undefined || !Number.isFinite(targetTokens)
			? undefined
			: Math.max(0, targetTokens)
	const alreadyUnderTarget = target === undefined ? false : before <= target
	const targetReached = after !== undefined && target !== undefined && after <= target
	const reductionTokens = after === undefined ? 0 : Math.max(0, before - after)
	const reductionPercent = after === undefined ? 0 : calculateReductionPercent(before, after)
	const requiredReduction = Number.isFinite(minReductionPercent)
		? Math.max(0, minReductionPercent)
		: DEFAULT_MIN_REDUCTION_PERCENT
	const hasMinimumReduction = after !== undefined && reductionPercent >= requiredReduction

	return {
		status: alreadyUnderTarget || hasMinimumReduction ? "reduced" : "no_progress",
		beforeTokens: before,
		afterTokens: after,
		reductionTokens,
		reductionPercent,
		targetTokens: target,
		targetReached,
		alreadyUnderTarget,
	}
}

/** Convenience predicate for callers that only need the reduction decision. */
export function hasMeasurableReduction(
	beforeTokens: number,
	afterTokens: number | null | undefined,
	minReductionPercent = DEFAULT_MIN_REDUCTION_PERCENT,
): boolean {
	return evaluateCompactionProgress({ beforeTokens, afterTokens, minReductionPercent }).status === "reduced"
}

/** Alias that reads naturally at call sites enforcing the compaction policy. */
export const isMeasurableReduction = hasMeasurableReduction

/** Returns whether a measured request is at or below its target budget. */
export function isWithinCompactionTarget(tokens: number | null | undefined, targetTokens: number): boolean {
	return tokens !== null && tokens !== undefined && Number.isFinite(tokens) && tokens <= targetTokens
}
