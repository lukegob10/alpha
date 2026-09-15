/**
 * Pure policy helpers for bounded context recovery.
 *
 * The task loop owns when recovery is attempted.  Keeping the arithmetic here
 * makes it possible for callers that cannot yet be changed to still use the
 * same target and progress rules without introducing another retry loop.
 */

/** A bounded recovery operation's terminal state. */
export type ContextRecoveryStatus = "reduced" | "unchanged" | "no_progress" | "exhausted"

/** The default minimum reduction required from a compaction attempt. */
export const DEFAULT_MIN_REDUCTION_PERCENT = 10

/** Keep a quarter of the working budget after accounting for mandatory input. */
export const DEFAULT_COMPACTION_TARGET_PERCENT = 25
export const TOKEN_BUFFER_PERCENTAGE = 0.1
export const MIN_CONDENSE_THRESHOLD = 5
export const MAX_CONDENSE_THRESHOLD = 100

/** Global and per-profile percentages use the same validation and raw-window denominator. */
export function resolveCondenseThreshold(
	globalThreshold: number,
	profileThresholds: Record<string, number> = {},
	currentProfileId = "",
): number {
	const valid = (value: number) =>
		Number.isFinite(value) && value >= MIN_CONDENSE_THRESHOLD && value <= MAX_CONDENSE_THRESHOLD
	const profile = profileThresholds[currentProfileId]
	return valid(profile) ? profile : valid(globalThreshold) ? globalThreshold : MAX_CONDENSE_THRESHOLD
}

/** The configured trigger cannot exceed the input limit with its safety margin. */
export function getContextLimits(contextWindow: number, reservedTokens: number, thresholdPercent = 100) {
	const window = Number.isFinite(contextWindow) ? Math.max(0, contextWindow) : 0
	const usableTokens = getUsableContextTokens(window, reservedTokens)
	const allowedTokens = Math.max(0, Math.floor(usableTokens - window * TOKEN_BUFFER_PERCENTAGE))
	const triggerTokens = Math.min(
		allowedTokens,
		Math.floor((window * resolveCondenseThreshold(thresholdPercent)) / 100),
	)
	return { allowedTokens, triggerTokens }
}

export type CompactionTargetOptions = {
	contextWindow: number
	/** Preferred name for the output reservation. */
	reservedTokens?: number
	/** Backward-friendly spelling used by context-management callers. */
	maxTokens?: number
	targetPercent?: number
	/** The effective automatic trigger, including the user's profile threshold. */
	triggerTokens?: number
	/** System instructions and tool schemas cannot be summarized away. */
	fixedTokens?: number
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
 * Allocate the compactable portion relative to the effective trigger, not the
 * advertised model capacity. Mandatory input is charged before that allocation.
 */
export function getCompactionTargetTokens({
	contextWindow,
	reservedTokens,
	maxTokens,
	targetPercent = DEFAULT_COMPACTION_TARGET_PERCENT,
	triggerTokens,
	fixedTokens = 0,
}: CompactionTargetOptions): number {
	const normalizedPercent = Number.isFinite(targetPercent) ? Math.min(100, Math.max(0, targetPercent)) : 0
	const outputReservation = reservedTokens ?? maxTokens ?? 0
	const usableTokens = getUsableContextTokens(contextWindow, outputReservation)
	const limit = triggerTokens === undefined ? usableTokens : Math.min(usableTokens, Math.max(0, triggerTokens))
	if (!Number.isFinite(limit) || !Number.isFinite(fixedTokens)) return 0
	const fixed = Math.min(limit, Math.max(0, fixedTokens))
	return Math.floor(fixed + ((limit - fixed) * normalizedPercent) / 100)
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
 * Success always requires a measured decrease. A smaller decrease is sufficient
 * when it reaches the target; otherwise require the minimum reduction. Missing,
 * invalid, unchanged, or larger counts can never be reported as a reduction.
 */
export function evaluateCompactionProgress({
	beforeTokens,
	afterTokens,
	targetTokens,
	minReductionPercent = DEFAULT_MIN_REDUCTION_PERCENT,
}: CompactionProgressOptions): CompactionProgress {
	const validBefore = Number.isFinite(beforeTokens) && beforeTokens >= 0
	const before = validBefore ? beforeTokens : 0
	const after =
		afterTokens !== null && afterTokens !== undefined && Number.isFinite(afterTokens) && afterTokens >= 0
			? afterTokens
			: undefined
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
		status:
			validBefore && reductionTokens > 0 && (targetReached || hasMinimumReduction) ? "reduced" : "no_progress",
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
