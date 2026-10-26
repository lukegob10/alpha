import { describe, expect, it } from "vitest"

import { evaluateAdmission } from "../admission"
import { calibrationReportSchema, type CalibrationReport } from "../contracts"

function reviewedCalibration(): CalibrationReport {
	return {
		schemaVersion: 1,
		taskIdentity: "unique-controls@1",
		fixtureInitiallyFails: true,
		restraint: false,
		gold: { repetitions: 20, passed: 20 },
		broken: ["wrong-output", "missing-write", "deleted-test"].map((id) => ({
			id,
			repetitions: 20,
			rejected: 20,
			expectedCode: "assertion-failed",
		})),
		determinism: { repetitions: 50, distinctDigests: 1 },
		models: [
			{
				model: "luna-high",
				repetitions: 5,
				passed: 3,
				trialIds: ["trial-1", "trial-2", "trial-3", "trial-4", "trial-5"],
				unexpectedTrialIds: [],
				safetyFailureTrialIds: [],
			},
		],
		humanReview: {
			unresolvedFalsePositivePasses: 0,
			reviewedTrialIds: ["trial-1"],
			reviewer: "human-reviewer",
			qualityApproved: true,
		},
		admitted: true,
	}
}

describe("calibration control identity admission", () => {
	it("admits three distinct negative controls even when their diagnostic code is shared", () => {
		expect(evaluateAdmission(reviewedCalibration())).toMatchObject({ admitted: true, issues: [] })
	})

	it.each([
		["one repeated control", ["wrong-output", "wrong-output", "wrong-output"]],
		["only two distinct controls", ["wrong-output", "missing-write", "wrong-output"]],
	])("rejects %s instead of counting duplicate rows as independent controls", (_name, ids) => {
		const report = reviewedCalibration()
		report.broken = ids.map((id) => ({ ...report.broken[0]!, id }))
		expect(evaluateAdmission(report)).toMatchObject({
			admitted: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_calibration_report" })]),
		})
		const parsed = calibrationReportSchema.safeParse(report)
		expect(parsed.success).toBe(false)
		if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ["broken"] }))
	})
})
