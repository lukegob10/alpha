import { describe, expect, it } from "vitest"
import { assertCompleteRun, assertRunAcceptance, summarizeRunOutcomes, type RunTaskOutcome } from "../runResult"
import type { TrialTerminalStatus } from "../types"

const task = (id: number, status: TrialTerminalStatus): RunTaskOutcome => ({
	id,
	finishedAt: new Date(0),
	trial: { status, finishedAt: new Date(0), attempts: [{ terminalStatus: status }] },
})

describe("evaluation run acceptance", () => {
	it("keeps scored failures distinct from invalid infrastructure and graders", () => {
		const summary = summarizeRunOutcomes([
			task(1, "passed"),
			task(2, "outcome_failed"),
			task(3, "infrastructure_error"),
			task(4, "grader_error"),
		])
		expect(summary).toMatchObject({ total: 4, invalid: 2, incompleteTaskIds: [] })
		expect(summary.counts).toMatchObject({ passed: 1, outcome_failed: 1, infrastructure_error: 1, grader_error: 1 })
		expect(() => assertCompleteRun(summary)).not.toThrow()
		expect(() => assertRunAcceptance(summary, { minimumPassRate: 0 })).toThrow("acceptance failed")
	})

	it.each(["missing-trial", "running-trial", "unfinished-task", "active-attempt"])(
		"rejects %s even when a legacy score or timestamp suggests completion",
		(kind) => {
			const incomplete = task(2, "passed")
			if (kind === "missing-trial") incomplete.trial = undefined
			if (kind === "running-trial") incomplete.trial!.status = "running"
			if (kind === "unfinished-task") incomplete.finishedAt = null
			if (kind === "active-attempt") incomplete.trial!.attempts.push({ terminalStatus: null })
			const summary = summarizeRunOutcomes([task(1, "passed"), incomplete])
			expect(summary.incompleteTaskIds).toEqual([2])
			expect(() => assertCompleteRun(summary)).toThrow("incomplete: 2")
		},
	)

	it("applies an explicit CI quality threshold without erasing ordinary scored failures", () => {
		const summary = summarizeRunOutcomes([task(1, "passed"), task(2, "outcome_failed")])
		expect(() => assertRunAcceptance(summary, { minimumPassRate: 0.5 })).not.toThrow()
		expect(() => assertRunAcceptance(summary, { minimumPassRate: 1 })).toThrow("acceptance failed")
		expect(() => assertRunAcceptance(summarizeRunOutcomes([]), { minimumPassRate: 0 })).toThrow("no tasks")
	})

	it("does not accept a passing benchmark projection until its evidence is sealed", () => {
		const passing = { ...task(1, "passed"), benchmarkTaskIdentity: "fixture@1" }
		const missing = summarizeRunOutcomes([passing])
		expect(missing).toMatchObject({ invalid: 1, counts: { passed: 1 }, invalidEvidenceTaskIds: [1] })
		expect(() => assertRunAcceptance(missing, { minimumPassRate: 1 })).toThrow("acceptance failed")
		Object.assign(passing.trial!.attempts[0]!, {
			evidenceStatus: "valid",
			evidenceBundleDigest: `sha256:${"a".repeat(64)}`,
		})
		expect(summarizeRunOutcomes([passing]).invalid).toBe(0)
	})
})
