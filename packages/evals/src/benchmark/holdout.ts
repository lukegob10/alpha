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
