import { describe, expect, it } from "vitest"
import { canonicalJson, sha256 } from "../../evidence/canonical"
import {
	boundedPairedMean95,
	evaluateExperimentDecision,
	experimentDecisionPlanSchema,
	pairTrials,
	summarizeExperiment,
	trialPerformanceSchema,
	type TrialObservation,
} from "../index"

const digest = `sha256:${"a".repeat(64)}`
const plan = experimentDecisionPlanSchema.parse({
	id: "declared-release-comparison",
	declaredAt: "2026-10-01T00:00:00.000Z",
	claim: "fixed-system-paired-outcome",
	population: "Declared isolated editing tasks",
	taskSetIdentity: "tasks@1:declared-frame",
	controlRunId: "control-run",
	candidateRunId: "candidate-run",
	sampling: "independent-units",
	objective: "improvement",
	margin: 0,
	independentUnit: "task",
	weights: "equal-independent-unit",
	exclusionRule: "paired-scoreable",
	decisionSchedule: "fixed-final",
	confidence: 0.95,
	minimumIndependentUnits: 20,
	plannedPairs: 20,
	minimumPairedCoverage: 1,
	maximumIntervalWidth: 1,
	requiredFamilies: ["editing"],
	timeBlocks: [{ id: "same-day-block", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-02T00:00:00.000Z" }],
	resourceProtocolDigest: digest,
	cacheProtocolDigest: digest,
})
const decisionContext = { taskSetIdentity: plan.taskSetIdentity }

function observations(status: TrialObservation["status"], count = 20): TrialObservation[] {
	return Array.from({ length: count }, (_, index) => ({
		taskId: `task-${index}`,
		taskVersion: 1,
		seed: 0,
		repetition: 0,
		resourceProfileDigest: digest,
		permissionDigest: digest,
		networkMode: "offline",
		retryPolicyDigest: digest,
		timeWindow: "same-day-block",
		capturedTimeWindow: "same-day-block",
		variantIdentity: status,
		runId: status === "outcome_failed" ? "control-run" : "candidate-run",
		status,
		firstAttemptStatus: status,
		retryAssisted: false,
		cost: null,
		latencyMs: 100,
		capabilities: ["edit"],
		risk: "medium",
		family: "editing",
		difficulty: "foundation",
		decisionPlanDigest: sha256(canonicalJson(plan)),
		startedAt: "2026-10-01T01:00:00.000Z",
	}))
}

describe("predeclared paired decisions", () => {
	it("keeps historical observations descriptive and refuses empirical certainty from a single unit", () => {
		const pairs = pairTrials(observations("passed", 1), observations("passed", 1))
		const statistics = summarizeExperiment(
			pairs.map(({ candidate }) => candidate),
			pairs,
		)
		expect(statistics.uncertainty?.pairedBootstrap95).toEqual([0, 0])
		expect(statistics.uncertainty?.pairedBounds95).toEqual([-1, 1])
		expect(evaluateExperimentDecision(undefined, statistics, pairs, decisionContext).status).toBe("inconclusive")
		expect(evaluateExperimentDecision(plan, statistics, pairs, decisionContext)).toMatchObject({
			status: "inconclusive",
		})
	})

	it("accepts only a captured plan with its independent coverage and precision requirements", () => {
		const pairs = pairTrials(observations("outcome_failed"), observations("passed"))
		const statistics = summarizeExperiment(
			pairs.map(({ candidate }) => candidate),
			pairs,
		)
		expect(evaluateExperimentDecision(plan, statistics, pairs, decisionContext).status).toBe("accepted")
		const late = pairs.map(({ key, control, candidate }) => ({
			key,
			control: { ...control, startedAt: "2026-09-01T00:00:00.000Z" },
			candidate,
		}))
		expect(evaluateExperimentDecision(plan, statistics, late, decisionContext).reasons).toContain(
			"Decision plan was not captured before every paired attempt",
		)
		const missing = pairs.map(({ key, control, candidate }) => ({
			key,
			control: { ...control, decisionPlanDigest: undefined },
			candidate,
		}))
		expect(evaluateExperimentDecision(plan, statistics, missing, decisionContext).status).toBe("inconclusive")
	})

	it("does not let repeated attempts or excluded infrastructure manufacture independent coverage", () => {
		const candidate = observations("passed").map((value, repetition) => ({ ...value, taskId: "same", repetition }))
		const control = candidate.map((value) => ({ ...value, status: "outcome_failed" as const }))
		const pairs = pairTrials(control, candidate)
		const statistics = summarizeExperiment(candidate, pairs)
		expect(statistics.uncertainty?.pairedClusters).toBe(1)
		expect(evaluateExperimentDecision(plan, statistics, pairs, decisionContext).status).toBe("inconclusive")
		const blocked = observations("passed").map((value, index) =>
			index ? value : { ...value, status: "infrastructure_error" as const },
		)
		const excludedPairs = pairTrials(observations("outcome_failed"), blocked)
		const excluded = summarizeExperiment(blocked, excludedPairs)
		expect(excluded.delivery).toMatchObject({ attempts: 20, successes: 19, rate: 0.95 })
		expect(excluded.denominators).toMatchObject({ conditionalOutcome: 19, delivery: 20, latency: 20 })
		expect(evaluateExperimentDecision(plan, excluded, excludedPairs, decisionContext).reasons).toContain(
			"Scoreable paired coverage is below the declared requirement",
		)
	})

	it("reports per-metric coverage and never adds reasoning tokens to output tokens", () => {
		const rows = observations("passed", 2)
		rows[0]!.performance = { outputTokens: 100, reasoningTokens: 40, cacheReadTokens: null, toolsMs: 0 }
		const statistics = summarizeExperiment(rows, [])
		expect(statistics.performance?.outputTokens).toMatchObject({ known: 1, missing: 1, p50: 100 })
		expect(statistics.performance?.reasoningTokens.p50).toBe(40)
		expect(statistics.performance?.cacheReadTokens).toMatchObject({ known: 0, missing: 2, p50: null })
		expect(statistics.performance?.toolsMs.p50).toBe(0)
		expect(() => trialPerformanceSchema.parse({ toolsMs: Number.NaN })).toThrow()
		expect(boundedPairedMean95([])).toBeNull()
		expect(() => boundedPairedMean95([2])).toThrow()
	})

	it("clusters related task families and requires the same declared sampling unit", () => {
		const control = observations("outcome_failed")
		const candidate = observations("passed")
		const pairs = pairTrials(control, candidate)
		const statistics = summarizeExperiment(candidate, pairs, { independentUnit: "family" })
		expect(statistics.uncertainty?.pairedClusters).toBe(1)
		expect(evaluateExperimentDecision(plan, statistics, pairs, decisionContext).reasons).toContain(
			"Independent sampling unit differs from the declared decision plan",
		)
	})

	it("requires pre-run time blocks and timestamps within their declared half-open boundaries", () => {
		expect(() =>
			experimentDecisionPlanSchema.parse({ ...plan, timeBlocks: [...plan.timeBlocks, ...plan.timeBlocks] }),
		).toThrow("Time block IDs must be unique")
		const pairs = pairTrials(observations("outcome_failed"), observations("passed"))
		const statistics = summarizeExperiment(
			pairs.map(({ candidate }) => candidate),
			pairs,
		)
		for (const override of [
			{ capturedTimeWindow: undefined },
			{ capturedTimeWindow: "posthoc-label" },
			{ startedAt: "2026-10-02T00:00:00.000Z" },
			{ startedAt: "2026-10-03T00:00:00.000Z" },
		]) {
			const altered = pairs.map(({ key, control, candidate }) => ({
				key,
				control,
				candidate: { ...candidate, ...override },
			}))
			expect(evaluateExperimentDecision(plan, statistics, altered, decisionContext).status).toBe("inconclusive")
		}
		const beginning = pairs.map(({ key, control, candidate }) => ({
			key,
			control,
			candidate: { ...candidate, startedAt: plan.timeBlocks[0]!.startsAt },
		}))
		expect(evaluateExperimentDecision(plan, statistics, beginning, decisionContext).status).toBe("accepted")
	})

	it("binds the final decision to the predeclared sampling frame and arm run identities", () => {
		const pairs = pairTrials(observations("outcome_failed"), observations("passed"))
		const statistics = summarizeExperiment(
			pairs.map(({ candidate }) => candidate),
			pairs,
		)
		expect(evaluateExperimentDecision(plan, statistics, pairs, { taskSetIdentity: "different-frame" }).status).toBe(
			"inconclusive",
		)
		const rerun = pairs.map(({ key, control, candidate }) => ({
			key,
			control,
			candidate: { ...candidate, runId: "selected-rerun" },
		}))
		expect(evaluateExperimentDecision(plan, statistics, rerun, decisionContext).reasons).toContain(
			"Paired run identities differ from the predeclared runs",
		)
	})
})
