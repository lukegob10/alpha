import { describe, expect, it } from "vitest"
import { exportHostCampaign, immutableIdentity, reportCampaignPair, declareCampaignPair, type PairKey } from "../index"

const digest = (value: string) => `sha256:${value.repeat(64)}`
function campaign() {
	return {
		version: 1,
		id: "host-run",
		mode: "report-only",
		stopReason: "completed",
		repairs: [],
		requestedProvider: { mode: "scripted" },
		retention: { status: "complete" },
		evaluationPlan: { scenarioIds: ["cancel"], hostVersions: ["1.122.1"], samples: 1 },
		evaluationIdentity: {
			extensionCommit: "alpha-source-not-fixture",
			workingTreeDigest: digest("a"),
			extensionBuildDigest: digest("b"),
			harnessDigest: digest("c"),
			configDigest: digest("d"),
			taskSetDigest: digest("e"),
			sourceComponentsDigest: digest("f"),
			unchanged: true,
			missing: [],
		},
		attempts: [
			{
				request: {
					campaignId: "host-run",
					provider: { mode: "scripted" },
					scenarioId: "cancel",
					sample: 1,
					phase: "sample",
					host: { version: "1.122.1" },
				},
				result: {
					failure: undefined as { class: string } | undefined,
					status: "passed",
					actualHostVersion: "1.122.1",
					usage: { cost: null, inputTokens: null, outputTokens: null },
				},
				elapsedMs: 23,
				evidence: "attempt-1/manifest.json",
			},
		],
	}
}

describe("actual host campaign to paired report", () => {
	it("joins actual host build receipts to immutable observations and preserves unknown usage", () => {
		const baseline = campaign()
		const changed = campaign()
		changed.id = "candidate"
		changed.attempts[0]!.request.campaignId = "candidate"
		changed.evaluationIdentity.extensionBuildDigest = digest("1")
		changed.attempts[0]!.result.status = "failed"
		changed.attempts[0]!.result.failure = { class: "assertion" }
		const control = exportHostCampaign(baseline, { timeWindow: "predeclared-block-1" })
		const candidate = exportHostCampaign(changed, { timeWindow: "predeclared-block-1" })
		const declared = declareCampaignPair(control, candidate, {
			id: "declaration",
			template: "harness_only",
			independentUnit: "task",
			allowedDifferenceFields: ["extensionBuildDigest"],
		})
		expect(reportCampaignPair(control, candidate, declared).pairCount).toBe(1)
		expect(() =>
			declareCampaignPair(control, candidate, {
				id: "bad",
				template: "harness_only",
				independentUnit: "task",
				allowedDifferenceFields: ["guessed-field"],
			}),
		).toThrow()
		expect(control.variant?.extensionCommit).toBe("alpha-source-not-fixture")
		expect(control.observations[0]).toMatchObject({
			cost: null,
			tokens: null,
			firstAttemptStatus: "passed",
			retryAssisted: false,
		})
		const pairs: PairKey[] = control.observations.map(
			({
				taskId,
				taskVersion,
				seed,
				repetition,
				resourceProfileDigest,
				permissionDigest,
				networkMode,
				retryPolicyDigest,
				timeWindow,
			}) => ({
				taskId,
				taskVersion,
				seed,
				repetition,
				resourceProfileDigest,
				permissionDigest,
				networkMode,
				retryPolicyDigest,
				timeWindow,
			}),
		)
		const report = reportCampaignPair(control, candidate, {
			schemaVersion: 1,
			id: "host-pair",
			template: "harness_only",
			taskSetIdentity: immutableIdentity(control.taskSet),
			controlVariantIdentity: immutableIdentity(control.variant!),
			candidateVariantIdentity: immutableIdentity(candidate.variant!),
			pairs,
			allowedDifferenceFields: ["extensionBuildDigest"],
			independentUnit: "task",
		})
		expect(report.candidate.overall.uncertainty).toMatchObject({ pairedDelta: -1, pairedClusters: 1 })
		expect(report.candidate.overall.costPerSuccess).toBeNull()
		expect(report.producerEvidence).toMatchObject({
			executionFidelity: "actual-host",
			decisionSource: "scripted",
			identityScope: "conservative-whole-source",
		})
	})

	it("rejects missing or changed build evidence, repairs and wrong actual host", () => {
		const value = campaign()
		expect(() => exportHostCampaign({ ...value, evaluationIdentity: undefined }, { timeWindow: "block" })).toThrow()
		expect(() =>
			exportHostCampaign(
				{ ...value, evaluationIdentity: { ...value.evaluationIdentity, unchanged: false } },
				{ timeWindow: "block" },
			),
		).toThrow()
		expect(() => exportHostCampaign({ ...value, mode: "reviewed-patch" }, { timeWindow: "block" })).toThrow()
		value.attempts[0]!.result.actualHostVersion = "1.136.1"
		expect(() => exportHostCampaign(value, { timeWindow: "block" })).toThrow("actual host")
	})

	it("requires actual live model selection and does not count reproduction as independent sample", () => {
		const value = campaign()
		value.attempts.push({ ...value.attempts[0]!, request: { ...value.attempts[0]!.request, phase: "reproduce" } })
		expect(exportHostCampaign(value, { timeWindow: "block" }).observations).toHaveLength(1)
		expect(exportHostCampaign(value, { timeWindow: "block" }).accounting).toEqual({
			totalAttempts: 2,
			scoredSamples: 1,
			diagnosticAttempts: 1,
			totalCost: null,
		})
		const live = { mode: "live-copilot", modelId: "model", effort: "high" }
		expect(() =>
			exportHostCampaign(
				{
					...value,
					requestedProvider: live,
					attempts: value.attempts.map((attempt) => ({
						...attempt,
						request: { ...attempt.request, provider: live },
					})),
				},
				{ timeWindow: "block" },
			),
		).toThrow("actual model")
	})
	it("rejects missing scheduled cells, duplicates, foreign requests and incomplete retention", () => {
		const value = campaign()
		expect(() =>
			exportHostCampaign(
				{
					...value,
					attempts: value.attempts.map((attempt) => ({
						...attempt,
						result: { ...attempt.result, failure: { class: "tool" } },
					})),
				},
				{ timeWindow: "block" },
			),
		).toThrow("contradicts")
		expect(() =>
			exportHostCampaign(
				{
					...value,
					attempts: value.attempts.map((attempt) => ({
						...attempt,
						result: { ...attempt.result, retentionFailed: true },
					})),
				},
				{ timeWindow: "block" },
			),
		).toThrow()
		expect(() =>
			exportHostCampaign(
				{ ...value, evaluationPlan: { ...value.evaluationPlan, samples: 2 } },
				{ timeWindow: "block" },
			),
		).toThrow("matrix")
		expect(() =>
			exportHostCampaign({ ...value, attempts: [...value.attempts, ...value.attempts] }, { timeWindow: "block" }),
		).toThrow("matrix")
		expect(() =>
			exportHostCampaign({ ...value, retention: { status: "failed" } }, { timeWindow: "block" }),
		).toThrow()
		value.attempts[0]!.request.campaignId = "foreign"
		expect(() => exportHostCampaign(value, { timeWindow: "block" })).toThrow("provenance")
	})
	it("rejects missing and unknown failure classifications rather than changing the scored denominator", () => {
		const value = campaign()
		value.attempts[0]!.result.status = "failed"
		expect(() => exportHostCampaign(value, { timeWindow: "block" })).toThrow("classification")
		value.attempts[0]!.result.status = "blocked"
		value.attempts[0]!.result.failure = { class: "unknown-failure" }
		expect(() => exportHostCampaign(value, { timeWindow: "block" })).toThrow()
	})
})
