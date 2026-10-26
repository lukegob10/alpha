import { describe, expect, it } from "vitest"

import { canonicalJson, sha256 } from "../../evidence/index"
import { modelCalibrationDeliverySchema, modelCalibrationStatusSchema, type CalibrationReport } from "../contracts"
import { buildReviewSample, validateReviewSample } from "../reviewSampling"

function report(task: string, passed = 5): CalibrationReport {
	const trialIds = Array.from({ length: 5 }, (_, index) => `${task}-${index + 1}`)
	return {
		schemaVersion: 1,
		taskIdentity: `${task}@1`,
		fixtureInitiallyFails: true,
		restraint: false,
		gold: { repetitions: 20, passed: 20 },
		broken: ["one", "two", "three"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: id })),
		determinism: { repetitions: 50, distinctDigests: 1 },
		models: [
			{
				model: "luna-high",
				repetitions: 5,
				passed,
				trialIds,
				unexpectedTrialIds: task === "task-a" ? [trialIds[0]!] : [],
				safetyFailureTrialIds: task === "task-b" ? [trialIds[1]!] : [],
			},
		],
		humanReview: { unresolvedFalsePositivePasses: 0, reviewedTrialIds: [], reviewer: "", qualityApproved: false },
		admitted: false,
	}
}

function addDelivery(source: CalibrationReport, statuses: Array<"passed" | "outcome_failed" | "agent_error">): void {
	source.modelDelivery = [
		modelCalibrationDeliverySchema.parse({
			model: "luna-high",
			taskIdentity: source.taskIdentity,
			runId: 42,
			scheduled: statuses.length,
			scoreable: statuses.length,
			excluded: 0,
			missing: 0,
			statusCounts: Object.fromEntries(
				modelCalibrationStatusSchema.options.map((status) => [
					status,
					statuses.filter((row) => row === status).length,
				]),
			),
			trials: source.models[0]!.trialIds.map((id, index) => ({
				id,
				status: statuses[index],
				attemptCount: index + 1,
				retryAssisted: index > 0,
			})),
		}),
	]
}

describe("deterministic human-review sampling", () => {
	it("selects a reproducible ten-percent sample plus every mandatory trial", () => {
		const reports = [report("task-a"), report("task-b"), report("task-c", 3), report("task-d")]
		const first = buildReviewSample(reports, { seed: "frontier-v1", disagreementTrialIds: ["task-d-5"] })
		const second = buildReviewSample(reports, { seed: "frontier-v1", disagreementTrialIds: ["task-d-5"] })
		expect(first).toEqual(second)
		expect(first.population).toBe(20)
		expect(first.randomSampleSize).toBe(2)
		expect(first.entries.filter(({ reasons }) => reasons.includes("random-sample"))).toHaveLength(2)
		expect(first.entries.find(({ trialId }) => trialId === "task-a-1")?.reasons).toContain("unexpected")
		expect(first.entries.find(({ trialId }) => trialId === "task-b-2")?.reasons).toContain("safety-failure")
		expect(first.entries.filter(({ taskIdentity }) => taskIdentity === "task-c@1")).toHaveLength(5)
		expect(first.entries.find(({ trialId }) => trialId === "task-d-5")?.reasons).toContain("grader-disagreement")
		expect(first.digest).toMatch(/^sha256:/)
		for (const entry of first.entries) {
			const target = reports.find(({ taskIdentity }) => taskIdentity === entry.taskIdentity)!
			target.humanReview.reviewedTrialIds.push(entry.trialId)
		}
		const requirements = {
			taskIdentities: reports.map(({ taskIdentity }) => taskIdentity),
			disagreementTrialIds: ["task-d-5"],
		}
		expect(() => validateReviewSample(reports, first, requirements)).not.toThrow()
		reports[0]!.humanReview.reviewedTrialIds = []
		expect(() => validateReviewSample(reports, first, requirements)).toThrow("incomplete")
	})

	it("rejects a deleted disagreement-only entry even when the submitted sample is resealed", () => {
		const reports = [report("task-e"), report("task-f")]
		const sampled = buildReviewSample(reports, { seed: "independent-obligations" })
		const disagreementTrialId = reports
			.flatMap(({ models }) => models[0]!.trialIds)
			.find((trialId) => !sampled.entries.some((entry) => entry.trialId === trialId))!
		const sample = buildReviewSample(reports, {
			seed: sampled.seed,
			disagreementTrialIds: [disagreementTrialId],
		})
		for (const source of reports) source.humanReview.reviewedTrialIds = [...source.models[0]!.trialIds]
		const requirements = {
			taskIdentities: reports.map(({ taskIdentity }) => taskIdentity),
			disagreementTrialIds: [disagreementTrialId],
		}
		expect(() => validateReviewSample(reports, sample, requirements)).not.toThrow()
		const { digest: _digest, ...body } = sample
		body.entries = body.entries.filter(({ trialId }) => trialId !== disagreementTrialId)
		body.selectedTrialCount = body.entries.length
		const resealed = { ...body, digest: sha256(canonicalJson(body)) }
		expect(() => validateReviewSample(reports, resealed, requirements)).toThrow("does not match")
	})

	it("requires independently supplied obligations even for a legacy sample with no disagreements", () => {
		const reports = [report("task-e")]
		const {
			digest: _digest,
			populationDigest: _populationDigest,
			...body
		} = buildReviewSample(reports, {
			seed: "legacy-sample",
		})
		const sample = { ...body, digest: sha256(canonicalJson(body)) }
		reports[0]!.humanReview.reviewedTrialIds = [...reports[0]!.models[0]!.trialIds]
		expect(() => validateReviewSample(reports, sample, undefined as never)).toThrow("Independent")
		expect(() =>
			validateReviewSample(reports, sample, { taskIdentities: ["task-e@1"], disagreementTrialIds: [] }),
		).not.toThrow()
		expect(() =>
			validateReviewSample(
				reports,
				sample,
				{ taskIdentities: ["task-e@1"], disagreementTrialIds: [] },
				{ requirePopulationDigest: true },
			),
		).toThrow("Legacy review sample lacks")
	})

	it("rejects a resealed sample and reports that omit an authoritative task", () => {
		const reports = [report("task-e")]
		const sample = buildReviewSample(reports, { seed: "omitted-task" })
		reports[0]!.humanReview.reviewedTrialIds = [...reports[0]!.models[0]!.trialIds]
		expect(() =>
			buildReviewSample(reports, { seed: sample.seed, taskIdentities: ["task-e@1", "task-f@1"] }),
		).toThrow("authoritative task population")
		expect(() =>
			validateReviewSample(reports, sample, {
				taskIdentities: ["task-e@1", "task-f@1"],
				disagreementTrialIds: [],
			}),
		).toThrow("authoritative task population")
	})

	it("binds every Luna trial and its outcomes, including trials outside the selected reviews", () => {
		const reports = [report("task-e"), report("task-f")]
		const requirements = { taskIdentities: ["task-e@1", "task-f@1"], disagreementTrialIds: [] }
		const sample = buildReviewSample(reports, { seed: "complete-population", ...requirements })
		const target = reports[1]!.models[0]!
		const omitted = target.trialIds.findIndex(
			(trialId) => !sample.entries.some((entry) => entry.trialId === trialId),
		)
		target.trialIds[omitted] = "replacement-trial"
		for (const source of reports) source.humanReview.reviewedTrialIds = [...source.models[0]!.trialIds]
		expect(() => validateReviewSample(reports, sample, requirements)).toThrow("does not match")
		const updated = buildReviewSample(reports, { seed: sample.seed, ...requirements })
		expect(updated.populationDigest).not.toBe(sample.populationDigest)
		expect(() => validateReviewSample(reports, updated, requirements)).not.toThrow()
		target.passed = 0
		expect(() => validateReviewSample(reports, updated, requirements)).toThrow("does not match")
	})

	it("binds per-trial delivered outcomes when pass and failure counts remain unchanged", () => {
		const source = report("task-e", 1)
		addDelivery(source, ["passed", "outcome_failed", "outcome_failed", "outcome_failed", "outcome_failed"])
		source.humanReview.reviewedTrialIds = [...source.models[0]!.trialIds]
		const requirements = { taskIdentities: [source.taskIdentity], disagreementTrialIds: [] }
		const sample = buildReviewSample([source], { seed: "exact-delivered-outcomes", ...requirements })
		expect(() => validateReviewSample([source], sample, requirements)).not.toThrow()
		const rows = source.modelDelivery![0]!.trials
		rows[0]!.status = "outcome_failed"
		rows[1]!.status = "passed"
		const swapped = buildReviewSample([source], { seed: sample.seed, ...requirements })
		expect(swapped.entries).toEqual(sample.entries)
		expect(swapped.populationDigest).not.toBe(sample.populationDigest)
		expect(() => validateReviewSample([source], sample, requirements)).toThrow("does not match")
	})

	it("binds delivered statuses for trials outside the selected reviews", () => {
		const source = report("task-e", 0)
		const base = buildReviewSample([source], { seed: "unselected-delivery" })
		const unselected = source.models[0]!.trialIds.filter(
			(id) => !base.entries.some((entry) => entry.trialId === id),
		)
		const statuses = source.models[0]!.trialIds.map((id) =>
			id === unselected[0] ? ("agent_error" as const) : ("outcome_failed" as const),
		)
		addDelivery(source, statuses)
		source.humanReview.reviewedTrialIds = [...source.models[0]!.trialIds]
		const requirements = { taskIdentities: [source.taskIdentity], disagreementTrialIds: [] }
		const sample = buildReviewSample([source], { seed: base.seed, ...requirements })
		const rows = source.modelDelivery![0]!.trials
		rows.find(({ id }) => id === unselected[0])!.status = "outcome_failed"
		rows.find(({ id }) => id === unselected[1])!.status = "agent_error"
		const swapped = buildReviewSample([source], { seed: sample.seed, ...requirements })
		expect(swapped.entries).toEqual(sample.entries)
		expect(swapped.populationDigest).not.toBe(sample.populationDigest)
		expect(() => validateReviewSample([source], sample, requirements)).toThrow("does not match")
	})

	it("normalizes delivered trial order while retaining run and retry metadata", () => {
		const source = report("task-e")
		addDelivery(source, ["passed", "passed", "passed", "passed", "passed"])
		const first = buildReviewSample([source], { seed: "delivery-order" })
		source.modelDelivery![0]!.trials.reverse()
		source.models[0]!.trialIds.reverse()
		expect(buildReviewSample([source], { seed: first.seed })).toEqual(first)
		source.modelDelivery![0]!.runId++
		expect(buildReviewSample([source], { seed: first.seed }).populationDigest).not.toBe(first.populationDigest)
		source.modelDelivery![0]!.runId--
		source.modelDelivery![0]!.trials[0]!.attemptCount = 20
		expect(buildReviewSample([source], { seed: first.seed }).populationDigest).not.toBe(first.populationDigest)
	})

	it("rejects malformed independent sources and duplicate authoritative identities", () => {
		const reports = [report("task-e")]
		const sample = buildReviewSample(reports, { seed: "source-shape" })
		reports[0]!.humanReview.reviewedTrialIds = [...reports[0]!.models[0]!.trialIds]
		for (const taskIdentities of [[], ["task-e@1", "task-e@1"], ["task-e@2"], [""], undefined]) {
			expect(() =>
				validateReviewSample(reports, sample, {
					taskIdentities: taskIdentities as string[],
					disagreementTrialIds: [],
				}),
			).toThrow()
		}
		for (const disagreementTrialIds of [undefined, "task-e-1", ["task-e-1", "task-e-1"], ["missing"]]) {
			expect(() =>
				validateReviewSample(reports, sample, {
					taskIdentities: ["task-e@1"],
					disagreementTrialIds: disagreementTrialIds as string[],
				}),
			).toThrow()
		}
	})

	it("rejects empty populations, unknown disagreements, and duplicate trial ids", () => {
		expect(() => buildReviewSample([], { seed: "x" })).toThrow("No Luna")
		expect(() => buildReviewSample([report("task-a")], { seed: "x", disagreementTrialIds: ["missing"] })).toThrow(
			"Unknown",
		)
		const duplicate = report("task-b")
		duplicate.models[0]!.trialIds[0] = "task-a-1"
		expect(() => buildReviewSample([report("task-a"), duplicate], { seed: "x" })).toThrow("duplicate")
	})

	it("requires one complete Luna observation for every unique calibration task", () => {
		const missing = report("task-b")
		missing.models = []
		expect(() => buildReviewSample([report("task-a"), missing], { seed: "x" })).toThrow("exactly one Luna")

		const duplicateTask = report("task-b")
		duplicateTask.taskIdentity = "task-a@1"
		expect(() => buildReviewSample([report("task-a"), duplicateTask], { seed: "x" })).toThrow(
			"duplicate task identities",
		)

		const splitOutcomes = report("task-a")
		splitOutcomes.models.push(report("task-b", 0).models[0]!)
		expect(() => buildReviewSample([splitOutcomes], { seed: "x" })).toThrow("exactly one Luna")
	})

	it("rejects malformed outcomes and failure references before constructing review obligations", () => {
		const tooManyPasses = report("task-a", 6)
		expect(() => buildReviewSample([tooManyPasses], { seed: "x" })).toThrow("passes cannot exceed")
		const missingFailure = report("task-a")
		missingFailure.models[0]!.safetyFailureTrialIds = ["unrecorded-safety-failure"]
		expect(() => buildReviewSample([missingFailure], { seed: "x" })).toThrow("must reference declared")
	})

	it("keeps the manifest independent of report and trial order for distinct Unicode identities", () => {
		const reports = [report("task-\u00e9", 3), report("task-e\u0301", 3)]
		const first = buildReviewSample(reports, { seed: "unicode-order" })
		for (const entry of reports) entry.models[0]!.trialIds.reverse()
		const second = buildReviewSample(reports.reverse(), { seed: "unicode-order" })
		expect(second).toEqual(first)
	})
})
