import { describe, expect, it } from "vitest"

import { calibrationReportSchema } from "../contracts"
import { mergeModelCalibration, type ModelCalibrationTrial } from "../modelCalibration"

function trials(model: ModelCalibrationTrial["model"], prefix: string, reviewed = false): ModelCalibrationTrial[] {
	return Array.from({ length: 5 }, (_, index) => ({
		id: `${prefix}-${index}`,
		taskIdentity: "task@1",
		model,
		passed: true,
		unexpected: false,
		safetyFailed: false,
		reviewed,
	}))
}

function report() {
	return calibrationReportSchema.parse({
		schemaVersion: 1,
		taskIdentity: "task@1",
		fixtureInitiallyFails: true,
		gold: { repetitions: 20, passed: 20 },
		broken: ["a", "b", "c"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: "wrong-output" })),
		determinism: { repetitions: 50, distinctDigests: 1 },
		models: ["luna-high", "sol-high"].map((model) => ({
			model,
			repetitions: 5,
			passed: 5,
			trialIds: Array.from({ length: 5 }, (_, index) => `${model}-old-${index}`),
		})),
		humanReview: {
			unresolvedFalsePositivePasses: 0,
			reviewedTrialIds: ["luna-high-old-0", "sol-high-old-0"],
			reviewer: "prior-reviewer",
			qualityApproved: true,
		},
		admitted: true,
	})
}

function delivery(statuses: string[]) {
	const known = [
		"missing",
		"pending",
		"running",
		"passed",
		"outcome_failed",
		"safety_failed",
		"budget_exhausted",
		"agent_error",
		"infrastructure_error",
		"grader_error",
		"cancelled",
		"human_handoff",
	]
	const scoreable = new Set(["passed", "outcome_failed", "safety_failed", "budget_exhausted", "agent_error"])
	return {
		model: "luna-high" as const,
		taskIdentity: "task@1",
		runId: 42,
		scheduled: statuses.length,
		scoreable: statuses.filter((status) => scoreable.has(status)).length,
		excluded: statuses.filter((status) => !scoreable.has(status)).length,
		missing: statuses.filter((status) => status === "missing").length,
		statusCounts: Object.fromEntries(
			known.map((status) => [status, statuses.filter((row) => row === status).length]),
		),
		trials: statuses.map((status, index) => ({ id: `new-${index}`, status })),
	}
}

describe("model calibration review boundaries", () => {
	it("invalidates prior quality approval when new model outputs replace an approved batch", () => {
		const merged = mergeModelCalibration(report(), trials("luna-high", "new"))
		expect(merged.humanReview.qualityApproved).toBe(false)
		expect(merged.admitted).toBe(false)
	})

	it("prunes reviews of replaced outputs and preserves reviews of the retained model arm", () => {
		const incoming = trials("luna-high", "new")
		incoming[1]!.reviewed = true
		const merged = mergeModelCalibration(report(), incoming)
		expect(merged.humanReview.reviewedTrialIds).toEqual(["new-1", "sol-high-old-0"])
		expect(calibrationReportSchema.parse(merged)).toEqual(merged)
		expect(merged.models.find(({ model }) => model === "sol-high")?.trialIds).toEqual(
			report().models.find(({ model }) => model === "sol-high")?.trialIds,
		)
	})

	it("rejects incoming trial identities already assigned to the retained model arm", () => {
		const incoming = trials("luna-high", "new")
		incoming[0]!.id = "sol-high-old-0"
		expect(() => mergeModelCalibration(report(), incoming)).toThrow(/globally unique/i)
	})

	it("preserves the complete scheduled denominator alongside five scoreable outputs", () => {
		const incoming = trials("luna-high", "new")
		const observed = delivery([
			...Array<string>(5).fill("passed"),
			"missing",
			"pending",
			"running",
			"infrastructure_error",
			"grader_error",
			"cancelled",
			"human_handoff",
		])
		const merged = mergeModelCalibration(report(), incoming, observed)
		expect(merged.modelDelivery).toEqual([observed])
		expect(merged.models.find(({ model }) => model === "luna-high")).toMatchObject({ repetitions: 5, passed: 5 })
		expect(merged.humanReview.qualityApproved).toBe(false)
	})

	it("persists under-five delivery while removing the superseded capability arm and its review", () => {
		const observed = delivery(["passed", "passed", "grader_error", "missing"])
		const merged = mergeModelCalibration(report(), trials("luna-high", "new").slice(0, 2), observed)
		expect(merged.modelDelivery).toEqual([observed])
		expect(merged.models.map(({ model }) => model)).toEqual(["sol-high"])
		expect(merged.humanReview).toMatchObject({ qualityApproved: false, reviewedTrialIds: ["sol-high-old-0"] })
		expect(merged.admitted).toBe(false)
	})

	it("keeps legacy denominator information absent rather than inventing zero", () => {
		expect(calibrationReportSchema.parse(report()).modelDelivery).toBeUndefined()
		expect(mergeModelCalibration(report(), trials("luna-high", "new")).modelDelivery).toBeUndefined()
		expect(() => mergeModelCalibration(report(), trials("luna-high", "new").slice(0, 4))).toThrow("At least five")
	})

	it("rejects a delivery counter or status that contradicts its retained rows", () => {
		const merged = mergeModelCalibration(report(), trials("luna-high", "new"), delivery(Array(5).fill("passed")))
		const observed = delivery(Array(5).fill("passed"))
		for (const inconsistent of [
			{ ...observed, scheduled: 6 },
			{ ...observed, excluded: 1 },
			{ ...observed, missing: 1 },
			{ ...observed, statusCounts: { ...observed.statusCounts, grader_error: 1 } },
			{
				...observed,
				trials: observed.trials.map((row, index) => (index === 0 ? { ...row, status: "mystery" } : row)),
			},
		]) {
			expect(calibrationReportSchema.safeParse({ ...merged, modelDelivery: [inconsistent] }).success).toBe(false)
		}
	})

	it("rejects scoreable delivery whose trial identities or pass totals disagree with the capability arm", () => {
		const observed = delivery(Array(5).fill("passed"))
		const merged = mergeModelCalibration(report(), trials("luna-high", "new"), observed)
		const wrongIds = { ...observed, trials: observed.trials.map((row) => ({ ...row, id: `${row.id}-other` })) }
		expect(calibrationReportSchema.safeParse({ ...merged, modelDelivery: [wrongIds] }).success).toBe(false)
		expect(
			calibrationReportSchema.safeParse({
				...merged,
				models: merged.models.map((model) => (model.model === "luna-high" ? { ...model, passed: 4 } : model)),
			}).success,
		).toBe(false)
	})

	it.each(["passed", "unexpected", "safetyFailed", "reviewed"])(
		"rejects truthy non-boolean %s inputs before scoring",
		(field) => {
			const incoming = trials("luna-high", "new")
			Object.defineProperty(incoming[0]!, field, { value: "false" })
			expect(() => mergeModelCalibration(report(), incoming)).toThrow(/boolean/i)
		},
	)

	it("rejects blank trial identities and contradictory safety passes", () => {
		const incoming = trials("luna-high", "new")
		incoming[0]!.id = " "
		expect(() => mergeModelCalibration(report(), incoming)).toThrow()
		incoming[0]!.id = "new-0"
		incoming[0]!.safetyFailed = true
		expect(() => mergeModelCalibration(report(), incoming)).toThrow(/safety failure cannot pass/i)
	})

	it("rejects mismatched task versions even when a failed delivery has no scoreable outputs", () => {
		const observed = { ...delivery(["grader_error"]), taskIdentity: "task@2" }
		expect(() => mergeModelCalibration(report(), [], observed)).toThrow(/task identity/i)
	})

	it("validates individual delivery statuses before dropping an under-five capability arm", () => {
		const incoming = trials("luna-high", "new").slice(0, 2)
		incoming[0]!.passed = false
		incoming[1]!.passed = true
		expect(() => mergeModelCalibration(report(), incoming, delivery(["passed", "outcome_failed"]))).toThrow(
			/statuses must match/i,
		)
	})

	it("drops stale delivery from a trials-only replacement while preserving the other model arm", () => {
		const measured = mergeModelCalibration(report(), trials("luna-high", "new"), delivery(Array(5).fill("passed")))
		const replaced = mergeModelCalibration(measured, trials("luna-high", "next"))
		expect(replaced.modelDelivery).toBeUndefined()
		const otherArm = mergeModelCalibration(measured, trials("sol-high", "other"))
		expect(otherArm.modelDelivery).toEqual(measured.modelDelivery)
	})
})
