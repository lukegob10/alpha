import { describe, expect, it } from "vitest"

import {
	bootstrapMean95,
	buildPairedExperimentReport,
	diffVariants,
	evaluatePromotion,
	experimentManifestSchema,
	experimentVariantSchema,
	assertPairCompatible,
	immutableIdentity,
	pairTrials,
	passAtK,
	POLICIES,
	quantile,
	summarizeExperiment,
	segmentExperiment,
	validateTemplateDiff,
	type ExperimentStatistics,
	type ExperimentVariant,
	type PairKey,
	type TrialObservation,
} from "../index"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const key: PairKey = {
	taskId: "task",
	taskVersion: 1,
	seed: 7,
	repetition: 0,
	resourceProfileDigest: digest("a"),
	permissionDigest: digest("b"),
	networkMode: "disabled",
	retryPolicyDigest: digest("c"),
	timeWindow: "2026-07-12T22:00Z",
}

function observation(overrides: Partial<TrialObservation> = {}): TrialObservation {
	return {
		...key,
		variantIdentity: "variant",
		status: "passed",
		firstAttemptStatus: "passed",
		retryAssisted: false,
		cost: 2,
		latencyMs: 100,
		capabilities: ["editing"],
		risk: "medium",
		family: "real-repository",
		difficulty: "challenging",
		...overrides,
	}
}

const variant: ExperimentVariant = {
	schemaVersion: 1,
	id: "variant",
	extensionCommit: "abc",
	workingTreeDigest: digest("1"),
	extensionBuildDigest: digest("2"),
	model: "model-a",
	modelSettingsDigest: digest("3"),
	promptDigest: digest("4"),
	toolSchemaDigest: digest("5"),
	toolImplementationDigest: digest("6"),
	skillBundleDigest: digest("7"),
	policyDigest: digest("8"),
	compactionDigest: digest("9"),
	runnerImageDigest: digest("a"),
	resourceProfileDigest: digest("b"),
	permissionDigest: digest("c"),
	networkMode: "disabled",
	retryPolicyDigest: digest("d"),
}

describe("immutable experiment manifests and pairing", () => {
	it("validates complete manifests and derives stable identities", () => {
		expect(experimentVariantSchema.parse(variant)).toEqual(variant)
		expect(immutableIdentity(variant)).toMatch(/^variant@1:sha256:/)
		expect(() => experimentVariantSchema.parse({ ...variant, promptDigest: "mutable" })).toThrow()
		expect(
			experimentManifestSchema.parse({
				schemaVersion: 1,
				id: "experiment",
				template: "harness_only",
				taskSetIdentity: "tasks@1",
				controlVariantIdentity: "control@1",
				candidateVariantIdentity: "candidate@1",
				pairs: [key],
			}),
		).toBeTruthy()
	})

	it("pairs exact trials and rejects missing, duplicate, and mismatched keys", () => {
		const control = observation({ variantIdentity: "control" })
		const candidate = observation({ variantIdentity: "candidate" })
		expect(pairTrials([control], [candidate])).toHaveLength(1)
		expect(() => pairTrials([control], [])).toThrow("Missing candidate pair")
		expect(() => pairTrials([], [candidate])).toThrow("Unpaired candidate")
		expect(() => pairTrials([control], [candidate, candidate])).toThrow("duplicate")
		expect(() => assertPairCompatible(control, { ...candidate, seed: 99 })).toThrow("seed")
	})

	it.each([
		["taskId", "other"],
		["taskVersion", 2],
		["seed", 9],
		["repetition", 2],
		["resourceProfileDigest", digest("e")],
		["permissionDigest", digest("f")],
		["networkMode", "enabled"],
		["retryPolicyDigest", digest("0")],
		["timeWindow", "other"],
	] as const)("rejects pair mismatch in %s", (field, value) => {
		const control = observation({ variantIdentity: "control" })
		const candidate = observation({ variantIdentity: "candidate", [field]: value })
		expect(() => pairTrials([control], [candidate])).toThrow()
	})
})

describe("variant confounder diff", () => {
	it("detects every material field and enforces experiment templates", () => {
		for (const field of Object.keys(variant) as (keyof ExperimentVariant)[]) {
			if (field === "schemaVersion") continue
			const candidate = {
				...variant,
				[field]: typeof variant[field] === "string" ? `${variant[field]}-changed` : variant[field],
			}
			expect(diffVariants(variant, candidate).map(({ field: changed }) => changed)).toContain(field)
		}
		const modelDiff = diffVariants(variant, { ...variant, model: "model-b" })
		expect(() => validateTemplateDiff("model_only", modelDiff)).not.toThrow()
		expect(() => validateTemplateDiff("harness_only", modelDiff)).toThrow("confounders")
		const harnessDiff = diffVariants(variant, { ...variant, promptDigest: digest("e") })
		expect(() => validateTemplateDiff("harness_only", harnessDiff)).not.toThrow()
		expect(() => validateTemplateDiff("model_only", harnessDiff)).toThrow("confounders")
		expect(() => validateTemplateDiff("model_only", [])).toThrow("identical")
	})
})

describe("reference statistics", () => {
	it("matches fixed vectors and excludes infrastructure/grader errors from outcomes", () => {
		const observations = [
			observation({ taskId: "a", repetition: 0, status: "passed", cost: 2, latencyMs: 100 }),
			observation({ taskId: "a", repetition: 1, status: "passed", cost: 2, latencyMs: 200 }),
			observation({ taskId: "a", repetition: 2, status: "outcome_failed", cost: 2, latencyMs: 300 }),
			observation({
				taskId: "b",
				repetition: 0,
				status: "infrastructure_error",
				firstAttemptStatus: "infrastructure_error",
				cost: 1,
				latencyMs: 400,
			}),
			observation({
				taskId: "b",
				repetition: 1,
				status: "grader_error",
				firstAttemptStatus: "grader_error",
				cost: 1,
				latencyMs: 500,
			}),
			observation({
				taskId: "b",
				repetition: 2,
				status: "agent_error",
				firstAttemptStatus: "agent_error",
				cost: 2,
				latencyMs: 600,
			}),
		]
		const pairs = pairTrials(
			[
				observation({ taskId: "p1", variantIdentity: "control", status: "outcome_failed" }),
				observation({ taskId: "p2", variantIdentity: "control" }),
			],
			[
				observation({ taskId: "p1", variantIdentity: "candidate" }),
				observation({ taskId: "p2", variantIdentity: "candidate", status: "outcome_failed" }),
			],
		)
		const report = summarizeExperiment(observations, pairs, {
			bootstrapSamples: 500,
			bootstrapSeed: 7,
			consistencyK: 3,
			passK: 2,
		})
		expect(report.outcome).toMatchObject({ successes: 2, failures: 2, excluded: 2, rate: 0.5 })
		expect(report.paired).toEqual({ wins: 1, losses: 1, ties: 0 })
		expect(report.infrastructureErrorRate).toBeCloseTo(1 / 6)
		expect(report.graderErrorRate).toBeCloseTo(1 / 6)
		expect(report.firstAttemptReliability).toBeCloseTo(0.5)
		expect(report.latencyMs).toEqual({ p50: 350, p95: 575 })
		expect(report.costPerSuccess).toBe(5)
		expect(report.outcome.bootstrap95).toEqual([0, 1])
		expect(report.consistencyAtK).toBe(0)
		expect(report.passAtK).toBeCloseTo(0.5)
		const segmented = segmentExperiment(observations, pairs, { bootstrapSamples: 10, consistencyK: 3 })
		expect(segmented.byCapability.editing!.outcome.excluded).toBe(2)
		expect(segmented.byRisk.medium).toBeTruthy()
		expect(segmented.byRisk.critical).toBeUndefined()
		expect(segmented.byFamily["real-repository"]?.outcome.successes).toBe(2)
		expect(segmented.byDifficulty.challenging?.outcome.successes).toBe(2)
		expect(segmented.byDifficulty.frontier).toBeUndefined()
	})

	it("builds a digest-bound, fully paired report and identifies high-risk regressions", () => {
		const controlVariant = { ...variant, id: "frontier-variant", workingTreeDigest: digest("1") }
		const candidateVariant = { ...controlVariant, workingTreeDigest: digest("f") }
		const controlIdentity = immutableIdentity(controlVariant)
		const candidateIdentity = immutableIdentity(candidateVariant)
		const taskSet = {
			schemaVersion: 1 as const,
			id: "frontier-tasks",
			version: 1,
			tasks: [{ id: "task", version: 1, digest: digest("e") }],
		}
		const context = {
			controlVariant,
			candidateVariant,
			taskSet,
			manifest: {
				schemaVersion: 1 as const,
				id: "frontier-pair",
				template: "harness_only" as const,
				taskSetIdentity: immutableIdentity(taskSet),
				controlVariantIdentity: controlIdentity,
				candidateVariantIdentity: candidateIdentity,
				pairs: [key],
				allowedDifferenceFields: ["workingTreeDigest" as const],
			},
		}
		const control = [observation({ variantIdentity: controlIdentity, risk: "high" })]
		const candidate = [observation({ variantIdentity: candidateIdentity, risk: "high", status: "safety_failed" })]
		const report = buildPairedExperimentReport(control, candidate, context)
		expect(report).toMatchObject({
			fullyPaired: true,
			pairCount: 1,
			safetyFailures: 1,
			highRiskRegressions: 1,
		})
		expect(report.digest).toMatch(/^sha256:/)
		expect(() => buildPairedExperimentReport(control, [{ ...candidate[0]!, seed: 99 }], context)).toThrow(
			"Missing candidate pair",
		)
		expect(() =>
			buildPairedExperimentReport(control, candidate, {
				...context,
				candidateVariant: { ...candidateVariant, model: "confounded-model" },
			}),
		).toThrow("identity")
		expect(() =>
			buildPairedExperimentReport(control, candidate, {
				...context,
				manifest: { ...context.manifest, allowedDifferenceFields: ["extensionBuildDigest"] },
			}),
		).toThrow("undeclared confounders")
	})

	it("handles quantile/bootstrap/pass@k edge vectors deterministically", () => {
		expect(quantile([], 0.5)).toBeNull()
		expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
		expect(() => quantile([1], 2)).toThrow()
		expect(bootstrapMean95([0, 1, 1], 100, 42)).toEqual(bootstrapMean95([0, 1, 1], 100, 42))
		expect(() => bootstrapMean95([], 1, 1)).toThrow()
		expect(() => bootstrapMean95([1], 0, 1)).toThrow()
		expect(passAtK([observation({ taskId: "single" })], 2)).toBeNull()
		const empty = summarizeExperiment([], [], {})
		expect(empty).toMatchObject({
			outcome: { successes: 0, failures: 0, excluded: 0, rate: null, bootstrap95: null },
			costPerSuccess: null,
			retryAssistedCapability: null,
			firstAttemptReliability: 0,
		})
		const ties = pairTrials(
			[observation({ variantIdentity: "control" })],
			[observation({ variantIdentity: "candidate" })],
		)
		expect(summarizeExperiment([observation()], ties, { consistencyK: 1 }).paired.ties).toBe(1)
		expect(summarizeExperiment([observation()], [], { consistencyK: 1 }).consistencyAtK).toBe(1)
	})
})

describe("promotion policy", () => {
	const statistics = (overrides: Partial<ExperimentStatistics> = {}): ExperimentStatistics => ({
		outcome: { successes: 10, failures: 0, excluded: 0, rate: 1, bootstrap95: [1, 1] },
		paired: { wins: 1, losses: 0, ties: 9 },
		consistencyAtK: 1,
		passAtK: 1,
		costPerSuccess: 1,
		latencyMs: { p50: 100, p95: 100 },
		infrastructureErrorRate: 0,
		graderErrorRate: 0,
		firstAttemptReliability: 1,
		retryAssistedCapability: 1,
		...overrides,
	})

	it("allows a certified paired improvement and blocks every hard gate", () => {
		const base = {
			policy: POLICIES["pr-v1"],
			candidate: statistics(),
			control: statistics(),
			safetyFailures: 0,
			highRiskRegressions: 0,
			certified: true,
			paired: true,
		}
		expect(evaluatePromotion(base)).toEqual({ allowed: true, reasons: [] })
		const blocked = evaluatePromotion({
			...base,
			candidate: statistics({
				consistencyAtK: 0.5,
				infrastructureErrorRate: 0.2,
				costPerSuccess: 2,
				latencyMs: { p50: 100, p95: 200 },
			}),
			safetyFailures: 1,
			highRiskRegressions: 1,
			certified: false,
			paired: false,
		})
		expect(blocked.allowed).toBe(false)
		expect(blocked.reasons).toHaveLength(8)
		const undefinedMetrics = evaluatePromotion({
			...base,
			candidate: statistics({ consistencyAtK: null, costPerSuccess: null, latencyMs: { p50: null, p95: null } }),
			control: statistics({ costPerSuccess: 0, latencyMs: { p50: 0, p95: 0 } }),
		})
		expect(undefinedMetrics.allowed).toBe(false)
		const zeroMetrics = evaluatePromotion({
			...base,
			candidate: statistics({ costPerSuccess: 0, latencyMs: { p50: 0, p95: 0 } }),
			control: statistics({ costPerSuccess: 0, latencyMs: { p50: 0, p95: 0 } }),
		})
		expect(zeroMetrics.allowed).toBe(true)
	})
})
