import type { CampaignAttempt, CampaignCounts, CampaignReport, CampaignSampling } from "./types"

const phases = new Set(["sample", "reproduce", "regression-before", "verify-fix", "neighbor"])
const cellKey = (host: string, scenario: string, sample: number) => JSON.stringify([host, scenario, sample])

/** Original cells are unique; diagnostic passes never increase sample coverage. */
export function summarizeCampaignSamples(
	plan: NonNullable<CampaignReport["evaluationPlan"]>,
	attempts: CampaignAttempt[],
): CampaignSampling {
	const planned = plan.hostVersions.length * plan.scenarioIds.length * plan.samples
	if (
		!Number.isSafeInteger(plan.samples) ||
		plan.samples < 1 ||
		!Number.isSafeInteger(planned) ||
		planned < 1 ||
		planned > 100_000
	)
		throw new Error("Invalid campaign sample plan")
	const remaining = new Set(
		plan.hostVersions.flatMap((host) =>
			plan.scenarioIds.flatMap((scenario) =>
				Array.from({ length: plan.samples }, (_, index) => cellKey(host, scenario, index + 1)),
			),
		),
	)
	if (remaining.size !== planned) throw new Error("Invalid campaign sample plan")
	const counts: CampaignCounts = { passed: 0, failed: 0, blocked: 0 }
	let diagnosticAttempts = 0
	for (const { request, result } of attempts) {
		if (!phases.has(request.phase) || !Object.hasOwn(counts, result.status))
			throw new Error("Invalid campaign attempt phase or status")
		if (request.phase !== "sample") {
			diagnosticAttempts++
			continue
		}
		if (!remaining.delete(cellKey(request.host.version, request.scenarioId, request.sample)))
			throw new Error("Campaign sample is duplicated or outside its plan")
		counts[result.status]++
	}
	return { planned, completed: planned - remaining.size, ...counts, notRun: remaining.size, diagnosticAttempts }
}

/** Legacy reports retain their all-phase counters; additive sample summaries must reconcile when present. */
export function campaignAccountingMatches(report: CampaignReport): boolean {
	const counts: CampaignCounts = { passed: 0, failed: 0, blocked: 0 }
	const attemptIds = new Set<string>()
	for (const attempt of report.attempts) {
		if (!phases.has(attempt.request.phase) || !Object.hasOwn(counts, attempt.result.status)) return false
		if (
			attempt.result.status === "passed" &&
			(attempt.result.failure !== undefined || attempt.result.retentionFailed || attempt.evidenceFailed)
		)
			return false
		if (attempt.request.campaignId !== report.id || attemptIds.has(attempt.request.attemptId)) return false
		attemptIds.add(attempt.request.attemptId)
		if (
			attempt.termination !== undefined &&
			(!["cancelled", "timeout"].includes(attempt.termination) || attempt.result.status !== "blocked")
		)
			return false
		counts[attempt.result.status]++
	}
	if (Object.entries(counts).some(([key, value]) => report.counts[key as keyof CampaignCounts] !== value))
		return false
	if (!report.evaluationPlan) return report.sampling === undefined
	try {
		const sampling = summarizeCampaignSamples(report.evaluationPlan, report.attempts)
		if (report.stopReason === "completed" && sampling.notRun !== 0) return false
		if (report.collectionMode === "sample-only" && sampling.diagnosticAttempts !== 0) return false
		if (report.collectionMode === "sample-then-diagnose") {
			let diagnosticsStarted = false
			const failedOriginals = new Set<string>()
			for (const { request, result } of report.attempts) {
				const cell = cellKey(request.host.version, request.scenarioId, request.sample)
				if (request.phase === "sample") {
					if (diagnosticsStarted) return false
					if (result.status === "failed") failedOriginals.add(cell)
				} else {
					if (sampling.notRun !== 0 || request.phase !== "reproduce" || !failedOriginals.has(cell))
						return false
					diagnosticsStarted = true
				}
			}
		}
		return (
			report.sampling === undefined ||
			Object.entries(sampling).every(([key, value]) => report.sampling![key as keyof CampaignSampling] === value)
		)
	} catch {
		return false
	}
}
