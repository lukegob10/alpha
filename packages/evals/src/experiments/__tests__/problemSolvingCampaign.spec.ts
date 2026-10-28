import { describe, expect, it } from "vitest"

import { canonicalJson, sha256 } from "../../evidence/canonical"
import { executedModelSettingsDigest, sealExecutedExperimentCapture } from "../../evidence/executedExperimentCapture"
import type { ExecutedExperimentCapture, ExecutedExperimentVariant } from "@alpha-code/types"
import { NATIVE_EXPERIMENT_CONDITION_SCOPES } from "@alpha-code/types"
import {
	exportProblemSolvingCampaign,
	parseProblemSolvingExperimentAssignment,
	sealProblemSolvingExperimentAssignment,
} from "../problemSolvingCampaign"
import { declareCampaignPair, parseCampaignExport, reportCampaignPair, sealCampaignExport } from "../campaign"
import { immutableIdentity } from "../identity"

const digest = (value: string) => "sha256:" + value.repeat(64)
const taskSet = {
	schemaVersion: 1 as const,
	id: "synthetic-source-frame",
	version: 1,
	tasks: [{ id: "synthetic-repair", version: 1, digest: digest("a") }],
}

function assignment(repetition = 0) {
	return sealProblemSolvingExperimentAssignment({
		schemaVersion: 1,
		runId: "synthetic-control",
		declaredAt: "2026-01-01T00:00:00.000Z",
		decisionPlanDigest: digest("b"),
		taskSet,
		pair: {
			taskId: "synthetic-repair",
			taskVersion: 1,
			seed: 0,
			repetition,
			resourceProfileDigest: digest("c"),
			permissionDigest: digest("d"),
			networkMode: "disabled",
			retryPolicyDigest: digest("e"),
			timeWindow: "synthetic-block",
		},
		task: {
			definitionDigest: digest("a"),
			fixtureDigest: digest("f"),
			family: "synthetic-repair",
			risk: "medium",
			difficulty: "challenging",
			capabilities: ["repair"],
		},
	})
}

function attempt(repetition = 0) {
	return {
		taskId: "synthetic-repair",
		taskVersion: 1,
		taskDigest: digest("f"),
		attemptId: `synthetic-attempt-${repetition}`,
		providerMode: "live-copilot" as const,
		model: { id: "synthetic-model", effort: "high" },
		status: "passed" as const,
		countsAsSolving: true,
		graderDecision: "passed" as const,
		failureClass: null,
		usage: { cost: null, inputTokens: 10, outputTokens: 2, requests: 1 },
		promptSha256: "4".repeat(64),
		startedAt: "2026-01-01T01:00:00.000Z",
		completedAt: "2026-01-01T01:00:01.000Z",
		elapsedMs: 1000,
		experimentAssignment: assignment(repetition),
	}
}

function input() {
	return { schemaVersion: 1, runId: "synthetic-control", taskSet, assignments: [assignment()], attempts: [attempt()] }
}

function completeCapture(): ExecutedExperimentCapture {
	const settings = executedModelSettingsDigest("synthetic-model", "high", digest("5"))
	const variant: ExecutedExperimentVariant = {
		schemaVersion: 1,
		id: "synthetic-harness",
		extensionCommit: "synthetic-source",
		workingTreeDigest: digest("0"),
		extensionBuildDigest: digest("1"),
		model: "synthetic-model",
		modelSettingsDigest: settings,
		promptDigest: digest("2"),
		toolSchemaDigest: digest("3"),
		toolImplementationDigest: digest("6"),
		skillBundleDigest: digest("7"),
		policyDigest: digest("8"),
		compactionDigest: digest("9"),
		runnerImageDigest: digest("a"),
		resourceProfileDigest: digest("c"),
		permissionDigest: digest("d"),
		networkMode: "disabled",
		retryPolicyDigest: digest("e"),
	}
	return sealExecutedExperimentCapture({
		schemaVersion: 1,
		kind: "alpha-executed-experiment-capture",
		status: "captured",
		producer: "native-extension-host",
		attemptId: "synthetic-attempt-0",
		assignmentDigest: assignment().digest,
		pairDigest: sha256(canonicalJson(assignment().pair)),
		task: { id: "synthetic-repair", version: 1, digest: digest("f") },
		taskLabelAuthority: "controller-public-task-label",
		capturedAt: "2026-01-01T01:00:00.900Z",
		observedVariant: variant,
		identityScope: "component",
		conditionScopes: NATIVE_EXPERIMENT_CONDITION_SCOPES,
		missing: [],
		measurementProvenance: Object.fromEntries(
			Object.keys(variant)
				.filter((field) => field !== "schemaVersion")
				.map((field) => [
					field,
					{ source: "synthetic-controlled-native-observer", digest: digest("a"), scope: "observed" as const },
				]),
		),
		observed: {
			requestCount: 1,
			model: variant.model,
			reasoningEffort: "high",
			modelSettingsDigest: settings,
			taskPromptDigest: digest("4"),
			extensionBuildDigest: variant.extensionBuildDigest,
		},
		requests: [
			{
				index: 0,
				startedAt: "2026-01-01T01:00:00.100Z",
				model: variant.model,
				reasoningEffort: "high",
				modelSettingsDigest: settings,
				messagesDigest: digest("b"),
				toolSchemaDigest: variant.toolSchemaDigest,
				optionsDigest: digest("5"),
			},
		],
		processCoverage: {
			sourceVersions: "unavailable",
			instructionDelivery: "complete",
			hookDelivery: "unavailable",
		},
		buildProvenance: { status: "unavailable", missing: ["synthetic-component-fixture-has-no-build-manifest"] },
	})
}

function completeInput() {
	const value = input()
	return { ...value, attempts: [{ ...value.attempts[0]!, experimentIdentity: completeCapture() }] }
}

describe("problem-solving experiment export", () => {
	it("exports exactly producer-observed identities and outcomes when complete synthetic receipts satisfy the contract", () => {
		const report = exportProblemSolvingCampaign(completeInput())
		expect(report.incomplete).toEqual([])
		expect(report.conditionIdentityScope).toBe("native-host-protocol-v1")
		expect(report.variant).toEqual(completeCapture().observedVariant)
		expect(report.observations).toHaveLength(1)
		expect(report.observations[0]).toMatchObject({
			taskId: "synthetic-repair",
			taskVersion: 1,
			status: "passed",
			latencyMs: 1000,
			cost: null,
			tokens: 12,
			decisionPlanDigest: digest("b"),
			startedAt: attempt().startedAt,
			capturedTimeWindow: "synthetic-block",
			runId: "synthetic-control",
		})
		expect(report.accounting).toMatchObject({
			totalAttempts: 1,
			scoredSamples: 1,
			diagnosticAttempts: 0,
			totalCost: null,
		})
	})

	it("seals explicit local-native isolation limits and cannot upgrade them from assertions", () => {
		const value = completeInput()
		const agentIsolation = {
			boundary: "trusted-local-native-host",
			privateAssetIsolation: "unestablished",
			osSandbox: false,
		}
		const report = exportProblemSolvingCampaign({ ...value, agentIsolation })
		expect(report.agentIsolation).toEqual(agentIsolation)
		expect(report.incomplete).toEqual([])
		expect(parseCampaignExport(report).agentIsolation).toEqual(agentIsolation)
		expect(() =>
			exportProblemSolvingCampaign({ ...value, agentIsolation: { ...agentIsolation, osSandbox: true } }),
		).toThrow()
		expect(() =>
			exportProblemSolvingCampaign({
				...value,
				agentIsolation: { ...agentIsolation, privateAssetIsolation: "verified" },
			}),
		).toThrow()
	})

	it("preserves local-native limits through canonical paired reporting", () => {
		const agentIsolation = {
			boundary: "trusted-local-native-host",
			privateAssetIsolation: "unestablished",
			osSandbox: false,
		}
		const control = exportProblemSolvingCampaign({ ...completeInput(), agentIsolation })
		const { digest: _digest, ...body } = control
		const variant = { ...control.variant!, promptDigest: digest("0") }
		const candidate = sealCampaignExport({
			...body,
			runId: "synthetic-candidate",
			variant,
			observations: body.observations.map((row) => ({
				...row,
				runId: "synthetic-candidate",
				variantIdentity: immutableIdentity(variant),
			})),
		})
		const experiment = declareCampaignPair(control, candidate, {
			id: "synthetic-identity-scope",
			template: "harness_only",
			allowedDifferenceFields: ["promptDigest"],
			independentUnit: "task",
		})
		expect(reportCampaignPair(control, candidate, experiment).producerEvidence.agentIsolation).toEqual({
			control: agentIsolation,
			candidate: agentIsolation,
		})
		expect(reportCampaignPair(control, candidate, experiment).producerEvidence.conditionIdentityScope).toBe(
			"native-host-protocol-v1",
		)
		const { conditionIdentityScope: _scope, digest: _seal, ...legacyCandidateBody } = candidate
		const legacyCandidate = sealCampaignExport(legacyCandidateBody)
		expect(() => reportCampaignPair(control, legacyCandidate, experiment)).toThrow(
			"fixed-condition identity domains differ",
		)
		const { conditionIdentityScope: _controlScope, digest: _controlSeal, ...legacyControlBody } = control
		const legacyControl = sealCampaignExport(legacyControlBody)
		expect(
			Object.hasOwn(
				reportCampaignPair(legacyControl, legacyCandidate, experiment).producerEvidence,
				"conditionIdentityScope",
			),
		).toBe(false)
	})

	it("does not mint a native condition scope from controller input without an observed native receipt", () => {
		const report = exportProblemSolvingCampaign({ ...input(), conditionIdentityScope: "native-host-protocol-v1" })
		expect(report.conditionIdentityScope).toBeUndefined()
		expect(report.incomplete.length).toBeGreaterThan(0)
	})

	it("keeps explicit native missing components diagnostic without filling them from declarations", () => {
		const value = completeInput()
		const { digest: _ignored, ...capture } = completeCapture()
		value.attempts[0]!.experimentIdentity = sealExecutedExperimentCapture({
			...capture,
			status: "incomplete",
			observedVariant: null,
			missing: ["toolImplementationDigest", "skillBundleDigest"],
		})
		const report = exportProblemSolvingCampaign(value)
		expect(report.variant).toBeNull()
		expect(report.observations).toEqual([])
		expect(report.incomplete[0]?.reason).toContain("toolImplementationDigest,skillBundleDigest")
	})

	it("preserves successful scripted artifact controls without calling them live model-solving evidence", () => {
		const value = completeInput()
		const scripted = {
			...value,
			attempts: [{ ...value.attempts[0]!, providerMode: "scripted", countsAsSolving: false }],
		}
		const report = exportProblemSolvingCampaign(scripted)
		expect(report.decisionSource).toBe("scripted")
		expect(report.observations[0]?.status).toBe("passed")
	})

	it.each(["task", "prompt", "model", "effort", "settings", "assignment", "pair", "capturedAt", "requestTime"])(
		"rejects changed native %s measurements even after the capture is resealed",
		(kind) => {
			const value = completeInput()
			const { digest: _ignored, ...capture } = completeCapture()
			if (kind === "task") capture.task.digest = digest("0")
			if (kind === "prompt") capture.observed.taskPromptDigest = digest("0")
			if (kind === "model") {
				capture.observedVariant!.model = "another-model"
				capture.observed.model = "another-model"
				capture.requests[0]!.model = "another-model"
			}
			if (kind === "effort") capture.observed.reasoningEffort = "low"
			if (kind === "settings") capture.requests[0]!.optionsDigest = digest("0")
			if (kind === "assignment") capture.assignmentDigest = digest("0")
			if (kind === "pair") capture.pairDigest = digest("0")
			if (kind === "capturedAt") capture.capturedAt = "2026-01-01T01:00:01.100Z"
			if (kind === "requestTime") capture.requests[0]!.startedAt = "2026-01-01T00:59:59.000Z"
			value.attempts[0]!.experimentIdentity = sealExecutedExperimentCapture(capture)
			expect(() => exportProblemSolvingCampaign(value)).toThrow(/Native|native|model identity/)
		},
	)

	it("accepts multiple tasks only under the same genuinely observed variant, without normalizing drift", () => {
		const { digest: _ignoredAssignment, ...baseAssignment } = assignment()
		const frame = {
			...taskSet,
			tasks: [...taskSet.tasks, { id: "synthetic-repair-two", version: 1, digest: digest("0") }],
		}
		const firstAssignment = sealProblemSolvingExperimentAssignment({ ...baseAssignment, taskSet: frame })
		const secondAssignment = sealProblemSolvingExperimentAssignment({
			...baseAssignment,
			taskSet: frame,
			pair: { ...baseAssignment.pair, taskId: "synthetic-repair-two" },
			task: { ...baseAssignment.task, definitionDigest: digest("0") },
		})
		const { digest: _ignoredCapture, ...baseCapture } = completeCapture()
		const firstCapture = sealExecutedExperimentCapture({ ...baseCapture, assignmentDigest: firstAssignment.digest })
		const secondCapture = sealExecutedExperimentCapture({
			...baseCapture,
			attemptId: "synthetic-attempt-two",
			assignmentDigest: secondAssignment.digest,
			pairDigest: sha256(canonicalJson(secondAssignment.pair)),
			task: { ...baseCapture.task, id: "synthetic-repair-two" },
		})
		const first = { ...attempt(), experimentAssignment: firstAssignment, experimentIdentity: firstCapture }
		const second = {
			...attempt(),
			taskId: "synthetic-repair-two",
			attemptId: "synthetic-attempt-two",
			experimentAssignment: secondAssignment,
			experimentIdentity: secondCapture,
		}
		const value = {
			schemaVersion: 1,
			runId: "synthetic-control",
			taskSet: frame,
			assignments: [firstAssignment, secondAssignment],
			attempts: [first, second],
		}
		expect(exportProblemSolvingCampaign(value).observations).toHaveLength(2)
		const { digest: _ignoredDrift, ...drift } = secondCapture
		second.experimentIdentity = sealExecutedExperimentCapture({
			...drift,
			observedVariant: { ...drift.observedVariant!, policyDigest: digest("0") },
		})
		expect(() => exportProblemSolvingCampaign(value)).toThrow("multiple executed variants")
	})

	it.each([
		{ failureClass: "authentication", status: "blocked", graderDecision: null, expected: "infrastructure_error" },
		{ failureClass: "provider", status: "failed", graderDecision: null, expected: "infrastructure_error" },
		{ failureClass: "budget", status: "failed", graderDecision: "outcome_failed", expected: "budget_exhausted" },
		{ failureClass: "cancellation", status: "cancelled", graderDecision: null, expected: "cancelled" },
		{ failureClass: "task", status: "failed", graderDecision: "grader_error", expected: "grader_error" },
		{ failureClass: "task", status: "failed", graderDecision: "safety_failed", expected: "safety_failed" },
		{ failureClass: "task", status: "failed", graderDecision: "outcome_failed", expected: "outcome_failed" },
	])("preserves failure class $expected separately from model success", ({ expected, ...fields }) => {
		const value = completeInput()
		Object.assign(value.attempts[0]!, fields, { countsAsSolving: false })
		expect(exportProblemSolvingCampaign(value).observations[0]?.status).toBe(expected)
	})

	it("seals declarations without treating them as observed variants", () => {
		const declaration = assignment()
		expect(parseProblemSolvingExperimentAssignment(declaration)).toEqual(declaration)
		expect(Object.keys(declaration)).not.toContain("variant")
		const { digest: sealed, ...body } = declaration
		expect(sealed).toBe(sha256(canonicalJson(body)))
	})

	it("rejects altered assignments, task-set substitution and duplicate task identities", () => {
		const changed = assignment()
		changed.pair.repetition = 4
		expect(() => parseProblemSolvingExperimentAssignment(changed)).toThrow("digest mismatch")
		const { digest: _ignored, ...body } = assignment()
		expect(() =>
			sealProblemSolvingExperimentAssignment({ ...body, task: { ...body.task, definitionDigest: digest("0") } }),
		).toThrow("declared task definition")
		expect(() =>
			sealProblemSolvingExperimentAssignment({
				...body,
				taskSet: { ...taskSet, tasks: [...taskSet.tasks, ...taskSet.tasks] },
			}),
		).toThrow("duplicate")
	})

	it("preserves historical missing identity as a sealed diagnostic export", () => {
		const value = input()
		const report = exportProblemSolvingCampaign(value)
		expect(parseCampaignExport(report)).toEqual(report)
		expect(report.variant).toBeNull()
		expect(report.observations).toEqual([])
		expect(report.incomplete).toContainEqual({
			taskId: "synthetic-repair",
			reason: "executed_variant_identity_unavailable",
		})
		expect(report.accounting).toMatchObject({
			totalAttempts: 1,
			scoredSamples: 0,
			diagnosticAttempts: 1,
			totalCost: null,
		})
	})

	it("missing predeclared assignments cannot be reconstructed from outcomes", () => {
		const value = input()
		const { experimentAssignment: _ignored, ...historical } = value.attempts[0]!
		const report = exportProblemSolvingCampaign({ ...value, assignments: [], attempts: [historical] })
		expect(report.incomplete.map(({ reason }) => reason)).toContain(
			"predeclared_experiment_assignments_unavailable",
		)
		expect(report.incomplete.map(({ reason }) => reason)).toContain("attempt_experiment_assignment_unavailable")
		expect(report.observations).toEqual([])
	})

	it("retains missing timing as unavailable rather than zero latency", () => {
		const value = input()
		const { elapsedMs: _ignored, ...historical } = value.attempts[0]!
		const report = exportProblemSolvingCampaign({ ...value, attempts: [historical] })
		expect(report.incomplete.map(({ reason }) => reason)).toContain("attempt_execution_timing_unavailable")
		expect(report.observations).toEqual([])
	})

	it.each([{ elapsedMs: 1 }, { completedAt: "2026-01-01T00:59:59.000Z" }, { startedAt: "2025-12-31T23:59:59.000Z" }])(
		"rejects forged latency or execution before declaration: %j",
		(change) => {
			const value = input()
			Object.assign(value.attempts[0]!, change)
			expect(() => exportProblemSolvingCampaign(value)).toThrow(/timing|duration/)
		},
	)

	it("rejects duplicate, unplanned and wrong-fixture attempts", () => {
		const value = input()
		expect(() =>
			exportProblemSolvingCampaign({ ...value, attempts: [...value.attempts, ...value.attempts] }),
		).toThrow("duplicate attempt")
		expect(() =>
			exportProblemSolvingCampaign({ ...value, assignments: [...value.assignments, ...value.assignments] }),
		).toThrow("duplicate planned")
		expect(() =>
			exportProblemSolvingCampaign({ ...value, attempts: [{ ...attempt(), taskId: "another-source" }] }),
		).toThrow("outside")
		expect(() =>
			exportProblemSolvingCampaign({ ...value, attempts: [{ ...attempt(), taskDigest: digest("0") }] }),
		).toThrow("fixture identity")
	})

	it("incomplete rosters and missing task assignments remain explicit", () => {
		const value = input()
		const report = exportProblemSolvingCampaign({ ...value, assignments: [assignment(), assignment(1)] })
		expect(report.incomplete).toContainEqual({ taskId: "synthetic-repair", reason: "planned_attempt_unavailable" })
		expect(report.accounting?.sampling?.notRun).toBe(1)
	})

	it("does not accept contradictory solving claims or a scripted success as live solving", () => {
		const value = input()
		expect(() =>
			exportProblemSolvingCampaign({ ...value, attempts: [{ ...attempt(), graderDecision: "outcome_failed" }] }),
		).toThrow("contradicts")
		expect(() =>
			exportProblemSolvingCampaign({ ...value, attempts: [{ ...attempt(), providerMode: "scripted" }] }),
		).toThrow("contradicts")
	})

	it("retains unknown costs and rejects non-finite total-cost overflow", () => {
		const value = input()
		const report = exportProblemSolvingCampaign(value)
		expect(report.accounting?.totalCost).toBeNull()
		expect(() =>
			exportProblemSolvingCampaign({
				...value,
				assignments: [assignment(), assignment(1)],
				attempts: [
					{ ...attempt(), usage: { ...attempt().usage, cost: Number.MAX_VALUE } },
					{ ...attempt(1), usage: { ...attempt().usage, cost: Number.MAX_VALUE } },
				],
			}),
		).toThrow("overflow")
	})
})
