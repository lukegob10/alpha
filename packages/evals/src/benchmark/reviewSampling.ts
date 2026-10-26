import { canonicalJson, sha256 } from "../evidence/index"
import { calibrationReportSchema, type CalibrationReport, type ModelCalibrationDelivery } from "./contracts"

export type ReviewReason = "random-sample" | "unexpected" | "safety-failure" | "unstable-task" | "grader-disagreement"

export type ReviewSampleManifest = {
	schemaVersion: 1
	seed: string
	population: number
	randomSampleSize: number
	selectedTrialCount: number
	entries: Array<{ taskIdentity: string; trialId: string; reasons: ReviewReason[] }>
	populationDigest?: string
	digest: string
}

export type ReviewSampleRequirements = { taskIdentities: string[]; disagreementTrialIds: string[] }

export function buildReviewSample(
	reports: CalibrationReport[],
	options: { seed: string; disagreementTrialIds?: string[]; taskIdentities?: string[] },
): ReviewSampleManifest {
	if (!options.seed.trim()) throw new Error("Review sampling requires a non-empty seed")
	if (options.taskIdentities !== undefined) assertTaskPopulation(reports, options.taskIdentities)
	const tasks = new Set<string>()
	const population: Array<{
		taskIdentity: string
		observation: CalibrationReport["models"][number]
		delivery: ModelCalibrationDelivery | null
	}> = []
	const trials = reports.flatMap((value) => {
		const report = calibrationReportSchema.parse(value)
		if (tasks.has(report.taskIdentity)) throw new Error("Calibration reports contain duplicate task identities")
		tasks.add(report.taskIdentity)
		const models = report.models.filter(({ model }) => model === "luna-high")
		if (models.length !== 1)
			throw new Error("Every calibration task requires exactly one Luna High observation for review sampling")
		const model = models[0]!
		const delivery = report.modelDelivery?.find(({ model }) => model === "luna-high")
		population.push({
			taskIdentity: report.taskIdentity,
			observation: {
				...model,
				trialIds: [...model.trialIds].sort(compareIdentities),
				unexpectedTrialIds: [...model.unexpectedTrialIds].sort(compareIdentities),
				safetyFailureTrialIds: [...model.safetyFailureTrialIds].sort(compareIdentities),
			},
			// Older calibration reports have no exact delivery record; keep that source explicitly unknown.
			delivery: delivery
				? {
						...delivery,
						trials: [...delivery.trials].sort((left, right) => compareIdentities(left.id, right.id)),
					}
				: null,
		})
		return model.trialIds.map((trialId) => ({
			taskIdentity: report.taskIdentity,
			trialId,
			unexpected: model.unexpectedTrialIds.includes(trialId),
			safetyFailed: model.safetyFailureTrialIds.includes(trialId),
			unstable: model.passed > 0 && model.passed < model.repetitions,
		}))
	})
	if (trials.length === 0) throw new Error("No Luna High calibration trials are available for review sampling")
	if (new Set(trials.map(({ trialId }) => trialId)).size !== trials.length)
		throw new Error("Calibration reports contain duplicate trial ids")
	const known = new Set(trials.map(({ trialId }) => trialId))
	const disagreementTrialIds = options.disagreementTrialIds === undefined ? [] : options.disagreementTrialIds
	assertUniqueIdentities(disagreementTrialIds, "Grader-disagreement trial ids")
	const disagreements = new Set(disagreementTrialIds)
	for (const trialId of disagreements)
		if (!known.has(trialId)) throw new Error(`Unknown grader-disagreement trial id: ${trialId}`)
	const randomSampleSize = Math.ceil(trials.length * 0.1)
	const sampled = new Set(
		[...trials]
			.sort((left, right) =>
				compareIdentities(
					sha256(`${options.seed}:${left.trialId}`),
					sha256(`${options.seed}:${right.trialId}`),
				),
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
				compareIdentities(left.taskIdentity, right.taskIdentity) ||
				compareIdentities(left.trialId, right.trialId),
		)
	const body = {
		schemaVersion: 1 as const,
		seed: options.seed,
		population: trials.length,
		randomSampleSize,
		selectedTrialCount: entries.length,
		entries,
		populationDigest: sha256(
			canonicalJson(population.sort((left, right) => compareIdentities(left.taskIdentity, right.taskIdentity))),
		),
	}
	return { ...body, digest: sha256(canonicalJson(body)) }
}

// Locale collation can equate distinct Unicode identities and leave the sealed order dependent on input order.
function compareIdentities(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

export function validateReviewSample(
	reports: CalibrationReport[],
	value: ReviewSampleManifest,
	requirements: ReviewSampleRequirements,
	options: { requirePopulationDigest?: boolean } = {},
): void {
	if (!requirements || !Array.isArray(requirements.disagreementTrialIds))
		throw new Error("Independent task population and grader-disagreement obligations are required")
	assertTaskPopulation(reports, requirements.taskIdentities)
	if (options.requirePopulationDigest && value.populationDigest === undefined)
		throw new Error("Legacy review sample lacks the complete population digest required for release")
	const expected = buildReviewSample(reports, {
		seed: value.seed,
		disagreementTrialIds: requirements.disagreementTrialIds,
		taskIdentities: requirements.taskIdentities,
	})
	// Historical manifests remain inspectable with independent source input; release requires the new source binding.
	if (value.populationDigest === undefined) {
		delete expected.populationDigest
		const { digest: _digest, ...body } = expected
		expected.digest = sha256(canonicalJson(body))
	}
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

function assertTaskPopulation(reports: CalibrationReport[], taskIdentities: string[]): void {
	assertUniqueIdentities(taskIdentities, "Independent authoritative task population")
	if (taskIdentities.length === 0) throw new Error("Independent authoritative task population must not be empty")
	const expected = new Set(taskIdentities)
	const actual = reports.map((report) => report.taskIdentity)
	if (
		actual.length !== expected.size ||
		new Set(actual).size !== actual.length ||
		actual.some((id) => !expected.has(id))
	)
		throw new Error("Calibration reports do not match the independent authoritative task population")
}

function assertUniqueIdentities(value: string[], label: string): void {
	if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim()))
		throw new Error(`${label} must be an explicit array of non-empty identities`)
	if (new Set(value).size !== value.length) throw new Error(`${label} must contain unique identities`)
}
