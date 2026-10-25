/** A completed scripted probe establishes observations, not acceptance against an undeclared performance budget. */
export function latencyObservation() {
	return {
		observationStatus: "observed" as const,
		performanceAcceptance: {
			status: "not-evaluated" as const,
			reasons: ["No predeclared performance policy was supplied"],
		},
	}
}

export function summarizeLatencyObservations(values: readonly number[]) {
	if (!values.length) return null
	if (values.some((value) => !Number.isFinite(value) || value < 0)) {
		throw new Error("Latency observations must be finite nonnegative milliseconds")
	}
	const ordered = [...values].sort((left, right) => left - right)
	const at = (quantile: number) => ordered[Math.max(0, Math.ceil(quantile * ordered.length) - 1)]!
	return {
		count: ordered.length,
		p50: at(0.5),
		p95: ordered.length === 1 ? null : at(0.95),
		max: ordered.at(-1)!,
		percentileInterpretation: "descriptive sample order statistics; no population tail or regression inference",
	}
}
