import { describe, expect, it } from "vitest"

import type { CalibrationReport } from "../contracts"
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
		expect(() => validateReviewSample(reports, first)).not.toThrow()
		reports[0]!.humanReview.reviewedTrialIds = []
		expect(() => validateReviewSample(reports, first)).toThrow("incomplete")
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
})
