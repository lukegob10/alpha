import { calibrationReportSchema, type CalibrationReport } from "./contracts"

export type ModelCalibrationTrial = {
	id: string
	taskIdentity: string
	model: "luna-high" | "sol-high"
	passed: boolean
	unexpected: boolean
	safetyFailed: boolean
	reviewed: boolean
}

export function mergeModelCalibration(reportValue: unknown, trials: ModelCalibrationTrial[]): CalibrationReport {
	const report = calibrationReportSchema.parse(reportValue)
	if (trials.length < 5) throw new Error("At least five model trials are required")
	const model = trials[0]!.model
	if (trials.some((trial) => trial.model !== model))
		throw new Error("A calibration batch must contain one model role")
	if (trials.some((trial) => trial.taskIdentity !== report.taskIdentity))
		throw new Error("Calibration trial task identity mismatch")
	if (new Set(trials.map(({ id }) => id)).size !== trials.length)
		throw new Error("Calibration trial ids must be unique")
	const observation = {
		model,
		repetitions: trials.length,
		passed: trials.filter(({ passed }) => passed).length,
		trialIds: trials.map(({ id }) => id),
		unexpectedTrialIds: trials.filter(({ unexpected }) => unexpected).map(({ id }) => id),
		safetyFailureTrialIds: trials.filter(({ safetyFailed }) => safetyFailed).map(({ id }) => id),
	}
	return {
		...report,
		models: [...report.models.filter((entry) => entry.model !== model), observation],
		humanReview: {
			...report.humanReview,
			reviewedTrialIds: [
				...new Set([
					...report.humanReview.reviewedTrialIds,
					...trials.filter(({ reviewed }) => reviewed).map(({ id }) => id),
				]),
			].sort(),
		},
		admitted: false,
	}
}
