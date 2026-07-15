import { canonicalJson, sha256 } from "../evidence/index"
import type { CalibrationReport } from "./contracts"

export type ReviewReason = "random-sample" | "unexpected" | "safety-failure" | "unstable-task" | "grader-disagreement"

export type ReviewSampleManifest = {
	schemaVersion: 1
	seed: string
	population: number
	randomSampleSize: number
	selectedTrialCount: number
	entries: Array<{ taskIdentity: string; trialId: string; reasons: ReviewReason[] }>
	digest: string
}

export function buildReviewSample(
	reports: CalibrationReport[],
	options: { seed: string; disagreementTrialIds?: string[] },
): ReviewSampleManifest {
	if (!options.seed.trim()) throw new Error("Review sampling requires a non-empty seed")
	const trials = reports.flatMap((report) =>
		report.models
			.filter(({ model }) => model === "luna-high")
			.flatMap((model) =>
				model.trialIds.map((trialId) => ({
					taskIdentity: report.taskIdentity,
					trialId,
					unexpected: model.unexpectedTrialIds.includes(trialId),
					safetyFailed: model.safetyFailureTrialIds.includes(trialId),
					unstable: model.passed > 0 && model.passed < model.repetitions,
				})),
			),
	)
	if (trials.length === 0) throw new Error("No Luna High calibration trials are available for review sampling")
	if (new Set(trials.map(({ trialId }) => trialId)).size !== trials.length)
		throw new Error("Calibration reports contain duplicate trial ids")
	const known = new Set(trials.map(({ trialId }) => trialId))
	const disagreements = new Set(options.disagreementTrialIds ?? [])
	for (const trialId of disagreements)
		if (!known.has(trialId)) throw new Error(`Unknown grader-disagreement trial id: ${trialId}`)
	const randomSampleSize = Math.ceil(trials.length * 0.1)
	const sampled = new Set(
		[...trials]
			.sort((left, right) =>
				sha256(`${options.seed}:${left.trialId}`).localeCompare(sha256(`${options.seed}:${right.trialId}`)),
			)
			.slice(0, randomSampleSize)
			.map(({ trialId }) => trialId),
	)
	const entries = trials
		.map((trial) => {
			const reasons: ReviewReason[] = []
			if (sampled.has(trial.trialId)) reasons.push("random-sample")
			if (trial.unexpected) reasons.push("unexpected")
			if (trial.safetyFailed) reasons.push("safety-failure")
			if (trial.unstable) reasons.push("unstable-task")
			if (disagreements.has(trial.trialId)) reasons.push("grader-disagreement")
			return { taskIdentity: trial.taskIdentity, trialId: trial.trialId, reasons }
		})
		.filter(({ reasons }) => reasons.length > 0)
		.sort(
			(left, right) =>
				left.taskIdentity.localeCompare(right.taskIdentity) || left.trialId.localeCompare(right.trialId),
		)
	const body = {
		schemaVersion: 1 as const,
		seed: options.seed,
		population: trials.length,
		randomSampleSize,
		selectedTrialCount: entries.length,
		entries,
	}
	return { ...body, digest: sha256(canonicalJson(body)) }
}

export function validateReviewSample(reports: CalibrationReport[], value: ReviewSampleManifest): void {
	const disagreementTrialIds = value.entries
		.filter(({ reasons }) => reasons.includes("grader-disagreement"))
		.map(({ trialId }) => trialId)
	const expected = buildReviewSample(reports, { seed: value.seed, disagreementTrialIds })
	if (canonicalJson(expected) !== canonicalJson(value))
		throw new Error("Review sample does not match the deterministic Luna trial population")
	const reviewedByTask = new Map(
		reports.map((report) => [report.taskIdentity, new Set(report.humanReview.reviewedTrialIds)]),
	)
	for (const entry of value.entries) {
		if (!reviewedByTask.get(entry.taskIdentity)?.has(entry.trialId))
			throw new Error(`Required review is incomplete for ${entry.taskIdentity}:${entry.trialId}`)
	}
}
