import type { ContentAddressedArtifactStore } from "../../evidence/artifactStore"
import { canonicalJson, sha256 } from "../../evidence/canonical"
import { collectRequiredEvidence, type RequiredEvidence } from "../../evidence/collector"
import { EventJournal } from "../../evidence/eventJournal"
import { evidenceBundleDigest } from "../../evidence/integrity"
import { REQUIRED_ARTIFACT_KINDS, type EvidenceBundle } from "../../evidence/types"
import { exportHostCampaign } from "../../experiments/hostCampaign"
import { immutableIdentity } from "../../experiments/identity"
import { pairKeySchema, type ExperimentDecisionPlan } from "../../experiments/types"
import { sealConfirmationPlan, type ConfirmationArm, type ConfirmationPlan } from "../confirmation"
import { sealFeedback, sealFeedbackReview } from "../feedback"
import { parseHandoff, sealHarnessContext, sealReviewedHandoffRepair } from "../handoff"
import { parseRegressionProposal } from "../regressions"

export const CONFIRMATION_TIME = "2026-10-23T15:00:00.000Z"
const sealed = <T extends object>(body: T) => ({ ...body, digest: sha256(canonicalJson(body)) })

/** Offline transport data only: these fixtures do not execute or attest a VS Code host. */
export async function createConfirmationFixture(
	options: { live?: boolean; additionalCases?: number; samples?: number } = {},
) {
	const retained = new Map<string, Uint8Array>()
	const store: ContentAddressedArtifactStore = {
		put: async (input) => {
			const digest = sha256(input.bytes)
			retained.set(digest, input.bytes)
			return {
				schemaVersion: 1,
				id: digest,
				attemptId: input.attemptId,
				kind: input.kind,
				digest,
				mediaType: input.mediaType,
				sizeBytes: input.bytes.byteLength,
				access: "reviewer",
				retention: "campaign",
				uploadState: "complete",
				captureStatus: "captured",
				createdAt: "2026-10-23T10:00:00.000Z",
			}
		},
		get: async ({ digest }) => retained.get(digest),
	}
	const identity = { runId: "archived-run", trialId: "archived-trial", attemptId: "archived-attempt" }
	const journal = new EventJournal(identity)
	journal.append("attempt.completed", { status: "failed" }, "2026-10-23T10:00:00.000Z")
	const bundle: EvidenceBundle = {
		schemaVersion: 1,
		...identity,
		taskIdentity: "source-task@1",
		variantIdentity: sha256("archived-variant"),
		identityStatus: "attempt-bound",
		events: journal.all(),
		artifacts: await collectRequiredEvidence(
			identity.attemptId,
			Object.fromEntries(
				REQUIRED_ARTIFACT_KINDS.map((kind) => [kind, `${kind}: observed regression`]),
			) as RequiredEvidence,
			store,
		),
	}
	bundle.bundleDigest = evidenceBundleDigest(bundle)
	const evidence = { bundle, store }
	const feedback = await sealFeedback(
		{
			schemaVersion: 1,
			recordType: "feedback",
			id: "feedback-cache",
			createdAt: "2026-10-23T11:00:00.000Z",
			source: { type: "human", reviewerId: "operator" },
			finding: "The derived value remains stale after mutation.",
			expectedBehavior: "Invalidate the derived value after mutation.",
			severity: "high",
			classification: "implementation-defect",
			evidence: { ...identity, bundleDigest: bundle.bundleDigest, eventSequence: 1 },
		},
		evidence,
	)
	const feedbackReview = sealFeedbackReview(
		{
			schemaVersion: 1,
			recordType: "feedback-review",
			id: "review-cache",
			createdAt: "2026-10-23T12:00:00.000Z",
			source: { type: "human", reviewerId: "reviewer" },
			feedbackDigest: feedback.digest,
			decision: "accepted",
			rationale: "The sealed assertion output demonstrates the stale derived value.",
		},
		feedback,
	)
	const command = { command: "node", args: ["--test", "test/cache.test.cjs"] }
	const policy = {
		schemaVersion: 1,
		allowedSourceTaskIdentities: ["source-task@1"],
		allowedCommands: [command],
		maxFiles: 32,
		maxBytes: 262_144,
		network: "disabled",
	}
	const regression = parseRegressionProposal(
		sealed({
			schemaVersion: 1,
			recordType: "regression-proposal",
			feedback,
			review: feedbackReview,
			draft: {
				id: "regression-cache",
				prompt: "Repair the invalidation contract.",
				expectedBehavior: feedback.expectedBehavior,
				files: [{ path: "src/cache.js", content: "before" }],
				verifier: {
					files: [{ path: "test/cache.test.cjs", content: "assert.equal(value, expected)" }],
					commands: [command],
					failureMarker: "CACHE_REGRESSION",
				},
				controls: {
					reference: [{ path: "src/cache.js", content: "after" }],
					alternative: [{ path: "src/cache.js", content: "alternative" }],
					incorrect: [1, 2, 3].map((number) => ({
						id: `incorrect-${number}`,
						files: [{ path: "src/cache.js", content: `incorrect ${number}` }],
					})),
				},
			},
			source: {
				taskIdentity: "source-task@1",
				evidenceTaskIdentity: bundle.taskIdentity,
				partition: "development",
				taskDigest: sha256("source-task"),
				fixtureDigest: sha256("source-fixture"),
				bundleDigest: bundle.bundleDigest,
			},
			policy,
			policyDigest: sha256(canonicalJson(policy)),
		}),
	)
	const sourceBytes = { control: Buffer.from("before"), candidate: Buffer.from("after") }
	const provider = options.live
		? { mode: "live-copilot" as const, modelId: "observed-model", effort: "high" }
		: { mode: "scripted" as const }
	const contextBody = {
		schemaVersion: 1,
		sourceRevision: "a".repeat(40),
		sourceFiles: [{ path: "src/cache.js", digest: sha256(sourceBytes.control) }],
		harnessDigest: sha256("registered-runner"),
		extensionBuildDigest: sha256("control-build"),
		taskSetDigest: sha256("registered-cases"),
		model: options.live ? { id: "observed-model", effort: "high" } : { id: "scripted", effort: "scripted" },
	}
	const contexts = {
		control: sealHarnessContext(contextBody),
		candidate: sealHarnessContext({
			...contextBody,
			sourceFiles: [{ path: "src/cache.js", digest: sha256(sourceBytes.candidate) }],
			extensionBuildDigest: sha256("candidate-build"),
		}),
	}
	const validation = {
		digest: sha256("offline-controls"),
		scope: "archived-output-and-offline-controls",
		status: "passed",
		archivedDecision: "outcome_failed",
	}
	const item = sealed({
		id: "repair-cache",
		title: "Invalidate derived values",
		feedbackDigest: feedback.digest,
		reviewDigest: feedbackReview.digest,
		regressionProposalDigest: regression.digest,
		classification: "implementation-defect",
		requirement: { state: "present", references: contexts.control.sourceFiles },
		owningPaths: ["src/cache.js"],
		allowedChangePaths: ["src/cache.js"],
		impact: 4,
		confidence: 90,
		effort: 2,
		source: feedback.source,
		finding: feedback.finding,
		expectedBehavior: feedback.expectedBehavior,
		severity: feedback.severity,
		humanReview: { reviewerId: feedbackReview.source.reviewerId, rationale: feedbackReview.rationale },
		regressionIds: [regression.draft.id],
		validation: [validation],
		freshAgentConfirmation: "required",
		priorityScore: 3_040_903,
	})
	const handoff = parseHandoff(
		sealed({
			schemaVersion: 1,
			recordType: "codex-handoff",
			id: "handoff-cache",
			createdAt: "2026-10-23T13:00:00.000Z",
			context: contexts.control,
			rankingPolicy: "severity-impact-confidence-effort-v1",
			evidenceBundleDigests: [bundle.bundleDigest],
			feedbackDigests: [feedback.digest],
			feedbackReviewDigests: [feedbackReview.digest],
			regressionProposalDigests: [regression.digest],
			validationReceiptDigests: [validation.digest],
			items: [item],
		}),
	)
	const reviewedRepair = sealReviewedHandoffRepair({
		schemaVersion: 1,
		recordType: "reviewed-handoff-repair",
		handoffDigest: handoff.digest,
		itemDigest: item.digest,
		contextDigest: contexts.control.digest,
		source: { type: "human", reviewerId: "patch-reviewer" },
		decision: "accepted",
		scenarioId: "source-task",
		regressionScenarioId: regression.draft.id,
		neighborScenarioIds: ["neighbor-cache"],
		patch: {
			id: "cache-patch",
			edits: [
				{ path: "src/cache.js", expectedSha256: sha256(sourceBytes.control).slice(7), replacement: "after" },
			],
		},
	})
	const sources = { feedback, feedbackReview, regression, handoff, reviewedRepair }
	const scenarios = [
		regression.draft.id,
		"neighbor-cache",
		...Array.from({ length: options.additionalCases ?? 0 }, (_, index) => `quality-${index}`),
	]
	const samples = options.samples ?? 1
	const rawCampaign = (arm: ConfirmationArm, decisionPlan?: ExperimentDecisionPlan) => ({
		version: 1,
		id: `fresh-${arm}`,
		mode: "report-only",
		stopReason: "completed",
		repairs: [],
		requestedProvider: provider,
		retention: { status: "complete" },
		evaluationPlan: { scenarioIds: scenarios, hostVersions: ["1.138.0"], samples },
		evaluationIdentity: {
			extensionCommit: contexts[arm].sourceRevision,
			workingTreeDigest: sha256(`${arm}-source`),
			extensionBuildDigest: contexts[arm].extensionBuildDigest,
			harnessDigest: contexts[arm].harnessDigest,
			configDigest: sha256("frozen-config"),
			taskSetDigest: contexts[arm].taskSetDigest,
			sourceComponentsDigest: sha256(`${arm}-components`),
			unchanged: true,
			missing: [],
		},
		attempts: scenarios.flatMap((scenarioId) =>
			Array.from({ length: samples }, (_, sample) => ({
				request: {
					campaignId: `fresh-${arm}`,
					provider,
					scenarioId,
					sample: sample + 1,
					phase: "sample",
					host: { version: "1.138.0" },
					decisionPlanDigest: decisionPlan ? sha256(canonicalJson(decisionPlan)) : undefined,
					startedAt: CONFIRMATION_TIME,
					timeWindow: "confirmation-block",
				},
				result: {
					status: arm === "control" && scenarioId === regression.draft.id ? "failed" : "passed",
					failure:
						arm === "control" && scenarioId === regression.draft.id ? { class: "assertion" } : undefined,
					actualHostVersion: "1.138.0",
					model: options.live ? { id: "observed-model", effort: "high" } : undefined,
					usage: { cost: options.live ? 1 : null, inputTokens: null, outputTokens: null },
				},
				elapsedMs: 20,
				evidence: `attempt-${scenarioId}-${sample + 1}/manifest.json`,
			})),
		),
	})
	const preview = {
		control: exportHostCampaign(rawCampaign("control"), { timeWindow: "confirmation-block" }),
		candidate: exportHostCampaign(rawCampaign("candidate"), { timeWindow: "confirmation-block" }),
	}
	const decisionPlan: ExperimentDecisionPlan = {
		id: "confirmation-outcome",
		declaredAt: "2026-10-23T14:00:00.000Z",
		claim: "fixed-system-paired-outcome",
		population: "Explicit registered host cases under the fixed source and provider settings",
		taskSetIdentity: immutableIdentity(preview.control.taskSet),
		controlRunId: "fresh-control",
		candidateRunId: "fresh-candidate",
		sampling: "independent-units",
		objective: "improvement",
		margin: 0,
		independentUnit: "task",
		weights: "equal-independent-unit",
		exclusionRule: "paired-scoreable",
		decisionSchedule: "fixed-final",
		confidence: 0.95,
		minimumIndependentUnits: 2,
		plannedPairs: scenarios.length * samples,
		minimumPairedCoverage: 1,
		maximumIntervalWidth: 2,
		requiredFamilies: ["host-scenarios"],
		timeBlocks: [
			{ id: "confirmation-block", startsAt: "2026-10-23T14:00:00.000Z", endsAt: "2026-10-23T16:00:00.000Z" },
		],
		resourceProtocolDigest: sha256("fixed-resource-protocol"),
		cacheProtocolDigest: sha256("fixed-cache-protocol"),
	}
	const plan = sealConfirmationPlan({
		schemaVersion: 1,
		recordType: "confirmation-plan",
		id: "confirmation-cache",
		declaredAt: "2026-10-23T14:00:00.000Z",
		mode: options.live ? "live-quality" : "scripted-host-regression",
		sources: {
			feedbackDigest: feedback.digest,
			feedbackReviewDigest: feedbackReview.digest,
			regressionProposalDigest: regression.digest,
			handoffDigest: handoff.digest,
			reviewedRepairDigest: reviewedRepair.digest,
			archivedCampaignDigests: [],
		},
		taskSet: preview.control.taskSet,
		hostVersions: ["1.138.0"],
		control: { runId: "fresh-control", context: contexts.control, variant: preview.control.variant, provider },
		candidate: {
			runId: "fresh-candidate",
			context: contexts.candidate,
			variant: preview.candidate.variant,
			provider,
		},
		experiment: {
			schemaVersion: 1,
			id: "confirmation-experiment",
			template: "harness_only",
			taskSetIdentity: immutableIdentity(preview.control.taskSet),
			controlVariantIdentity: immutableIdentity(preview.control.variant!),
			candidateVariantIdentity: immutableIdentity(preview.candidate.variant!),
			pairs: preview.control.observations.map((observation) => pairKeySchema.parse(observation)),
			independentUnit: "task",
			decisionPlan,
			allowedDifferenceFields: [
				"workingTreeDigest",
				"extensionBuildDigest",
				"promptDigest",
				"toolSchemaDigest",
				"toolImplementationDigest",
				"skillBundleDigest",
				"policyDigest",
				"compactionDigest",
			],
		},
		requirements: {
			targeted: [{ regressionId: regression.draft.id, taskId: `${regression.draft.id}:vscode-1.138.0` }],
			neighbors: ["neighbor-cache:vscode-1.138.0"],
		},
		limits: { maxRequestsPerArm: scenarios.length * samples, maxDurationMsPerArm: 30_000 },
		promotionPolicy: "pr-v1",
	})
	const campaigns = (selected: ConfirmationPlan = plan) => ({
		control: exportHostCampaign(rawCampaign("control", selected.experiment.decisionPlan), {
			timeWindow: "confirmation-block",
		}),
		candidate: exportHostCampaign(rawCampaign("candidate", selected.experiment.decisionPlan), {
			timeWindow: "confirmation-block",
		}),
	})
	const ports = {
		evidence,
		now: () => CONFIRMATION_TIME,
		readSource: async (arm: ConfirmationArm, relativePath: string) =>
			relativePath === "src/cache.js" ? sourceBytes[arm] : undefined,
		runCampaign: async ({ arm }: { arm: ConfirmationArm }) => campaigns()[arm],
	}
	return { plan, sources, evidence, retained, ports, campaigns, rawCampaign, sourceBytes }
}
