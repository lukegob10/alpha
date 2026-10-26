import { z } from "zod"

import {
	calibrationReportSchema,
	modelCalibrationDeliverySchema,
	modelCalibrationScoreableStatuses,
	type CalibrationReport,
} from "./contracts"

export type ModelCalibrationTrial = {
	id: string
	taskIdentity: string
	model: "luna-high" | "sol-high"
	passed: boolean
	unexpected: boolean
	safetyFailed: boolean
	reviewed: boolean
}

const modelCalibrationTrialSchema = z
	.object({
		id: z.string().trim().min(1),
		taskIdentity: z.string().trim().min(1),
		model: z.enum(["luna-high", "sol-high"]),
		passed: z.boolean(),
		unexpected: z.boolean(),
		safetyFailed: z.boolean(),
		reviewed: z.boolean(),
	})
	.strict()
	.refine((trial) => !trial.passed || !trial.safetyFailed, { message: "A safety failure cannot pass calibration" })

export function mergeModelCalibration(
	reportValue: unknown,
	trialsValue: ModelCalibrationTrial[],
	deliveryValue?: unknown,
): CalibrationReport {
	const report = calibrationReportSchema.parse(reportValue)
	const trials = z.array(modelCalibrationTrialSchema).parse(trialsValue)
	const delivery = deliveryValue === undefined ? undefined : modelCalibrationDeliverySchema.parse(deliveryValue)
	if (trials.length < 5 && !delivery) throw new Error("At least five model trials are required")
	const model = delivery?.model ?? trials[0]!.model
	if (trials.some((trial) => trial.model !== model))
		throw new Error("A calibration batch must contain one model role")
	if (trials.some((trial) => trial.taskIdentity !== report.taskIdentity))
		throw new Error("Calibration trial task identity mismatch")
	if (new Set(trials.map(({ id }) => id)).size !== trials.length)
		throw new Error("Calibration trial ids must be unique")
	if (delivery && trials.length !== delivery.scoreable)
		throw new Error("Delivery scoreable count must match incoming model trials")
	if (delivery) {
		const scoreableStatuses = new Set<string>(modelCalibrationScoreableStatuses)
		const rows = new Map(
			delivery.trials.filter(({ status }) => scoreableStatuses.has(status)).map((row) => [row.id, row]),
		)
		if (
			trials.some((trial) => {
				const row = rows.get(trial.id)
				return (
					!row ||
					trial.passed !== (row.status === "passed") ||
					trial.safetyFailed !== (row.status === "safety_failed")
				)
			})
		)
			throw new Error("Delivery statuses must match incoming model trial identities and outcomes")
	}
	const observation = {
		model,
		repetitions: trials.length,
		passed: trials.filter(({ passed }) => passed).length,
		trialIds: trials.map(({ id }) => id),
		unexpectedTrialIds: trials.filter(({ unexpected }) => unexpected).map(({ id }) => id),
		safetyFailureTrialIds: trials.filter(({ safetyFailed }) => safetyFailed).map(({ id }) => id),
	}
	const retainedModels = report.models.filter((entry) => entry.model !== model)
	const retainedTrialIds = new Set(retainedModels.flatMap(({ trialIds }) => trialIds))
	const modelDelivery = [
		...(report.modelDelivery ?? []).filter((entry) => entry.model !== model),
		...(delivery ? [delivery] : []),
	]
	return calibrationReportSchema.parse({
		...report,
		models: [...retainedModels, ...(trials.length >= 5 ? [observation] : [])],
		modelDelivery: modelDelivery.length ? modelDelivery : undefined,
		humanReview: {
			...report.humanReview,
			// Approval of prior outputs does not approve a replacement calibration batch.
			qualityApproved: false,
			reviewedTrialIds: [
				...new Set([
					...report.humanReview.reviewedTrialIds.filter((id) => retainedTrialIds.has(id)),
					...(trials.length >= 5 ? trials.filter(({ reviewed }) => reviewed).map(({ id }) => id) : []),
				]),
			].sort(),
		},
		admitted: false,
	})
}
