import { canonicalJson, sha256 } from "../../../evidence/canonical"
import { declareCampaignPair, sealCampaignExport } from "../../../experiments/campaign"
import { immutableIdentity } from "../../../experiments/identity"
import type { ExperimentDecisionPlan, ExperimentVariant, TrialObservation } from "../../../experiments/types"
import type { FrontierPairedEvidence } from "../../convergence"

const digest = (value: string) => `sha256:${value.repeat(64)}`

/** Synthetic producer receipts exercise the gate; no model or host is launched. */
export function convergenceEvidence(): FrontierPairedEvidence {
	const taskSet = {
		schemaVersion: 1 as const,
		id: "predicted-editing-segment",
		version: 1,
		tasks: Array.from({ length: 32 }, (_, index) => ({ id: `task-${index}`, version: 1, digest: digest("a") })),
	}
	const controlVariant: ExperimentVariant = {
		schemaVersion: 1,
		id: "frontier-system",
		extensionCommit: "fixture-source",
		workingTreeDigest: digest("1"),
		extensionBuildDigest: digest("2"),
		model: "fixture-luna-model",
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
		networkMode: "fixture-offline",
		retryPolicyDigest: digest("d"),
	}
	const candidateVariant = { ...controlVariant, extensionBuildDigest: digest("f") }
	const predictedCapability = "editing"
	const plan: ExperimentDecisionPlan = {
		id: "predeclared-editing-improvement",
		declaredAt: "2026-10-01T00:00:00.000Z",
		claim: "fixed-system-paired-outcome",
		population: `capability:${predictedCapability}`,
		taskSetIdentity: immutableIdentity(taskSet),
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
		minimumIndependentUnits: 32,
		plannedPairs: 96,
		minimumPairedCoverage: 1,
		maximumIntervalWidth: 1,
		requiredFamilies: ["editing"],
		timeBlocks: [
			{ id: "declared-block", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-02T00:00:00.000Z" },
		],
		resourceProtocolDigest: digest("b"),
		cacheProtocolDigest: digest("e"),
	}
	const campaign = (variant: ExperimentVariant, arm: "control" | "candidate") => {
		const observations: TrialObservation[] = taskSet.tasks.flatMap((task, index) =>
			Array.from({ length: 3 }, (_, repetition) => {
				const status = arm === "candidate" || index < 4 ? "passed" : "outcome_failed"
				return {
					taskId: task.id,
					taskVersion: task.version,
					seed: 0,
					repetition,
					resourceProfileDigest: variant.resourceProfileDigest,
					permissionDigest: variant.permissionDigest,
					networkMode: variant.networkMode,
					retryPolicyDigest: variant.retryPolicyDigest,
					timeWindow: "declared-block",
					capturedTimeWindow: "declared-block",
					variantIdentity: immutableIdentity(variant),
					runId: `${arm}-run`,
					status,
					firstAttemptStatus: status,
					retryAssisted: false,
					cost: 0,
					latencyMs: 10,
					decisionPlanDigest: sha256(canonicalJson(plan)),
					startedAt: "2026-10-01T01:00:00.000Z",
					capabilities: [predictedCapability],
					risk: "medium",
					family: "editing",
					difficulty: "challenging",
				}
			}),
		)
		return sealCampaignExport({
			schemaVersion: 1,
			runId: `${arm}-run`,
			executionFidelity: "actual-host",
			decisionSource: "live",
			variant,
			taskSet,
			observations,
			incomplete: [],
		})
	}
	const control = campaign(controlVariant, "control")
	const candidate = campaign(candidateVariant, "candidate")
	return {
		schemaVersion: 1,
		control,
		candidate,
		experiment: declareCampaignPair(control, candidate, {
			id: "frontier-editing-comparison",
			template: "harness_only",
			allowedDifferenceFields: ["extensionBuildDigest"],
			independentUnit: "task",
			decisionPlan: plan,
		}),
		predictedCapability,
		primaryModelIdentity: {
			role: "luna-high",
			modelId: controlVariant.model,
			modelSettingsDigest: controlVariant.modelSettingsDigest,
		},
	}
}
