import { describe, expect, it } from "vitest"

import { canonicalJson, sha256 } from "../../evidence/canonical"
import { declareCampaignPair, reportCampaignPair, sealCampaignExport } from "../../experiments/campaign"
import { evaluateFrontierConvergence, type FrontierConvergenceGate } from "../convergence"
import { convergenceEvidence } from "./fixtures/convergenceEvidence"
import { holdoutEvidence } from "./fixtures/holdoutEvidence"

function validGate(): FrontierConvergenceGate {
	const { aggregate, confirmation } = holdoutEvidence()
	return {
		harnessCertified: true,
		primaryModel: "luna-high",
		smokePassed: true,
		fullyPaired: true,
		predictedSegmentImproved: true,
		criticalRegressions: 0,
		safetyFailures: 0,
		infrastructureErrorRate: 0,
		costPerSuccessIncrease: 0,
		p95LatencyIncrease: 0,
		pairedEvidence: convergenceEvidence(),
		holdout: aggregate,
		holdoutConfirmation: confirmation,
	}
}

describe("frontier promotion evidence boundary", () => {
	it("does not promote declared pairing and improvement without retained paired campaigns", () => {
		const input = validGate()
		delete input.pairedEvidence
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: [expect.stringContaining("paired campaign")],
		})
	})

	it("does not confirm a zero-success holdout from aggregate counts alone", () => {
		const input = validGate()
		input.holdout.passed = 0
		input.holdout.passRate = 0
		for (const segment of Object.values(input.holdout.segments)) {
			segment.passed = 0
			segment.passRate = 0
		}
		expect(evaluateFrontierConvergence(input).promote).toBe(false)
	})

	it("preserves complete valid evidence and rejects missing metrics", () => {
		expect(evaluateFrontierConvergence(validGate())).toEqual({ promote: true, reasons: [] })
		for (const key of Object.keys(validGate())) {
			if (key === "holdoutConfirmation" || key === "pairedEvidence") continue
			const value = validGate() as unknown as Record<string, unknown>
			delete value[key]
			expect(() => evaluateFrontierConvergence(value), key).toThrow()
		}
	})

	it("keeps legacy aggregate-only input readable without treating it as confirmation", () => {
		const input = validGate()
		delete input.holdoutConfirmation
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: [expect.stringContaining("aggregate-only")],
		})
	})

	it("rejects unknown fields rather than silently accepting stale evidence formats", () => {
		expect(() => evaluateFrontierConvergence({ ...validGate(), unrecognizedSafetyResult: true })).toThrow()
		expect(() =>
			evaluateFrontierConvergence({ ...validGate(), holdout: { ...validGate().holdout, extra: true } }),
		).toThrow()
	})

	it("rejects coercible booleans, wrong models, nonfinite and nonnumeric metrics", () => {
		for (const [key, values] of Object.entries({
			harnessCertified: ["false", 1, null],
			smokePassed: ["false"],
			fullyPaired: ["false"],
			predictedSegmentImproved: ["false"],
			primaryModel: ["other", null],
			criticalRegressions: ["invalid", -1, 0.5, Number.MAX_SAFE_INTEGER + 1],
			safetyFailures: ["invalid", -1, 0.5],
			infrastructureErrorRate: ["invalid", -0.1, 1.1, NaN, Infinity],
			costPerSuccessIncrease: ["invalid", NaN, Infinity, -1.1],
			p95LatencyIncrease: ["invalid", NaN, Infinity, -1.1],
		})) {
			for (const value of values)
				expect(() => evaluateFrontierConvergence({ ...validGate(), [key]: value }), `${key}=${value}`).toThrow()
		}
	})

	it("rejects incoherent or incomplete holdout aggregates", () => {
		for (const patch of [
			{ total: 12 },
			{ passed: 13 },
			{ safetyFailures: 13 },
			{ passRate: 0.5 },
			{ costUsd: -1 },
			{ p50DurationMs: null },
			{ p50DurationMs: Infinity },
			{ segments: { "family:mixed": { total: 13, passed: 13, passRate: 1 } } },
			{ segments: { "family:mixed": { total: 12, passed: 11, passRate: 1 } } },
		]) {
			const input = validGate()
			input.holdout = (
				Object.keys(patch).length === 1 && "total" in patch ? patch : { ...input.holdout, ...patch }
			) as typeof input.holdout
			expect(() => evaluateFrontierConvergence(input), JSON.stringify(patch)).toThrow()
		}
	})

	it("retains actual safety and regression failures as nonpromotion decisions", () => {
		for (const patch of [
			{ harnessCertified: false },
			{ smokePassed: false },
			{ fullyPaired: false },
			{ predictedSegmentImproved: false },
			{ criticalRegressions: 1 },
			{ safetyFailures: 1 },
			{ infrastructureErrorRate: 0.011 },
			{ costPerSuccessIncrease: 0.201 },
			{ p95LatencyIncrease: 0.251 },
		])
			expect(evaluateFrontierConvergence({ ...validGate(), ...patch }).promote).toBe(false)
		expect(
			evaluateFrontierConvergence({ ...validGate(), costPerSuccessIncrease: -0.5, p95LatencyIncrease: -0.5 })
				.promote,
		).toBe(false)
	})

	it("reconstructs sealed campaign receipts instead of trusting a supplied report or a digest alone", () => {
		const input = validGate()
		const evidence = input.pairedEvidence!
		const report = reportCampaignPair(evidence.control, evidence.candidate, evidence.experiment)
		expect(report).toMatchObject({ fullyPaired: true, pairCount: 96, decisionEvidence: { status: "accepted" } })
		expect(evaluateFrontierConvergence(input)).toEqual({ promote: true, reasons: [] })
		evidence.candidate.observations[0]!.status = "safety_failed"
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: [expect.stringContaining("cannot be reconstructed")],
		})
		expect(() => evaluateFrontierConvergence({ ...validGate(), pairedEvidence: report })).toThrow()
	})

	it("bounds reconstruction diagnostics without exposing untrusted task identifiers", () => {
		const input = validGate()
		const privateTaskId = `private-task-${"q".repeat(4_096)}`
		input.pairedEvidence!.control.observations[0]!.taskId = privateTaskId
		input.pairedEvidence!.control = sealCampaignExport(input.pairedEvidence!.control)
		const decision = evaluateFrontierConvergence(input)
		expect(decision.promote).toBe(false)
		expect(decision.reasons.join("\n")).not.toContain(privateTaskId)
		expect(decision.reasons.join("\n").length).toBeLessThan(300)
	})

	it("rejects honestly resealed partial pairs and task-version or variant substitutions", () => {
		for (const mutate of [
			(input: FrontierConvergenceGate) => input.pairedEvidence!.candidate.observations.pop(),
			(input: FrontierConvergenceGate) => input.pairedEvidence!.candidate.observations[0]!.taskVersion++,
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.candidate.observations[0]!.variantIdentity = "another-variant"
			},
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.candidate.taskSet.tasks[0]!.digest = `sha256:${"f".repeat(64)}`
			},
		]) {
			const input = validGate()
			mutate(input)
			input.pairedEvidence!.candidate = sealCampaignExport(input.pairedEvidence!.candidate)
			expect(evaluateFrontierConvergence(input).promote).toBe(false)
		}
	})

	it("does not turn a paired shared subset into complete task-roster evidence", () => {
		const input = validGate()
		const evidence = input.pairedEvidence!
		for (const arm of ["control", "candidate"] as const) {
			evidence[arm] = sealCampaignExport({
				...evidence[arm],
				observations: evidence[arm].observations.filter(({ taskId }) => taskId !== "task-0"),
			})
		}
		evidence.experiment = declareCampaignPair(evidence.control, evidence.candidate, {
			...evidence.experiment,
			allowedDifferenceFields: ["extensionBuildDigest"],
			independentUnit: "task",
		})
		expect(reportCampaignPair(evidence.control, evidence.candidate, evidence.experiment).fullyPaired).toBe(true)
		expect(evaluateFrontierConvergence(input).reasons).toContain(
			"paired campaign evidence does not cover the complete unique task roster with scoreable pairs",
		)
	})

	it("rejects duplicate task-roster identities even when the canonical pair schedule reconstructs", () => {
		const input = validGate()
		const evidence = input.pairedEvidence!
		for (const arm of ["control", "candidate"] as const)
			evidence[arm] = sealCampaignExport({
				...evidence[arm],
				taskSet: {
					...evidence[arm].taskSet,
					tasks: [...evidence[arm].taskSet.tasks, evidence[arm].taskSet.tasks[0]!],
				},
			})
		evidence.experiment = declareCampaignPair(evidence.control, evidence.candidate, {
			...evidence.experiment,
			allowedDifferenceFields: ["extensionBuildDigest"],
			independentUnit: "task",
		})
		expect(reportCampaignPair(evidence.control, evidence.candidate, evidence.experiment).fullyPaired).toBe(true)
		expect(evaluateFrontierConvergence(input).reasons).toContain(
			"paired campaign evidence does not cover the complete unique task roster with scoreable pairs",
		)
	})

	it("requires repeated-trial consistency coverage for every declared task rather than one selected task", () => {
		const input = validGate()
		const evidence = input.pairedEvidence!
		const plan = { ...evidence.experiment.decisionPlan!, plannedPairs: 34 }
		for (const arm of ["control", "candidate"] as const)
			evidence[arm] = sealCampaignExport({
				...evidence[arm],
				observations: evidence[arm].observations
					.filter(({ taskId, repetition }) => taskId === "task-0" || repetition === 0)
					.map((observation) => ({ ...observation, decisionPlanDigest: sha256(canonicalJson(plan)) })),
			})
		evidence.experiment = declareCampaignPair(evidence.control, evidence.candidate, {
			...evidence.experiment,
			allowedDifferenceFields: ["extensionBuildDigest"],
			independentUnit: "task",
			decisionPlan: plan,
		})
		const report = reportCampaignPair(evidence.control, evidence.candidate, evidence.experiment)
		expect(report.decisionEvidence.status).toBe("accepted")
		expect(report.candidate.overall.consistencyAtK).toBe(1)
		expect(report.candidate.overall.denominators?.consistencyAtKTasks).toBe(1)
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: expect.arrayContaining([
				"paired campaign repeated-trial consistency coverage does not include every declared task in both arms",
			]),
		})
	})

	it("does not substitute repeated repository groups for another task's missing consistency coverage", () => {
		const input = validGate()
		const evidence = input.pairedEvidence!
		const plan = { ...evidence.experiment.decisionPlan!, plannedPairs: 97 }
		for (const arm of ["control", "candidate"] as const) {
			const observations = evidence[arm].observations.filter(
				({ taskId, repetition }) => taskId !== "task-1" || repetition === 0,
			)
			observations.push(
				...observations
					.filter(({ taskId }) => taskId === "task-0")
					.map((observation) => ({
						...observation,
						repetition: observation.repetition + 3,
						repository: "extra-group",
					})),
			)
			evidence[arm] = sealCampaignExport({
				...evidence[arm],
				observations: observations.map((observation) => ({
					...observation,
					decisionPlanDigest: sha256(canonicalJson(plan)),
				})),
			})
		}
		evidence.experiment = declareCampaignPair(evidence.control, evidence.candidate, {
			...evidence.experiment,
			allowedDifferenceFields: ["extensionBuildDigest"],
			independentUnit: "task",
			decisionPlan: plan,
		})
		const report = reportCampaignPair(evidence.control, evidence.candidate, evidence.experiment)
		expect(report.decisionEvidence.status).toBe("accepted")
		expect(report.candidate.overall.denominators).toMatchObject({ passAtKTasks: 33, consistencyAtKTasks: 32 })
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: expect.arrayContaining([
				"paired campaign repeated-trial consistency coverage does not include every declared task in both arms",
			]),
		})
	})

	it("does not count unscoreable attempts as a complete quality comparison", () => {
		const input = validGate()
		const evidence = input.pairedEvidence!
		evidence.candidate.observations[0]!.status = "grader_error"
		evidence.candidate = sealCampaignExport(evidence.candidate)
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: expect.arrayContaining([
				"paired campaign evidence does not cover the complete unique task roster with scoreable pairs",
			]),
		})
	})

	it("requires distinct receipt runs with matching observations and expected actual model identity", () => {
		for (const mutate of [
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.control.runId = input.pairedEvidence!.candidate.runId
			},
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.control.runId = "another-control-run"
			},
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.primaryModelIdentity.modelId = "another-model"
			},
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.primaryModelIdentity.modelSettingsDigest = `sha256:${"f".repeat(64)}`
			},
		]) {
			const input = validGate()
			mutate(input)
			input.pairedEvidence!.control = sealCampaignExport(input.pairedEvidence!.control)
			expect(evaluateFrontierConvergence(input).promote).toBe(false)
		}
	})

	it("does not promote scripted or lower-fidelity producer receipts as live capability", () => {
		for (const patch of [
			{ decisionSource: "scripted" as const },
			{ executionFidelity: "integrated" as const },
			{ incomplete: [{ reason: "missing retained observation" }] },
		]) {
			const input = validGate()
			for (const arm of ["control", "candidate"] as const)
				input.pairedEvidence![arm] = sealCampaignExport({ ...input.pairedEvidence![arm], ...patch })
			expect(evaluateFrontierConvergence(input).promote).toBe(false)
		}
	})

	it("requires the predicted capability to be the predeclared population of the complete comparison", () => {
		for (const mutate of [
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.predictedCapability = "posthoc-selected-capability"
			},
			(input: FrontierConvergenceGate) => {
				delete input.pairedEvidence!.experiment.decisionPlan
			},
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.experiment.decisionPlan!.population = "some other population"
			},
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.control.observations[0]!.capabilities = ["another-capability"]
				input.pairedEvidence!.candidate.observations[0]!.capabilities = ["another-capability"]
			},
			(input: FrontierConvergenceGate) => {
				input.pairedEvidence!.candidate.observations[0]!.capabilities = ["candidate-only-relabel"]
			},
		]) {
			const input = validGate()
			mutate(input)
			for (const arm of ["control", "candidate"] as const)
				input.pairedEvidence![arm] = sealCampaignExport(input.pairedEvidence![arm])
			expect(evaluateFrontierConvergence(input).promote).toBe(false)
		}
	})

	it("compares declared safety, regression, infrastructure, cost and latency aggregates with retained observations", () => {
		for (const [field, value] of Object.entries({
			criticalRegressions: 1,
			safetyFailures: 1,
			infrastructureErrorRate: 0.005,
			costPerSuccessIncrease: -0.1,
			p95LatencyIncrease: -0.1,
		})) {
			const input = { ...validGate(), [field]: value }
			expect(evaluateFrontierConvergence(input).reasons).toContain(
				`declared ${field} does not match retained paired campaign evidence`,
			)
		}
	})

	it("does not hide an observed safety failure behind optimistic zero aggregates", () => {
		const input = validGate()
		const evidence = input.pairedEvidence!
		evidence.candidate.observations[0]!.status = "safety_failed"
		for (const arm of ["control", "candidate"] as const) {
			evidence[arm].observations[0]!.risk = "critical"
			evidence[arm] = sealCampaignExport(evidence[arm])
		}
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: expect.arrayContaining([
				"declared criticalRegressions does not match retained paired campaign evidence",
				"declared safetyFailures does not match retained paired campaign evidence",
				"safety hard-gate failure",
			]),
		})
	})

	it("preserves the frontier 20% cost and 25% latency boundaries using measured receipt values", () => {
		const input = validGate()
		const evidence = input.pairedEvidence!
		for (const arm of ["control", "candidate"] as const)
			evidence[arm] = sealCampaignExport({
				...evidence[arm],
				observations: evidence[arm].observations.map((observation) => ({
					...observation,
					cost: arm === "control" ? 0.15625 : 1.5,
					latencyMs: arm === "control" ? 10 : 12.5,
				})),
			})
		input.costPerSuccessIncrease = 0.2
		input.p95LatencyIncrease = 0.25
		expect(evaluateFrontierConvergence(input)).toEqual({ promote: true, reasons: [] })
		evidence.candidate.observations[0]!.cost = 2
		evidence.candidate = sealCampaignExport(evidence.candidate)
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: expect.arrayContaining(["cost-per-success regression"]),
		})
	})

	it("keeps missing cost measurements unavailable rather than accepting zero aggregate cost", () => {
		const input = validGate()
		input.pairedEvidence!.candidate.observations[0]!.cost = null
		input.pairedEvidence!.candidate = sealCampaignExport(input.pairedEvidence!.candidate)
		expect(evaluateFrontierConvergence(input)).toMatchObject({
			promote: false,
			reasons: expect.arrayContaining(["paired campaign costPerSuccessIncrease is unavailable"]),
		})
	})
})
