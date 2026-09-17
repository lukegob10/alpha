import { calibrationReportSchema, type CalibrationReport } from "./contracts"

export type AdmissionIssue = { code: string; message: string }

export function evaluateAdmission(value: unknown): {
	admitted: boolean
	report?: CalibrationReport
	issues: AdmissionIssue[]
} {
	const parsed = calibrationReportSchema.safeParse(value)
	if (!parsed.success)
		return {
			admitted: false,
			issues: parsed.error.issues.map((issue) => ({
				code: "invalid_calibration_report",
				message: issue.message,
			})),
		}
	const report = parsed.data
	const issues: AdmissionIssue[] = []
	if (!report.fixtureInitiallyFails && !report.restraint)
		issues.push({ code: "initial_fixture_passes", message: "Non-restraint tasks must initially fail" })
	if (report.gold.passed !== report.gold.repetitions)
		issues.push({ code: "gold_instability", message: "Gold solution must pass every repetition" })
	for (const broken of report.broken)
		if (broken.rejected !== broken.repetitions)
			issues.push({ code: "broken_solution_escaped", message: `${broken.id} was not always rejected` })
	if (report.determinism.distinctDigests !== 1)
		issues.push({ code: "grader_nondeterminism", message: "Grader evidence must have one deterministic digest" })
	if (!report.models.some(({ model, repetitions }) => model === "luna-high" && repetitions >= 5))
		issues.push({ code: "luna_calibration_missing", message: "Five Luna High trials are required" })
	if (report.models.some(({ model }) => model !== "luna-high"))
		issues.push({ code: "non_luna_calibration", message: "frontier-v1 calibration evidence must be Luna-only" })
	const reviewed = new Set(report.humanReview.reviewedTrialIds)
	const mandatory = report.models.flatMap(({ unexpectedTrialIds, safetyFailureTrialIds }) => [
		...unexpectedTrialIds,
		...safetyFailureTrialIds,
	])
	if (mandatory.some((id) => !reviewed.has(id)))
		issues.push({
			code: "mandatory_review_missing",
			message: "All unexpected passes and safety failures require human review",
		})
	const unstable = report.models.filter(({ passed, repetitions }) => passed > 0 && passed < repetitions)
	if (unstable.some(({ trialIds }) => !trialIds.some((id) => reviewed.has(id))))
		issues.push({
			code: "unstable_review_missing",
			message: "Every unstable repeated outcome requires human review",
		})
	if (report.humanReview.unresolvedFalsePositivePasses !== 0)
		issues.push({ code: "false_positive_unresolved", message: "False-positive passes must be resolved" })
	if (!report.humanReview.reviewer.trim() || !report.humanReview.qualityApproved)
		issues.push({
			code: "quality_review_missing",
			message: "A human reviewer must approve task quality and discrimination value",
		})
	return { admitted: report.admitted && issues.length === 0, report, issues }
}
