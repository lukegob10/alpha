import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { findBenchmarkTask } from "../../benchmark/loader"
import { canonicalJson } from "../../evidence/canonical"
import { sha256, type EvidenceBundle } from "../../evidence/index"
import { immutableIdentity } from "../../experiments/identity"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"
import type { HarnessProcessRunner } from "../../orchestration/ports"
import type { FeedbackInput } from "../contracts"
import { evaluateConfirmation, runFreshConfirmation, sealConfirmationPlan } from "../confirmation"
import { sealFeedback, sealFeedbackReview, validateFeedbackReview } from "../feedback"
import {
	buildHandoff,
	buildRegressionValidation,
	parseReviewedHandoffRepair,
	regradeArchivedEvidence,
	sealHarnessContext,
	sealReviewedHandoffRepair,
} from "../handoff"
import { runModelReview, type ModelReviewInput } from "../modelReview"
import {
	createRegressionProposal,
	materializeRegressionProposal,
	verifyRegressionControls,
	type RegressionDraft,
} from "../regressions"
import { ImprovementArtifactStore, readOwnedFile, stageReference } from "../store"
import {
	CACHE_BASELINE_SOURCE,
	CACHE_EXPECTED_BEHAVIOR,
	CACHE_REFERENCE_SOURCE,
	createWorkflowEvidenceFixture,
	createWorkflowConfirmation,
	workflowRegressionDraft,
	workflowRegressionPolicy,
} from "./workflowFixtures"

const roots: string[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function observedIteration() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-improvement-workflow-")))
	roots.push(root)
	const source = await createWorkflowEvidenceFixture(root)
	const store = await ImprovementArtifactStore.open({
		root: path.join(root, "improvement"),
		iterationId: "iteration-original",
	})
	const bundle = await store.importEvidence(source.bundle, source.artifactsRoot)
	const capture = await store.write({ id: "observed_failure", stage: "capture", value: bundle })
	return { root, source, bundle, store, capture, evidence: { bundle, store: store.artifacts } }
}

function humanFeedback(bundle: EvidenceBundle, id = "human-cache-finding"): FeedbackInput {
	return {
		schemaVersion: 1,
		recordType: "feedback",
		id,
		createdAt: new Date().toISOString(),
		source: { type: "human", reviewerId: "operator-reviewer" },
		finding: "The derived origin still uses the old port after changing its source value.",
		expectedBehavior: CACHE_EXPECTED_BEHAVIOR,
		severity: "high",
		classification: "implementation-defect",
		evidence: {
			runId: bundle.runId,
			trialId: bundle.trialId,
			attemptId: bundle.attemptId,
			bundleDigest: bundle.bundleDigest!,
			eventSequence: 1,
			artifactDigest: bundle.artifacts.find(({ kind }) => kind === "test_output")!.digest,
		},
	}
}

const sourceTask = () =>
	findBenchmarkTask(path.resolve(process.cwd(), "../../evals"), "javascript/repo-cache-invalidation")

function acceptedReview(feedback: Awaited<ReturnType<typeof sealFeedback>>, decision = "accepted") {
	return sealFeedbackReview(
		{
			schemaVersion: 1,
			recordType: "feedback-review",
			id: `review-${feedback.id}`,
			createdAt: new Date().toISOString(),
			source: { type: "human", reviewerId: "adjudicating-operator" },
			feedbackDigest: feedback.digest,
			decision,
			rationale: "The retained failure and source contract warrant this bounded regression.",
		},
		feedback,
	)
}

async function reviewedDraft(
	fixture: Awaited<ReturnType<typeof observedIteration>>,
	draft = workflowRegressionDraft(),
) {
	const human = await sealFeedback(humanFeedback(fixture.bundle), fixture.evidence)
	const humanStage = await fixture.store.write({
		id: "human_feedback",
		stage: "feedback",
		inputs: [stageReference(fixture.capture.manifest)],
		value: human,
	})
	const task = (await sourceTask()).task
	const input: ModelReviewInput = {
		id: "offline-cache-review",
		createdAt: new Date().toISOString(),
		rubric: {
			id: "cache-contract-v1",
			instructions:
				"Inspect the retained failure and propose one bounded deterministic regression. Human approval is required.",
		},
		harnessContext: {
			buildIdentity: fixture.bundle.variantIdentity!,
			effectiveConfiguration: { provider: "scripted", network: "disabled" },
			requirements: [{ id: "derived-origin", text: CACHE_EXPECTED_BEHAVIOR }],
		},
		sourceTask: task,
		selectedEvidence: [{ id: "original-cache-output", reference: human.evidence }],
	}
	const transport = vi.fn<typeof fetch>().mockImplementation(
		async () =>
			new Response(
				JSON.stringify({
					model: "offline-review-fixture",
					status: "completed",
					output: [
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "output_text",
									text: JSON.stringify({
										modelIdentity: "offline-review-fixture",
										rubricIdentity: sha256(canonicalJson(input.rubric)),
										observations: [
											{
												id: "stale-origin",
												evidenceId: "original-cache-output",
												finding: human.finding,
												expectedBehavior: CACHE_EXPECTED_BEHAVIOR,
												severity: "high",
												classification: "implementation-defect",
												regression: draft,
											},
										],
									}),
								},
							],
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			),
	)
	const model = await runModelReview({
		configuration: {
			endpoint: "https://offline-review.invalid/v1/responses",
			model: "offline-review-fixture",
			apiKeyEnv: "OFFLINE_REVIEW_KEY",
			// This mocked request also verifies retained filesystem evidence. Its
			// budget must accommodate that local work on Windows under test load.
			timeoutMs: 30_000,
			maxRequestBytes: 131_072,
			maxResponseBytes: 131_072,
			maxOutputTokens: 2_048,
		},
		input,
		evidence: fixture.evidence,
		environment: { OFFLINE_REVIEW_KEY: "fixture-credential-only" },
		fetch: transport,
	})
	const modelStage = await fixture.store.write({
		id: "model_review",
		stage: "feedback",
		inputs: [stageReference(humanStage.manifest)],
		value: model,
	})
	const feedback = model.feedback[0]!
	const review = acceptedReview(feedback)
	const reviewStage = await fixture.store.write({
		id: "model_adjudication",
		stage: "feedback-review",
		inputs: [stageReference(modelStage.manifest)],
		value: review,
	})
	const policy = workflowRegressionPolicy()
	const proposal = await createRegressionProposal({
		draft: model.drafts[0]!.draft,
		feedback,
		review,
		sourceTask: task,
		evidence: fixture.evidence,
		policy,
	})
	const proposalStage = await fixture.store.write({
		id: "generated_regression",
		stage: "regression-proposal",
		inputs: [stageReference(reviewStage.manifest)],
		value: proposal,
	})
	return {
		fixture,
		human,
		humanStage,
		input,
		transport,
		model,
		modelStage,
		feedback,
		review,
		reviewStage,
		task,
		policy,
		proposal,
		proposalStage,
	}
}

/** This port runs authored offline fixtures; it models the boundary contract and makes no network isolation claim. */
function authoredFixtureBoundary(policyDigest: string) {
	const processRunner = new ExecaHarnessProcessRunner()
	const allowlisted: HarnessProcessRunner = {
		run(spec) {
			if (spec.command !== process.execPath || path.basename(spec.args[0] ?? "") !== "nodeTestExecution.mjs")
				throw new Error("Unexpected fixture command")
			return processRunner.run(spec)
		},
	}
	return { processRunner: allowlisted, policyDigest, network: "disabled" as const }
}

async function generatedWorkflow(draft?: RegressionDraft) {
	const fixture = await observedIteration()
	const reviewed = await reviewedDraft(fixture, draft)
	const ownedRoot = path.join(fixture.root, "drafts")
	await fs.mkdir(ownedRoot)
	const materializationInput = {
		proposal: reviewed.proposal,
		selectedProposalDigest: reviewed.proposal.digest,
		ownedRoot,
		destinationName: "cache-regression",
		policy: reviewed.policy,
		evidence: fixture.evidence,
	}
	const materialized = await materializeRegressionProposal(materializationInput)
	const materializationStage = await fixture.store.write({
		id: "draft_fixture",
		stage: "materialization",
		inputs: [stageReference(reviewed.proposalStage.manifest)],
		value: { task: materialized.task, proposalDigest: materialized.proposal.digest },
	})
	const controls = await verifyRegressionControls({
		materialized,
		policy: reviewed.policy,
		executionApproval: { proposalDigest: reviewed.proposal.digest, policyDigest: reviewed.proposal.policyDigest },
		executionBoundary: authoredFixtureBoundary(reviewed.proposal.policyDigest),
	})
	const controlsStage = await fixture.store.write({
		id: "offline_controls",
		stage: "validation",
		inputs: [stageReference(materializationStage.manifest)],
		value: controls,
	})
	const sourceRoot = path.join(fixture.root, "current-source")
	await fs.mkdir(path.join(sourceRoot, "src"), { recursive: true })
	await fs.writeFile(path.join(sourceRoot, "src/cache.mjs"), CACHE_BASELINE_SOURCE)
	const context = sealHarnessContext({
		schemaVersion: 1,
		sourceRevision: "a".repeat(40),
		sourceFiles: [{ path: "src/cache.mjs", digest: sha256(CACHE_BASELINE_SOURCE) }],
		harnessDigest: sha256("offline-improvement-harness"),
		extensionBuildDigest: sha256("baseline-extension-build"),
		taskSetDigest: sha256("cache-and-neighbor"),
		model: { id: "scripted", effort: "scripted" },
	})
	const readSource = (relativePath: string) => readOwnedFile(sourceRoot, relativePath)
	const archived = await regradeArchivedEvidence(
		{
			proposal: reviewed.proposal,
			bundle: fixture.bundle,
			context,
			specs: [
				{
					id: "derived-origin-output",
					version: 1,
					type: "filesystem",
					hardGate: true,
					failureClass: "outcome",
					assertions: [
						{
							kind: "content-equals",
							path: "artifacts/test_output",
							expected: "AssertionError: expected http://localhost:4000; actual http://localhost:4000",
						},
					],
				},
			],
		},
		{
			store: fixture.store.artifacts,
			readSource,
			ownedRoot: fixture.root,
			destinationName: "archived-reconstruction",
		},
	)
	const archivedStage = await fixture.store.write({
		id: "archived_output_grade",
		stage: "archived-regrade",
		inputs: [stageReference(reviewed.proposalStage.manifest)],
		value: archived.receipt,
	})
	const validation = buildRegressionValidation({ proposal: reviewed.proposal, controls, archived: archived.receipt })
	const validationStage = await fixture.store.write({
		id: "combined_validation",
		stage: "validation",
		inputs: [stageReference(controlsStage.manifest), stageReference(archivedStage.manifest)],
		value: validation,
	})
	const handoffInput = {
		id: "cache-repair-handoff",
		createdAt: new Date().toISOString(),
		context,
		bundles: [fixture.bundle],
		feedback: [reviewed.feedback],
		reviews: [reviewed.review],
		proposals: [reviewed.proposal],
		validations: [validation],
		candidates: [
			{
				id: "repair-derived-origin",
				title: "Invalidate the derived origin after port replacement",
				feedbackDigest: reviewed.feedback.digest,
				reviewDigest: reviewed.review.digest,
				regressionProposalDigest: reviewed.proposal.digest,
				classification: "implementation-defect" as const,
				requirement: { state: "present" as const, references: context.sourceFiles },
				owningPaths: ["src/cache.mjs"],
				allowedChangePaths: ["src/cache.mjs"],
				impact: 4,
				confidence: 90,
				effort: 1,
			},
		],
	}
	const handoff = await buildHandoff(handoffInput, { store: fixture.store.artifacts, readSource })
	const handoffStage = await fixture.store.write({
		id: "reviewed_handoff",
		stage: "handoff",
		inputs: [stageReference(validationStage.manifest)],
		value: handoff,
	})
	return {
		...reviewed,
		materializationInput,
		materialized,
		materializationStage,
		controls,
		controlsStage,
		archived,
		archivedStage,
		validation,
		validationStage,
		sourceRoot,
		context,
		readSource,
		handoffInput,
		handoff,
		handoffStage,
	}
}

function repairInput(data: Awaited<ReturnType<typeof generatedWorkflow>>) {
	const body = {
		schemaVersion: 1,
		recordType: "reviewed-handoff-repair",
		handoffDigest: data.handoff.manifest.digest,
		itemDigest: data.handoff.manifest.items[0]!.digest,
		contextDigest: data.context.digest,
		source: { type: "human", reviewerId: "repair-operator" },
		decision: "accepted",
		scenarioId: "cache-repair",
		regressionScenarioId: data.proposal.draft.id,
		neighborScenarioIds: ["cache-initial-port"],
		patch: {
			id: "invalidate-port-origin",
			edits: [
				{
					path: "src/cache.mjs",
					expectedSha256: sha256(CACHE_BASELINE_SOURCE).slice(7),
					replacement: CACHE_REFERENCE_SOURCE,
				},
			],
		},
	}
	return sealReviewedHandoffRepair(body)
}

const confirmationInput = (data: Awaited<ReturnType<typeof generatedWorkflow>>) => ({
	root: data.fixture.root,
	sourceRoot: data.sourceRoot,
	context: data.context,
	feedback: data.feedback,
	review: data.review,
	proposal: data.proposal,
	handoff: data.handoff.manifest,
	reviewedRepair: repairInput(data),
	evidence: data.fixture.evidence,
})

describe("offline improvement workflow composition", () => {
	it("carries human and model observations through controls, handoff, and fresh scripted transport confirmation", async () => {
		const data = await generatedWorkflow()
		expect(data.model.admission).toBe("requires-human-review")
		expect(data.feedback.source.type).toBe("model")
		expect(data.transport).toHaveBeenCalledTimes(1)
		expect(String(data.transport.mock.calls[0]![1]!.body)).toContain("expected http://localhost:4000")
		expect(data.validation.status).toBe("passed")
		expect(
			data.controls.controls.filter(({ expectedPassed }) => expectedPassed).map(({ status }) => status),
		).toEqual(["passed", "passed"])
		expect(
			data.controls.controls
				.filter(({ expectedPassed }) => !expectedPassed)
				.every(({ status, matchedExpectedFailure }) => status === "failed" && matchedExpectedFailure),
		).toBe(true)
		expect(data.archived.receipt.result.decision).toBe("outcome_failed")
		expect(data.materialized.task.admission).toBe("draft")
		expect(data.handoff.manifest.items[0]!.freshAgentConfirmation).toBe("required")
		const repair = await parseReviewedHandoffRepair(repairInput(data), {
			manifest: data.handoff.manifest,
			currentContext: data.context,
			readSource: data.readSource,
		})
		expect(repair.patch.edits[0]!.replacement).toBe(CACHE_REFERENCE_SOURCE)
		expect(await fs.readFile(path.join(data.sourceRoot, "src/cache.mjs"), "utf8")).toBe(CACHE_BASELINE_SOURCE)
		expect((await data.fixture.store.read(stageReference(data.handoffStage.manifest))).value).toEqual(data.handoff)
		expect((await data.fixture.store.read("observed_failure")).value).toEqual(data.fixture.source.bundle)
		await expect(materializeRegressionProposal(data.materializationInput)).rejects.toThrow(/exist/i)
		const confirmation = await createWorkflowConfirmation(confirmationInput(data))
		const receipt = await runFreshConfirmation(confirmation.plan, confirmation.sources, confirmation.ports)
		expect(confirmation.requests.map(({ arm }) => arm)).toEqual(["control", "candidate"])
		expect(receipt).toMatchObject({
			status: "keep",
			origin: "fresh-runner",
			evidenceKind: "scripted-host-regression-validation",
			liveQualityImprovement: false,
		})
		expect(receipt.campaigns.control!.observations.map(({ status }) => status)).toContain("outcome_failed")
		expect(receipt.campaigns.candidate!.observations.every(({ status }) => status === "passed")).toBe(true)
		const confirmationStage = await data.fixture.store.write({
			id: "fresh_confirmation",
			stage: "confirmation",
			inputs: [stageReference(data.handoffStage.manifest)],
			value: receipt,
		})
		expect((await data.fixture.store.read(stageReference(confirmationStage.manifest))).value).toEqual(receipt)
		expect((await data.fixture.store.read("observed_failure")).value).toEqual(data.fixture.source.bundle)
		const imported = evaluateConfirmation(confirmation.plan, confirmation.sources, {
			control: receipt.campaigns.control,
			candidate: receipt.campaigns.candidate,
		})
		expect(imported.status).toBe("inconclusive")
		expect(imported.reasons).toContain("Imported or archived outputs do not establish fresh execution")
		// The complete workflow executes several real Node/Git subprocesses and
		// verifies immutable artifact ancestry; individual operation limits remain.
	}, 90_000)

	it("retains original attempt evidence and immutable human adjudication ancestry", async () => {
		const fixture = await observedIteration()
		const feedback = await sealFeedback(humanFeedback(fixture.bundle), fixture.evidence)
		const observation = await fixture.store.write({
			id: "human_observation",
			stage: "feedback",
			inputs: [stageReference(fixture.capture.manifest)],
			value: feedback,
		})
		const review = sealFeedbackReview(
			{
				schemaVersion: 1,
				recordType: "feedback-review",
				id: "human-cache-review",
				createdAt: new Date().toISOString(),
				source: { type: "human", reviewerId: "adjudicating-operator" },
				feedbackDigest: feedback.digest,
				decision: "accepted",
				rationale: "The retained assertion output independently shows the stale derived origin.",
			},
			feedback,
		)
		const reviewed = await fixture.store.write({
			id: "accepted_observation",
			stage: "feedback-review",
			inputs: [stageReference(observation.manifest)],
			value: review,
		})
		expect((await fixture.store.read(stageReference(reviewed.manifest))).value).toEqual(review)
		expect((await fixture.store.read("observed_failure")).value).toEqual(fixture.source.bundle)
		await expect(
			fixture.store.write({
				id: "human_observation",
				stage: "feedback",
				inputs: [stageReference(fixture.capture.manifest)],
				value: { ...feedback, finding: "An overwritten result must never replace the original observation." },
			}),
		).rejects.toThrow(/immutable|different/i)
		expect((await fixture.store.read("human_observation")).value).toEqual(feedback)
	})

	it("rejects changed bundles, other attempts, and invented event or artifact anchors", async () => {
		const fixture = await observedIteration()
		const changed = structuredClone(fixture.source.bundle)
		changed.events[0]!.payload = { status: "passed" }
		await expect(fixture.store.importEvidence(changed, fixture.source.artifactsRoot)).rejects.toThrow(
			/seal|integrity/i,
		)
		for (const evidence of [
			{ ...humanFeedback(fixture.bundle).evidence, attemptId: "another-attempt" },
			{ ...humanFeedback(fixture.bundle).evidence, eventSequence: 99 },
			{ ...humanFeedback(fixture.bundle).evidence, artifactDigest: sha256("invented-verification-output") },
		]) {
			await expect(
				sealFeedback({ ...humanFeedback(fixture.bundle), evidence }, fixture.evidence),
			).rejects.toThrow(/identity|anchor/i)
		}
		expect((await fixture.store.read("observed_failure")).value).toEqual(fixture.source.bundle)
	})

	it("cannot use model self-approval or a review of different feedback", async () => {
		const fixture = await observedIteration()
		const feedback = await sealFeedback(humanFeedback(fixture.bundle), fixture.evidence)
		const input = {
			schemaVersion: 1,
			recordType: "feedback-review",
			id: "review-authority",
			createdAt: new Date().toISOString(),
			source: { type: "human", reviewerId: "operator" },
			feedbackDigest: feedback.digest,
			decision: "accepted",
			rationale: "The original independently observed failure warrants a regression.",
		}
		expect(() =>
			sealFeedbackReview({ ...input, source: { type: "model", reviewerId: "model" } }, feedback),
		).toThrow(/human|schema/i)
		const review = sealFeedbackReview(input, feedback)
		const replacement = await sealFeedback(
			{
				...humanFeedback(fixture.bundle, "replacement-finding"),
				finding: "A different finding cannot inherit the first finding's approval.",
			},
			fixture.evidence,
		)
		expect(() => validateFeedbackReview(review, replacement)).toThrow(/different feedback/i)
		expect(() =>
			sealFeedbackReview(
				{
					...input,
					createdAt: new Date(Date.parse(feedback.createdAt) - 1).toISOString(),
				},
				feedback,
			),
		).toThrow(/predates/i)
	})

	it("keeps artifact reads within their owned root and rejects a symlinked source", async () => {
		const fixture = await observedIteration()
		const outside = path.join(fixture.root, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "private.json"), '{"private":true}')
		await expect(readOwnedFile(fixture.root, "../outside/private.json")).rejects.toThrow(/relative|contained/i)
		const alias = path.join(fixture.root, "alias")
		await fs.symlink(outside, alias, "junction")
		await expect(readOwnedFile(fixture.root, "alias/private.json")).rejects.toThrow(/symlink/i)
		await expect(ImprovementArtifactStore.open({ root: alias, iterationId: "unsafe" })).rejects.toThrow(/symlink/i)
	})

	it("refuses rejected human adjudication, unrelated task evidence, and holdout export before materialization", async () => {
		const fixture = await observedIteration()
		const data = await reviewedDraft(fixture)
		const proposalInput = {
			draft: workflowRegressionDraft(),
			feedback: data.feedback,
			review: data.review,
			sourceTask: data.task,
			policy: data.policy,
			evidence: fixture.evidence,
		}
		await expect(
			createRegressionProposal({ ...proposalInput, review: acceptedReview(data.feedback, "rejected") }),
		).rejects.toThrow(/accepted human review/i)
		await expect(
			createRegressionProposal({
				...proposalInput,
				sourceTask: { ...data.task, id: "unrelated-source" },
				policy: { ...data.policy, allowedSourceTaskIdentities: ["unrelated-source@1"] },
			}),
		).rejects.toThrow(/evidence task/i)
		await expect(
			createRegressionProposal({ ...proposalInput, sourceTask: { ...data.task, partition: "holdout" } }),
		).rejects.toThrow(/holdout/i)
		const noTransport = vi.fn<typeof fetch>()
		await expect(
			runModelReview({
				configuration: {
					endpoint: "https://offline-review.invalid/v1/responses",
					model: "offline-review-fixture",
					apiKeyEnv: "OFFLINE_REVIEW_KEY",
					timeoutMs: 5_000,
					maxRequestBytes: 131_072,
					maxResponseBytes: 131_072,
					maxOutputTokens: 2_048,
				},
				input: { ...data.input, sourceTask: { ...data.task, partition: "holdout" } },
				evidence: fixture.evidence,
				environment: { OFFLINE_REVIEW_KEY: "fixture-credential-only" },
				fetch: noTransport,
			}),
		).rejects.toThrow()
		expect(noTransport).not.toHaveBeenCalled()
		expect((await fixture.store.read("observed_failure")).value).toEqual(fixture.source.bundle)
	})

	it("does not publish a stage when immutable publication fails and keeps prior evidence readable", async () => {
		const fixture = await observedIteration()
		const input = {
			id: "interrupted_publication",
			stage: "feedback" as const,
			inputs: [stageReference(fixture.capture.manifest)],
			value: await sealFeedback(humanFeedback(fixture.bundle), fixture.evidence),
		}
		const publication = vi
			.spyOn(fs, "link")
			.mockRejectedValueOnce(Object.assign(new Error("Injected publication failure"), { code: "EIO" }))
		await expect(fixture.store.write(input)).rejects.toThrow("Injected publication failure")
		expect(publication).toHaveBeenCalledTimes(1)
		publication.mockRestore()
		await expect(fixture.store.read(input.id)).rejects.toMatchObject({ code: "ENOENT" })
		expect((await fixture.store.read("observed_failure")).value).toEqual(fixture.source.bundle)
		const retried = await fixture.store.write(input)
		expect((await fixture.store.read(stageReference(retried.manifest))).value).toEqual(input.value)
	})

	it("rejects generated paths and symlink destinations without overwriting user files", async () => {
		const fixture = await observedIteration()
		const data = await reviewedDraft(fixture)
		const badDraft = workflowRegressionDraft()
		badDraft.files[0]!.path = "../external.mjs"
		await expect(
			createRegressionProposal({
				draft: badDraft,
				feedback: data.feedback,
				review: data.review,
				sourceTask: data.task,
				policy: data.policy,
				evidence: fixture.evidence,
			}),
		).rejects.toThrow(/path|contained/i)
		const destination = path.join(fixture.root, "owned-drafts")
		await fs.mkdir(destination)
		const alias = path.join(fixture.root, "draft-alias")
		await fs.symlink(destination, alias, "junction")
		const materializationInput = {
			proposal: data.proposal,
			selectedProposalDigest: data.proposal.digest,
			ownedRoot: destination,
			destinationName: "../escape",
			policy: data.policy,
			evidence: fixture.evidence,
		}
		await expect(materializeRegressionProposal(materializationInput)).rejects.toThrow()
		await expect(
			materializeRegressionProposal({ ...materializationInput, ownedRoot: alias, destinationName: "candidate" }),
		).rejects.toThrow(/symbolic|symlink/i)
		expect(await fs.readdir(destination)).toEqual([])
	})

	it("retains an incorrect control that fails for the wrong reason and blocks its reviewed repair", async () => {
		const draft = workflowRegressionDraft()
		draft.controls.incorrect[0]!.files[0]!.content =
			'console.error("AssertionError CACHE_DERIVED_ORIGIN_REGRESSION"); throw new Error("unrelated bootstrap failure")\n'
		const data = await generatedWorkflow(draft)
		expect(data.validation.status).not.toBe("passed")
		const wrongReason = data.controls.controls.find(({ id }) => id === "wrong-origin-protocol")!
		expect(wrongReason.status).not.toBe("passed")
		expect(wrongReason.matchedExpectedFailure).toBe(false)
		expect(wrongReason.result.results.flatMap(({ diagnostics }) => diagnostics).length).toBeGreaterThan(0)
		expect(data.handoff.manifest.items[0]!.validation[0]!.status).not.toBe("passed")
		await expect(
			parseReviewedHandoffRepair(repairInput(data), {
				manifest: data.handoff.manifest,
				currentContext: data.context,
				readSource: data.readSource,
			}),
		).rejects.toThrow(/successful offline validation/i)
		expect((await data.fixture.store.read("offline_controls")).value).toEqual(data.controls)
	}, 30_000)

	it("retains an unexecuted gate as inconclusive rather than admitting a drafted regression", async () => {
		const fixture = await observedIteration()
		const data = await reviewedDraft(fixture)
		const ownedRoot = path.join(fixture.root, "unexecuted-drafts")
		await fs.mkdir(ownedRoot)
		const materialized = await materializeRegressionProposal({
			proposal: data.proposal,
			selectedProposalDigest: data.proposal.digest,
			ownedRoot,
			destinationName: "unexecuted",
			policy: data.policy,
			evidence: fixture.evidence,
		})
		const controls = await verifyRegressionControls({
			materialized,
			policy: data.policy,
			executionApproval: { proposalDigest: data.proposal.digest, policyDigest: data.proposal.policyDigest },
		})
		expect(controls).toMatchObject({ status: "inconclusive", controls: [], admission: "draft" })
		expect(materialized.task.admission).toBe("draft")
	})

	it("requires current human review and exact independently read candidate bytes before a fresh run", async () => {
		const data = await generatedWorkflow()
		const revoked = sealFeedbackReview(
			{
				schemaVersion: 1,
				recordType: "feedback-review",
				id: "later-rejection",
				createdAt: new Date(Date.parse(data.review.createdAt) + 1).toISOString(),
				source: { type: "human", reviewerId: "operator" },
				feedbackDigest: data.feedback.digest,
				decision: "rejected",
				rationale: "The observation needs further investigation.",
			},
			data.feedback,
		)
		await expect(
			buildHandoff(
				{ ...data.handoffInput, reviews: [data.review, revoked] },
				{ store: data.fixture.store.artifacts, readSource: data.readSource },
			),
		).rejects.toThrow(/current accepted/i)
		const confirmation = await createWorkflowConfirmation(confirmationInput(data))
		const runCampaign = vi.fn(confirmation.ports.runCampaign)
		await fs.writeFile(path.join(confirmation.sourceRoots.candidate, "src/cache.mjs"), CACHE_BASELINE_SOURCE)
		await expect(
			runFreshConfirmation(confirmation.plan, confirmation.sources, { ...confirmation.ports, runCampaign }),
		).rejects.toThrow(/missing|stale/i)
		expect(runCampaign).not.toHaveBeenCalled()
		const { digest: _digest, ...body } = confirmation.plan
		const { digest: _contextDigest, ...baselineContext } = body.control.context
		const sameSourceContext = sealHarnessContext({
			...baselineContext,
			extensionBuildDigest: body.candidate.context.extensionBuildDigest,
		})
		const sameSourceVariant = {
			...body.control.variant,
			workingTreeDigest: body.candidate.variant.workingTreeDigest,
			extensionBuildDigest: body.candidate.context.extensionBuildDigest,
		}
		expect(() =>
			sealConfirmationPlan({
				...body,
				candidate: { ...body.candidate, context: sameSourceContext, variant: sameSourceVariant },
				experiment: {
					...body.experiment,
					candidateVariantIdentity: immutableIdentity(sameSourceVariant),
					allowedDifferenceFields: ["workingTreeDigest", "extensionBuildDigest"],
				},
			}),
		).toThrow(/actual source change/i)
	}, 30_000)

	it("retains a failed fresh candidate execution instead of treating an archived passing result as confirmation", async () => {
		const data = await generatedWorkflow()
		const confirmation = await createWorkflowConfirmation(confirmationInput(data))
		const runCampaign = vi.fn<typeof confirmation.ports.runCampaign>().mockImplementation(async (request) => {
			if (request.arm === "candidate") throw new Error("Injected fresh candidate execution failure")
			return confirmation.ports.runCampaign(request)
		})
		const receipt = await runFreshConfirmation(confirmation.plan, confirmation.sources, {
			...confirmation.ports,
			runCampaign,
		})
		expect(runCampaign).toHaveBeenCalledTimes(2)
		expect(receipt).toMatchObject({
			status: "inconclusive",
			origin: "fresh-runner",
			liveQualityImprovement: false,
			execution: [
				{ arm: "control", status: "returned" },
				{ arm: "candidate", status: "failed" },
			],
		})
		expect(receipt.campaigns.control!.observations.some(({ status }) => status === "outcome_failed")).toBe(true)
		expect(receipt.campaigns.candidate).toBeNull()
		await data.fixture.store.write({
			id: "failed_fresh_confirmation",
			stage: "confirmation",
			inputs: [stageReference(data.handoffStage.manifest)],
			value: receipt,
		})
		expect((await data.fixture.store.read("failed_fresh_confirmation")).value).toEqual(receipt)
	}, 30_000)
})
