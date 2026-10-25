import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createTaskTemplate } from "../../benchmark/templates"
import { canonicalJson, sha256 } from "../../evidence/canonical"
import { evidenceBundleDigest } from "../../evidence/integrity"
import { workspaceSnapshotTreeDigest } from "../../evidence/workspaceSnapshot"
import { validateGraderRun } from "../../grading/aggregate"
import type { FilesystemGraderSpec, GraderSpec } from "../../grading/types"
import { createDefaultGraderRegistry } from "../../grading/registry"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"
import { systemClock } from "../../orchestration/systemPorts"
import { sealFeedback, sealFeedbackReview } from "../feedback"
import {
	buildHandoff,
	buildRegressionValidation,
	materializeHandoff,
	parseArchivedRegradeReceipt,
	parseHandoff,
	parseRegressionValidationReceipt,
	parseReviewedHandoffRepair,
	parseReviewedHandoffRepairRecord,
	regradeArchivedEvidence,
	sealHarnessContext,
	sealReviewedHandoffRepair,
	validateArchivedGraderSpecs,
	validateHarnessContext,
	type HandoffCandidate,
	type HandoffInput,
} from "../handoff"
import { createRegressionProposal, materializeRegressionProposal, verifyRegressionControls } from "../regressions"
import {
	CACHE_BASELINE_SOURCE,
	CACHE_EXPECTED_BEHAVIOR,
	CACHE_REFERENCE_SOURCE,
	createWorkflowEvidenceFixture,
	workflowRegressionDraft,
	workflowRegressionPolicy,
} from "./workflowFixtures"

function seal<T extends object>(value: T): T & { digest: string } {
	const { digest: _digest, ...content } = value as T & { digest?: string }
	return { ...content, digest: sha256(canonicalJson(content)) } as T & { digest: string }
}

describe("current harness source verification", () => {
	const context = () =>
		sealHarnessContext({
			schemaVersion: 1,
			sourceRevision: "a".repeat(40),
			sourceFiles: [{ path: "src/owned.ts", digest: sha256("source") }],
			harnessDigest: sha256("harness"),
			extensionBuildDigest: sha256("build"),
			taskSetDigest: sha256("tasks"),
			model: { id: "scripted", effort: "scripted" },
		})
	it("retains optional working-tree identity while preserving legacy context seals", async () => {
		const legacy = context()
		expect(legacy).not.toHaveProperty("workingTreeDigest")
		const { digest: _digest, ...unsealed } = legacy
		const workingTreeDigest = sha256("current complete source tree")
		const current = sealHarnessContext({ ...unsealed, workingTreeDigest })
		expect(await validateHarnessContext(current, async () => Buffer.from("source"))).toEqual(current)
		expect(current.workingTreeDigest).toBe(workingTreeDigest)
		expect(current.digest).not.toBe(legacy.digest)
		expect(() => sealHarnessContext({ ...unsealed, workingTreeDigest: "invalid" })).toThrow()
		await expect(
			validateHarnessContext({ ...current, workingTreeDigest: sha256("changed tree") }, async () =>
				Buffer.from("source"),
			),
		).rejects.toThrow(/digest mismatch/)
	})
	it("cancels a deferred reader without returning a trusted context", async () => {
		const controller = new AbortController()
		let release!: (bytes: Uint8Array) => void
		let observed!: () => void
		const started = new Promise<void>((resolve) => {
			observed = resolve
		})
		const pending = validateHarnessContext(
			context(),
			async (_path, signal) => {
				expect(signal).toBeInstanceOf(AbortSignal)
				observed()
				return new Promise<Uint8Array>((resolve) => {
					release = resolve
				})
			},
			{ signal: controller.signal },
		)
		await started
		controller.abort()
		await expect(pending).rejects.toThrow(/cancelled/)
		release(Buffer.from("source"))
	})
	it("bounds a stalled read and rejects unbounded deadlines", async () => {
		vi.useFakeTimers()
		try {
			const pending = validateHarnessContext(context(), async () => new Promise(() => {}), { timeoutMs: 100 })
			const rejection = expect(pending).rejects.toThrow(/deadline/)
			await vi.advanceTimersByTimeAsync(100)
			await rejection
			await expect(
				validateHarnessContext(context(), async () => Buffer.from("source"), { timeoutMs: 30_001 }),
			).rejects.toThrow(/bounded/)
		} finally {
			vi.useRealTimers()
		}
	})
})

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "handoff-")))
	const { bundle, artifacts: store } = await createWorkflowEvidenceFixture(root, "attempt-handoff", "public-source@1")
	const feedback = await sealFeedback(
		{
			schemaVersion: 1,
			recordType: "feedback",
			id: "finding-cache",
			createdAt: "2026-10-23T12:00:00Z",
			source: {
				type: "model",
				reviewerId: "review-model",
				modelIdentity: "scripted-review",
				rubricIdentity: sha256("rubric"),
			},
			finding: "Derived origin remains stale <script>alert(1)</script> [open](command:unsafe).",
			expectedBehavior: CACHE_EXPECTED_BEHAVIOR,
			severity: "high",
			classification: "implementation-defect",
			evidence: {
				runId: bundle.runId,
				trialId: bundle.trialId,
				attemptId: bundle.attemptId,
				bundleDigest: bundle.bundleDigest!,
				eventSequence: 1,
			},
		},
		{ bundle, store },
	)
	const review = sealFeedbackReview(
		{
			schemaVersion: 1,
			recordType: "feedback-review",
			id: "review-cache",
			createdAt: "2026-10-23T13:00:00Z",
			source: { type: "human", reviewerId: "operator" },
			feedbackDigest: feedback.digest,
			decision: "accepted",
			rationale: "The original output reproduces the source contract violation.",
		},
		feedback,
	)
	const policy = workflowRegressionPolicy("public-source@1")
	const proposal = await createRegressionProposal({
		draft: workflowRegressionDraft(),
		feedback,
		review,
		sourceTask: {
			...createTaskTemplate({ id: "public-source", profile: "compact" }),
			fixtureDigest: sha256("source-fixture"),
		},
		evidence: { bundle, store },
		policy,
	})
	const materialized = await materializeRegressionProposal({
		proposal,
		policy,
		selectedProposalDigest: proposal.digest,
		ownedRoot: root,
		destinationName: "generated",
		evidence: { bundle, store },
	})
	// Authored offline fixture only: this injected port tests the producer contract, without an isolation claim.
	const runner = new ExecaHarnessProcessRunner()
	const captured: string[] = []
	const controls = await verifyRegressionControls({
		materialized,
		policy,
		executionApproval: { proposalDigest: proposal.digest, policyDigest: proposal.policyDigest },
		executionBoundary: {
			processRunner: {
				run: async (spec) => {
					const result = await runner.run(spec)
					captured.push(result.stdout, result.stderr)
					return result
				},
			},
			policyDigest: proposal.policyDigest,
			network: "disabled",
		},
	})
	expect(controls.status, captured.join("\n")).toBe("passed")
	const context = sealHarnessContext({
		schemaVersion: 1,
		sourceRevision: "a".repeat(40),
		sourceFiles: [{ path: "src/cache.mjs", digest: sha256(CACHE_BASELINE_SOURCE) }],
		harnessDigest: sha256("harness"),
		extensionBuildDigest: sha256("build"),
		taskSetDigest: sha256("taskset"),
		model: { id: "scripted", effort: "scripted" },
	})
	const readSource = async (relative: string) =>
		relative === "src/cache.mjs" ? Buffer.from(CACHE_BASELINE_SOURCE) : undefined
	const specs: FilesystemGraderSpec[] = [
		{
			id: "original-cache-output",
			version: 1,
			type: "filesystem",
			hardGate: true,
			failureClass: "outcome",
			assertions: [
				{
					kind: "content-equals",
					path: "artifacts/test_output",
					expected: "AssertionError: expected http://localhost:4000; actual http://localhost:3000",
				},
			],
		},
	]
	const options = { store, readSource, ownedRoot: root, destinationName: "retained" }
	const archived = await regradeArchivedEvidence({ proposal, bundle, context, specs }, options)
	const validation = buildRegressionValidation({ proposal, controls, archived: archived.receipt })
	const candidate: HandoffCandidate = {
		id: "repair-cache",
		title: "Invalidate derived origin",
		feedbackDigest: feedback.digest,
		reviewDigest: review.digest,
		regressionProposalDigest: proposal.digest,
		classification: "implementation-defect",
		requirement: { state: "present", references: context.sourceFiles },
		owningPaths: ["src/cache.mjs"],
		allowedChangePaths: ["src/cache.mjs"],
		impact: 4,
		confidence: 90,
		effort: 1,
	}
	const input: HandoffInput = {
		id: "handoff-cache",
		createdAt: "2026-10-23T14:00:00Z",
		context,
		bundles: [bundle],
		feedback: [feedback],
		reviews: [review],
		proposals: [proposal],
		validations: [validation],
		candidates: [candidate],
	}
	return {
		root,
		bundle,
		feedback,
		review,
		proposal,
		controls,
		context,
		readSource,
		specs,
		options,
		archived,
		validation,
		candidate,
		input,
	}
}

describe("ranked evidence handoff", () => {
	let data: Awaited<ReturnType<typeof fixture>>
	beforeAll(async () => {
		data = await fixture()
	}, 60_000)
	afterAll(async () => {
		if (!data) return
		const relative = path.relative(await fs.realpath(os.tmpdir()), data.root)
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error("Unexpected test cleanup scope")
		await fs.rm(data.root, { recursive: true, force: true })
	})

	it("binds real evidence, human adjudication, actual controls and read-only archived grading", async () => {
		const result = await buildHandoff(data.input, data.options)
		expect(parseHandoff(JSON.parse(JSON.stringify(result.manifest)))).toEqual(result.manifest)
		expect(result.manifest.items[0]).toMatchObject({
			source: { type: "model" },
			humanReview: { reviewerId: "operator" },
			freshAgentConfirmation: "required",
			validation: [{ status: "passed", archivedDecision: "passed" }],
		})
		expect(result.markdown).toContain("Observation source: model")
		expect(result.markdown).toContain("Human adjudication: operator")
		expect(result.markdown).not.toContain("<script>")
		expect(result.markdown).not.toContain("](command:")
		expect(
			await fs.readFile(path.join(data.archived.reconstructionRoot, "artifacts", "test_output"), "utf8"),
		).toContain("AssertionError")
	})

	it("ranks severity, impact, confidence, effort and ID deterministically, independently of input order", async () => {
		const candidates = [
			{ ...data.candidate, id: "b", effort: 2 },
			{ ...data.candidate, id: "a", effort: 2 },
			{ ...data.candidate, id: "higher-confidence", confidence: 91, effort: 5 },
			{ ...data.candidate, id: "higher-impact", impact: 5, confidence: 1 },
		]
		const first = await buildHandoff({ ...data.input, candidates }, data.options)
		const second = await buildHandoff({ ...data.input, candidates: [...candidates].reverse() }, data.options)
		expect(first.manifest.digest).toBe(second.manifest.digest)
		expect(first.manifest.items.map(({ id }) => id)).toEqual(["higher-impact", "higher-confidence", "a", "b"])
	})

	it("retains a failed archived outcome separately from passing offline controls", async () => {
		const specs = structuredClone(data.specs)
		specs[0]!.assertions = [
			{ kind: "content-equals", path: "artifacts/final_response", expected: "Verification succeeded." },
		]
		const { receipt } = await regradeArchivedEvidence(
			{ proposal: data.proposal, bundle: data.bundle, context: data.context, specs },
			{ ...data.options, destinationName: "failed-output" },
		)
		expect(receipt.result.decision).toBe("outcome_failed")
		const validation = buildRegressionValidation({
			proposal: data.proposal,
			controls: data.controls,
			archived: receipt,
		})
		expect(validation.status).toBe("passed")
		const result = await buildHandoff({ ...data.input, validations: [validation] }, data.options)
		expect(result.manifest.items[0]!.validation[0]).toMatchObject({
			status: "passed",
			archivedDecision: "outcome_failed",
		})
	})

	it.each(["workspace/src/protected.mjs", "artifacts/full_output"])(
		"rejects absence claims about uncaptured archive data at %s",
		async (unretainedPath) => {
			const specs: FilesystemGraderSpec[] = [
				{ ...data.specs[0]!, assertions: [{ kind: "absent", path: unretainedPath }] },
			]
			await expect(
				regradeArchivedEvidence(
					{ proposal: data.proposal, bundle: data.bundle, context: data.context, specs },
					{
						...data.options,
						destinationName: `unretained-${unretainedPath.startsWith("workspace/") ? "workspace" : "artifact"}`,
					},
				),
			).rejects.toThrow(/not retained/)
		},
	)

	it("refuses to reuse a historical green archive receipt for an uncaptured workspace", async () => {
		const specs: FilesystemGraderSpec[] = [
			{ ...data.specs[0]!, assertions: [{ kind: "absent", path: "workspace/src/protected.mjs" }] },
		]
		const result = validateGraderRun(
			JSON.parse(
				canonicalJson(
					await createDefaultGraderRegistry().execute(specs, {
						workspaceRoot: data.archived.reconstructionRoot,
						changedPaths: [],
						trace: [],
						clock: systemClock,
						processRunner: {
							run: async () => {
								throw new Error("Unexpected execution")
							},
						},
					}),
				),
			),
		)
		expect(result.decision).toBe("passed")
		const archived = parseArchivedRegradeReceipt(
			seal({
				...data.archived.receipt,
				specs,
				specsDigest: sha256(canonicalJson(specs)),
				result,
				resultDigest: sha256(canonicalJson(result)),
			}),
		)
		const validation = buildRegressionValidation({ proposal: data.proposal, controls: data.controls, archived })
		await expect(buildHandoff({ ...data.input, validations: [validation] }, data.options)).rejects.toThrow(
			/not retained/,
		)
	})

	it("permits absence checks when a verified complete workspace snapshot was retained", async () => {
		const snapshot = {
			schemaVersion: 1 as const,
			files: [
				{
					path: "src/cache.mjs",
					bytesBase64: Buffer.from(CACHE_BASELINE_SOURCE).toString("base64"),
					digest: sha256(CACHE_BASELINE_SOURCE),
					executable: false,
				},
			],
		}
		const bundle = structuredClone(data.bundle)
		const workspace = await data.options.store.put({
			attemptId: bundle.attemptId,
			kind: "workspace_snapshot",
			bytes: Buffer.from(canonicalJson(snapshot)),
			mediaType: "application/json",
			access: "private",
		})
		const tree = await data.options.store.put({
			attemptId: bundle.attemptId,
			kind: "tree_digest",
			bytes: Buffer.from(workspaceSnapshotTreeDigest(snapshot)),
			mediaType: "text/plain",
			access: "private",
		})
		bundle.artifacts = [...bundle.artifacts.filter(({ kind }) => kind !== "tree_digest"), tree, workspace]
		bundle.bundleDigest = evidenceBundleDigest(bundle)
		const { digest: _feedbackDigest, ...feedbackInput } = data.feedback
		const feedback = await sealFeedback(
			{ ...feedbackInput, evidence: { ...feedbackInput.evidence, bundleDigest: bundle.bundleDigest } },
			{ bundle, store: data.options.store },
		)
		const { digest: _reviewDigest, ...reviewInput } = data.review
		const review = sealFeedbackReview({ ...reviewInput, feedbackDigest: feedback.digest }, feedback)
		const proposal = await createRegressionProposal({
			draft: data.proposal.draft,
			feedback,
			review,
			sourceTask: {
				...createTaskTemplate({ id: "public-source", profile: "compact" }),
				fixtureDigest: sha256("source-fixture"),
			},
			policy: data.proposal.policy,
			evidence: { bundle, store: data.options.store },
		})
		const specs: FilesystemGraderSpec[] = [
			{
				...data.specs[0]!,
				assertions: [
					{ kind: "content-equals", path: "workspace/src/cache.mjs", expected: CACHE_BASELINE_SOURCE },
					{ kind: "absent", path: "workspace/src/protected.mjs" },
				],
			},
		]
		const archived = await regradeArchivedEvidence(
			{ proposal, bundle, context: data.context, specs },
			{
				...data.options,
				destinationName: "captured-workspace",
			},
		)
		expect(archived.receipt.result.decision).toBe("passed")
	})

	it("uses the bounded verified CAS snapshot and cancels stalled archival reads before creating output", async () => {
		let reads = 0
		const get = vi.fn(async (artifact: Parameters<typeof data.options.store.get>[0]) => {
			if (++reads > data.bundle.artifacts.length) throw new Error("Unexpected unbounded second CAS pass")
			return data.options.store.get(artifact)
		})
		await regradeArchivedEvidence(
			{ proposal: data.proposal, bundle: data.bundle, context: data.context, specs: data.specs },
			{
				...data.options,
				destinationName: "cached-archive",
				store: { put: (value) => data.options.store.put(value), get },
			},
		)
		expect(get.mock.calls.length).toBeLessThanOrEqual(data.bundle.artifacts.length)
		const controller = new AbortController()
		let observed!: () => void
		let release!: (bytes: Uint8Array | undefined) => void
		const started = new Promise<void>((resolve) => {
			observed = resolve
		})
		const pending = regradeArchivedEvidence(
			{ proposal: data.proposal, bundle: data.bundle, context: data.context, specs: data.specs },
			{
				...data.options,
				destinationName: "cancelled-archive",
				signal: controller.signal,
				store: {
					put: (value) => data.options.store.put(value),
					get: async () => {
						observed()
						return new Promise<Uint8Array | undefined>((resolve) => {
							release = resolve
						})
					},
				},
			},
		)
		await started
		controller.abort()
		await expect(pending).rejects.toThrow(/integrity verification/)
		release(undefined)
		await expect(fs.stat(path.join(data.root, "cancelled-archive"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects accessor metadata before cloning or invoking untrusted getters", async () => {
		const getter = vi.fn(() => {
			throw new Error("Getter must never execute")
		})
		const bundle = Object.defineProperty({ ...data.bundle }, "events", { get: getter, enumerable: true })
		await expect(
			regradeArchivedEvidence(
				{ proposal: data.proposal, bundle, context: data.context, specs: data.specs },
				{
					...data.options,
					destinationName: "accessor-archive",
				},
			),
		).rejects.toThrow(/accessors/)
		expect(getter).not.toHaveBeenCalled()
	})

	it("rejects missing gates, stale source, hash tampering and unsupported provenance", async () => {
		await expect(buildHandoff({ ...data.input, validations: [] }, data.options)).rejects.toThrow(/requires bounded/)
		await expect(validateHarnessContext(data.context, async () => Buffer.from("changed"))).rejects.toThrow(/stale/)
		await expect(
			buildHandoff(
				{ ...data.input, candidates: [{ ...data.candidate, allowedChangePaths: ["src/other.mjs"] }] },
				data.options,
			),
		).rejects.toThrow(/source hash/)
		const forged = structuredClone(data.validation)
		forged.archived.result.decision = "outcome_failed"
		expect(() => parseRegressionValidationReceipt(forged)).toThrow()
		expect(() =>
			parseArchivedRegradeReceipt(seal({ ...data.archived.receipt, resultDigest: sha256("fabricated") })),
		).toThrow(/fabricated/)
	})

	it("requires current accepted human review, including later rejection superseding an acceptance", async () => {
		const rejected = sealFeedbackReview(
			{
				schemaVersion: 1,
				recordType: "feedback-review",
				id: "rejected-later",
				createdAt: "2026-10-23T13:30:00Z",
				source: { type: "human", reviewerId: "operator" },
				feedbackDigest: data.feedback.digest,
				decision: "rejected",
				rationale: "The original interpretation needs revision.",
			},
			data.feedback,
		)
		await expect(buildHandoff({ ...data.input, reviews: [data.review, rejected] }, data.options)).rejects.toThrow(
			/current accepted/,
		)
		await expect(buildHandoff({ ...data.input, reviews: [] }, data.options)).rejects.toThrow()
	})

	it.each(["../escape", "C:/escape", "src/CON.txt", "src/trailing.", ".git/config"])(
		"rejects unsafe scope %s",
		async (unsafe) => {
			await expect(
				buildHandoff(
					{ ...data.input, candidates: [{ ...data.candidate, allowedChangePaths: [unsafe] }] },
					data.options,
				),
			).rejects.toThrow()
		},
	)

	it("distinguishes missing requirements from existing unenforced contracts", async () => {
		await expect(
			buildHandoff(
				{ ...data.input, candidates: [{ ...data.candidate, classification: "missing-requirement" }] },
				data.options,
			),
		).rejects.toThrow(/distinguish/)
		const result = await buildHandoff(
			{ ...data.input, candidates: [{ ...data.candidate, classification: "existing-unenforced" }] },
			data.options,
		)
		expect(result.manifest.items[0]!.classification).toBe("existing-unenforced")
	})

	it("blocks command execution, traversal, ambiguous archive destinations and overwrites", async () => {
		expect(() =>
			validateArchivedGraderSpecs([
				{
					...data.specs[0]!,
					assertions: [{ kind: "content-matches", path: "artifacts/test_output", pattern: "(a+)+$" }],
				},
			]),
		).toThrow(/regular expressions/)
		expect(() =>
			validateArchivedGraderSpecs([
				{
					id: "execute",
					version: 1,
					type: "command",
					hardGate: true,
					failureClass: "outcome",
					commands: [{ command: "node", args: ["-e", "throw 0"] }],
					cwd: "workspace",
					timeoutMs: 1,
					maxOutputBytes: 1,
				},
			]),
		).toThrow(/read-only/)
		const specs: GraderSpec[] = [
			{ ...data.specs[0]!, assertions: [{ kind: "exists", path: "artifacts/../../escape" }] },
		]
		expect(() => validateArchivedGraderSpecs(specs)).toThrow()
		await expect(
			regradeArchivedEvidence(
				{ proposal: data.proposal, bundle: data.bundle, context: data.context, specs: data.specs },
				data.options,
			),
		).rejects.toThrow(/exist/i)
	})

	it("rejects a symlink archive root when the host permits link creation", async (context) => {
		const target = path.join(data.root, "linked-target")
		await fs.mkdir(target)
		const alias = path.join(data.root, "linked-root")
		try {
			await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
		} catch (error) {
			if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				context.skip()
				return
			}
			throw error
		}
		await expect(
			regradeArchivedEvidence(
				{ proposal: data.proposal, bundle: data.bundle, context: data.context, specs: data.specs },
				{ ...data.options, ownedRoot: alias, destinationName: "new" },
			),
		).rejects.toThrow(/symlink/)
	})

	it("adapts a reviewed scoped patch to CampaignRepair without modifying any source", async () => {
		const { manifest } = await buildHandoff(data.input, data.options)
		const review = sealReviewedHandoffRepair({
			schemaVersion: 1,
			recordType: "reviewed-handoff-repair",
			handoffDigest: manifest.digest,
			itemDigest: manifest.items[0]!.digest,
			contextDigest: data.context.digest,
			source: { type: "human", reviewerId: "operator" },
			decision: "accepted",
			scenarioId: "cache-repair",
			regressionScenarioId: data.proposal.draft.id,
			neighborScenarioIds: ["cache-first-read"],
			patch: {
				id: "cache-invalidate",
				edits: [
					{
						path: "src/cache.mjs",
						expectedSha256: sha256(CACHE_BASELINE_SOURCE).slice(7),
						replacement: CACHE_REFERENCE_SOURCE,
					},
				],
			},
		})
		expect(parseReviewedHandoffRepairRecord(review)).toEqual(review)
		const result = await parseReviewedHandoffRepair(review, {
			manifest,
			currentContext: data.context,
			readSource: data.readSource,
		})
		expect(result).toMatchObject({
			diagnosisId: "repair-cache",
			patch: review.patch,
			regressionScenarioId: data.proposal.draft.id,
		})
		await expect(
			parseReviewedHandoffRepair(
				seal({
					...review,
					patch: { ...review.patch, edits: [{ ...review.patch.edits[0]!, path: "src/other.mjs" }] },
				}),
				{ manifest, currentContext: data.context, readSource: data.readSource },
			),
		).rejects.toThrow(/scope/)
		const { digest: _digest, ...unsealed } = review
		expect(() =>
			sealReviewedHandoffRepair({ ...unsealed, source: { type: "model", reviewerId: "model" } }),
		).toThrow()
	})

	it("writes review artifacts exclusively without executing or overwriting a repair", async () => {
		const { manifest, markdown } = await buildHandoff(data.input, data.options)
		const options = { ownedRoot: data.root, destinationName: "review-output" }
		const output = await materializeHandoff(manifest, options)
		expect(JSON.parse(await fs.readFile(output.manifestPath, "utf8"))).toEqual(manifest)
		expect(await fs.readFile(output.markdownPath, "utf8")).toBe(markdown)
		await expect(materializeHandoff(manifest, options)).rejects.toThrow(/exist/i)
		expect(await data.readSource("src/cache.mjs")).toEqual(Buffer.from(CACHE_BASELINE_SOURCE))
	})
})
