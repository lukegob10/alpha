import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../evidence/canonical"
import { exportHostCampaign } from "../../experiments/hostCampaign"
import { immutableIdentity } from "../../experiments/identity"
import { experimentVariantSchema, type ExperimentDecisionPlan } from "../../experiments/types"
import { captureExpectedNodeTestCommands } from "../../grading/nodeTestCompletion"
import { createDefaultGraderRegistry } from "../../grading/registry"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"
import { systemClock } from "../../orchestration/systemPorts"
import { sealConfirmationPlan, type ConfirmationArm, type ConfirmationRunRequest } from "../confirmation"
import type { Feedback, FeedbackReview } from "../contracts"
import type { FeedbackEvidenceContext } from "../feedback"
import {
	sealHarnessContext,
	type HarnessContext,
	type HandoffManifest,
	type ReviewedHandoffRepairRecord,
} from "../handoff"
import type { RegressionDraft, RegressionHostPolicy } from "../regressions"
import type { RegressionProposal } from "../regressions"
import { readOwnedFile } from "../store"

import {
	collectRequiredEvidence,
	evidenceBundleDigest,
	EventJournal,
	FilesystemArtifactStore,
	sha256,
	type EvidenceBundle,
	type RequiredEvidence,
} from "../../evidence/index"

/** A real sealed bundle and CAS, with a deliberately observed scripted regression failure. */
export async function createWorkflowEvidenceFixture(
	root: string,
	attemptId = "attempt-original",
	taskIdentity = "repo-cache-invalidation@1",
) {
	const identity = { runId: "run-observed", trialId: "trial-cache", attemptId }
	const artifactsRoot = path.join(root, "source-artifacts")
	const artifacts = new FilesystemArtifactStore(artifactsRoot)
	const journal = new EventJournal(identity)
	journal.append("attempt.completed", {
		status: "outcome_failed",
		diagnostic: "stale-derived-origin",
		expectedOrigin: "http://localhost:4000",
		observedOrigin: "http://localhost:3000",
	})
	const evidence: RequiredEvidence = {
		final_diff: "diff --git a/src/cache.js b/src/cache.js\n+// scripted cache repair attempt\n",
		git_status: " M src/cache.js\n",
		tree_digest: sha256("scripted-original-workspace"),
		transcript: [{ role: "assistant", content: "The origin still uses the previous port after mutation." }],
		final_response: "The scripted verification failed: the derived origin retained the previous port.",
		test_output: "AssertionError: expected http://localhost:4000; actual http://localhost:3000",
		extension_log: "scripted original attempt reached its failed terminal boundary",
		environment_manifest: { fixture: true, provider: "scripted", node: process.version, network: "disabled" },
		usage: { requests: 1, inputTokens: 10, outputTokens: 2, cost: 0 },
		stop_reason: { status: "failed", reason: "assertion_failed" },
	}
	const bundle: EvidenceBundle = {
		schemaVersion: 1,
		...identity,
		taskIdentity,
		variantIdentity: sha256("scripted-original-build"),
		identityStatus: "attempt-bound",
		events: journal.all(),
		artifacts: await collectRequiredEvidence(attemptId, evidence, artifacts),
	}
	bundle.bundleDigest = evidenceBundleDigest(bundle)
	return { bundle, artifacts, artifactsRoot }
}

export const CACHE_FAILURE_MARKER = "CACHE_DERIVED_ORIGIN_REGRESSION"
export const CACHE_EXPECTED_BEHAVIOR = "Changing the port must invalidate the derived origin before the next read."
export const CACHE_REFERENCE_SOURCE = `export class ConfigCache {
	#raw = new Map()
	set(key, value) { this.#raw.set(key, value) }
	getOrigin() { return "http://localhost:" + this.#raw.get("port") }
}
`
export const CACHE_BASELINE_SOURCE = `export class ConfigCache {
	#raw = new Map()
	#origin
	set(key, value) { this.#raw.set(key, value) }
	getOrigin() { return this.#origin ??= "http://localhost:" + this.#raw.get("port") }
}
`

export function workflowRegressionDraft(): RegressionDraft {
	return {
		id: "cache-origin-feedback-regression",
		prompt: "Repair ConfigCache so replacing the port updates the derived origin. Preserve normal numeric ports.",
		expectedBehavior: CACHE_EXPECTED_BEHAVIOR,
		files: [{ path: "src/cache.mjs", content: CACHE_BASELINE_SOURCE }],
		verifier: {
			files: [
				{
					path: "test/cache.test.mjs",
					content: `import test from "node:test"
import assert from "node:assert/strict"
import { ConfigCache } from "../src/cache.mjs"
test("origin follows port replacement", () => {
	const cache = new ConfigCache()
	cache.set("port", 3000)
	assert.equal(cache.getOrigin(), "http://localhost:3000", "${CACHE_FAILURE_MARKER}")
	cache.set("port", 4000)
	assert.equal(cache.getOrigin(), "http://localhost:4000", "${CACHE_FAILURE_MARKER}")
})
`,
				},
			],
			commands: [{ command: "node", args: ["--test", "test/cache.test.mjs"] }],
			failureMarker: CACHE_FAILURE_MARKER,
		},
		controls: {
			reference: [{ path: "src/cache.mjs", content: CACHE_REFERENCE_SOURCE }],
			alternative: [
				{
					path: "src/cache.mjs",
					content: `export class ConfigCache {
	#port
	#origin
	set(key, value) { if (key === "port") { this.#port = value; this.#origin = undefined } }
	getOrigin() { return this.#origin ??= "http://localhost:" + this.#port }
}
`,
				},
			],
			incorrect: [
				{
					id: "wrong-origin-protocol",
					files: [
						{
							path: "src/cache.mjs",
							content:
								'export class ConfigCache { port; set(key,value) { this.port = value } getOrigin() { return "https://localhost:" + this.port } }\n',
						},
					],
				},
				{
					id: "hardcoded-old-port",
					files: [
						{
							path: "src/cache.mjs",
							content:
								'export class ConfigCache { set() {} getOrigin() { return "http://localhost:3000" } }\n',
						},
					],
				},
				{
					id: "ignores-port-replacement",
					files: [
						{
							path: "src/cache.mjs",
							content:
								'export class ConfigCache { port; set(key,value) { this.port ??= value } getOrigin() { return "http://localhost:" + this.port } }\n',
						},
					],
				},
			],
		},
	}
}

export function workflowRegressionPolicy(taskIdentity = "repo-cache-invalidation@1"): RegressionHostPolicy {
	return {
		schemaVersion: 1,
		allowedSourceTaskIdentities: [taskIdentity],
		allowedCommands: [{ command: "node", args: ["--test", "test/cache.test.mjs"] }],
		maxFiles: 8,
		maxBytes: 32_768,
		network: "disabled",
	}
}

/** The host transport is a fixture. Actual Node grader subprocesses supply its outcomes; no VS Code host is attested. */
export async function createWorkflowConfirmation(input: {
	root: string
	sourceRoot: string
	context: HarnessContext
	feedback: Feedback
	review: FeedbackReview
	proposal: RegressionProposal
	handoff: HandoffManifest
	reviewedRepair: ReviewedHandoffRepairRecord
	evidence: FeedbackEvidenceContext
}) {
	const candidateRoot = path.join(input.root, "candidate-source")
	await fs.mkdir(path.join(candidateRoot, "src"), { recursive: true })
	await fs.writeFile(path.join(candidateRoot, "src/cache.mjs"), CACHE_REFERENCE_SOURCE)
	const { digest: _digest, ...contextBody } = input.context
	const contexts = {
		control: input.context,
		candidate: sealHarnessContext({
			...contextBody,
			sourceFiles: [{ path: "src/cache.mjs", digest: sha256(CACHE_REFERENCE_SOURCE) }],
			extensionBuildDigest: sha256("candidate-extension-build"),
		}),
	}
	const sourceRoots = { control: input.sourceRoot, candidate: candidateRoot }
	const provider = { mode: "scripted" as const }
	const hostVersions = ["1.138.0"] as const
	const configDigest = sha256("workflow-frozen-configuration")
	const variant = (arm: ConfirmationArm) => {
		const context = contexts[arm]
		const source = sha256(canonicalJson(context.sourceFiles))
		return experimentVariantSchema.parse({
			schemaVersion: 1,
			id: "host-campaign",
			extensionCommit: context.sourceRevision,
			workingTreeDigest: source,
			extensionBuildDigest: context.extensionBuildDigest,
			model: "scripted",
			modelSettingsDigest: sha256(canonicalJson(provider)),
			promptDigest: source,
			toolSchemaDigest: source,
			toolImplementationDigest: source,
			skillBundleDigest: source,
			policyDigest: source,
			compactionDigest: source,
			runnerImageDigest: sha256(canonicalJson({ harnessDigest: context.harnessDigest, hosts: hostVersions })),
			resourceProfileDigest: configDigest,
			permissionDigest: configDigest,
			networkMode: "host-campaign-config",
			retryPolicyDigest: configDigest,
		})
	}
	const variants = { control: variant("control"), candidate: variant("candidate") }
	const scenarios = [input.proposal.draft.id, "cache-initial-port"]
	const taskSet = {
		schemaVersion: 1 as const,
		id: "host-scenarios",
		version: 1,
		tasks: scenarios
			.map((scenario) => `${scenario}:vscode-1.138.0`)
			.sort()
			.map((id) => ({
				id,
				version: 1,
				digest: sha256(canonicalJson({ id, taskSetDigest: input.context.taskSetDigest })),
			})),
	}
	const declaredAt = new Date().toISOString()
	const timeWindow = "workflow-confirmation-block"
	const decisionPlan: ExperimentDecisionPlan = {
		id: "workflow-fixed-confirmation",
		declaredAt,
		claim: "fixed-system-paired-outcome",
		population: "Two explicitly declared transport fixture cases",
		taskSetIdentity: immutableIdentity(taskSet),
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
		plannedPairs: 2,
		minimumPairedCoverage: 1,
		maximumIntervalWidth: 2,
		requiredFamilies: ["host-scenarios"],
		timeBlocks: [
			{ id: timeWindow, startsAt: declaredAt, endsAt: new Date(Date.parse(declaredAt) + 120_000).toISOString() },
		],
		resourceProtocolDigest: configDigest,
		cacheProtocolDigest: sha256("cold-fixture-cache"),
	}
	const sources = {
		feedback: input.feedback,
		feedbackReview: input.review,
		regression: input.proposal,
		handoff: input.handoff,
		reviewedRepair: input.reviewedRepair,
	}
	const plan = sealConfirmationPlan({
		schemaVersion: 1,
		recordType: "confirmation-plan",
		id: "cache-fresh-confirmation",
		declaredAt,
		mode: "scripted-host-regression",
		sources: {
			feedbackDigest: input.feedback.digest,
			feedbackReviewDigest: input.review.digest,
			regressionProposalDigest: input.proposal.digest,
			handoffDigest: input.handoff.digest,
			reviewedRepairDigest: input.reviewedRepair.digest,
			archivedCampaignDigests: [],
		},
		taskSet,
		experiment: {
			schemaVersion: 1,
			id: "cache-source-experiment",
			template: "harness_only",
			taskSetIdentity: immutableIdentity(taskSet),
			controlVariantIdentity: immutableIdentity(variants.control),
			candidateVariantIdentity: immutableIdentity(variants.candidate),
			pairs: taskSet.tasks.map(({ id }) => ({
				taskId: id,
				taskVersion: 1,
				seed: 0,
				repetition: 1,
				resourceProfileDigest: configDigest,
				permissionDigest: configDigest,
				networkMode: "host-campaign-config",
				retryPolicyDigest: configDigest,
				timeWindow,
			})),
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
			independentUnit: "task",
			decisionPlan,
		},
		hostVersions,
		control: { runId: "fresh-control", context: contexts.control, variant: variants.control, provider },
		candidate: { runId: "fresh-candidate", context: contexts.candidate, variant: variants.candidate, provider },
		requirements: {
			targeted: [{ regressionId: input.proposal.draft.id, taskId: `${input.proposal.draft.id}:vscode-1.138.0` }],
			neighbors: ["cache-initial-port:vscode-1.138.0"],
		},
		limits: { maxRequestsPerArm: 2, maxDurationMsPerArm: 30_000 },
		promotionPolicy: "pr-v1",
	})
	const requests: ConfirmationRunRequest[] = []
	const retainedCampaigns = new Map<ConfirmationArm, ReturnType<typeof exportHostCampaign>>()
	const readSource = (arm: ConfirmationArm, relativePath: string) => readOwnedFile(sourceRoots[arm], relativePath)
	const runCampaign = async (request: ConfirmationRunRequest) => {
		requests.push(request)
		const root = await fs.mkdtemp(path.join(input.root, `fresh-${request.arm}-`))
		await fs.mkdir(path.join(root, "src"))
		await fs.mkdir(path.join(root, "test"))
		await fs.writeFile(path.join(root, "src/cache.mjs"), await readSource(request.arm, "src/cache.mjs"))
		const tests = [
			input.proposal.draft.verifier.files[0]!,
			{
				path: "test/neighbor.test.mjs",
				content:
					'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { ConfigCache } from "../src/cache.mjs"\ntest("normal initial port remains supported", () => { const cache = new ConfigCache(); cache.set("port", 5000); assert.equal(cache.getOrigin(), "http://localhost:5000") })\n',
			},
		]
		const attempts = []
		for (const [index, file] of tests.entries()) {
			await fs.writeFile(path.join(root, file.path), file.content)
			const commands = await captureExpectedNodeTestCommands(root, [
				{ command: "node", args: ["--test", file.path] },
			])
			const startedAt = new Date().toISOString()
			const started = performance.now()
			const result = await createDefaultGraderRegistry().execute(
				[
					{
						id: `fresh-${index}`,
						version: 1,
						type: "command",
						hardGate: true,
						failureClass: "outcome",
						commands,
						cwd: "workspace",
						timeoutMs: 10_000,
						maxOutputBytes: 65_536,
					},
				],
				{
					workspaceRoot: root,
					changedPaths: [],
					trace: [],
					processRunner: new ExecaHarnessProcessRunner(),
					clock: systemClock,
				},
			)
			const evidence = path.join(root, `${scenarios[index]}.grade.json`)
			await fs.writeFile(evidence, JSON.stringify(result))
			attempts.push({
				request: {
					campaignId: request.runId,
					provider,
					scenarioId: scenarios[index],
					sample: 1,
					phase: "sample",
					host: { version: "1.138.0" },
					decisionPlanDigest: request.decisionPlanDigest,
					startedAt,
					timeWindow: request.timeWindow,
				},
				result: {
					status:
						result.decision === "passed"
							? "passed"
							: result.decision === "grader_error"
								? "blocked"
								: "failed",
					...(result.decision !== "passed"
						? { failure: { class: result.decision === "grader_error" ? "infrastructure" : "assertion" } }
						: {}),
					actualHostVersion: "1.138.0",
					usage: { cost: null, inputTokens: null, outputTokens: null },
				},
				elapsedMs: Math.round(performance.now() - started),
				evidence,
			})
		}
		const context = contexts[request.arm]
		const sourceComponentsDigest = sha256(canonicalJson(context.sourceFiles))
		const campaign = exportHostCampaign(
			{
				version: 1,
				id: request.runId,
				mode: "report-only",
				stopReason: "completed",
				repairs: [],
				requestedProvider: provider,
				retention: { status: "complete" },
				evaluationPlan: { scenarioIds: scenarios, hostVersions, samples: 1 },
				evaluationIdentity: {
					extensionCommit: context.sourceRevision,
					workingTreeDigest: sourceComponentsDigest,
					extensionBuildDigest: context.extensionBuildDigest,
					harnessDigest: context.harnessDigest,
					configDigest,
					taskSetDigest: context.taskSetDigest,
					sourceComponentsDigest,
					unchanged: true,
					missing: [],
				},
				attempts,
			},
			{ timeWindow: request.timeWindow },
		)
		retainedCampaigns.set(request.arm, campaign)
		return campaign
	}
	return {
		plan,
		sources,
		sourceRoots,
		requests,
		retainedCampaigns,
		ports: { evidence: input.evidence, readSource, runCampaign },
	}
}
