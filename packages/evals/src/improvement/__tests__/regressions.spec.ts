import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createTaskTemplate } from "../../benchmark/templates"
import { benchmarkTaskManifestSchema } from "../../benchmark/contracts"
import { FilesystemArtifactStore } from "../../evidence/artifactStore"
import { canonicalJson, sha256 } from "../../evidence/canonical"
import { collectRequiredEvidence } from "../../evidence/collector"
import { EventJournal } from "../../evidence/eventJournal"
import { evidenceBundleDigest } from "../../evidence/integrity"
import type { EvidenceBundle } from "../../evidence/types"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"
import { sealFeedback, sealFeedbackReview } from "../feedback"
import {
	createRegressionProposal,
	materializeRegressionProposal,
	parseRegressionControlReceipt,
	parseRegressionProposal,
	verifyRegressionControls,
	type RegressionDraft,
	type RegressionHostPolicy,
} from "../regressions"

const temporary: string[] = []
afterEach(async () => {
	for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function setup() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "regression-proposal-")))
	temporary.push(root)
	const store = new FilesystemArtifactStore(path.join(root, "cas"))
	const sourceTask = {
		...createTaskTemplate({ id: "public-source", profile: "compact" }),
		fixtureDigest: sha256("original-fixture"),
	}
	const journal = new EventJournal({ runId: "run-1", trialId: "trial-1", attemptId: "attempt-1" })
	journal.append("attempt.completed", { status: "failed" })
	const bundle: EvidenceBundle = {
		schemaVersion: 1,
		runId: "run-1",
		trialId: "trial-1",
		attemptId: "attempt-1",
		taskIdentity: "public-source@1",
		variantIdentity: "variant@1",
		identityStatus: "attempt-bound",
		events: journal.all(),
		artifacts: await collectRequiredEvidence(
			"attempt-1",
			{
				final_diff: "diff",
				git_status: "status",
				tree_digest: "tree",
				transcript: "transcript",
				final_response: "response",
				test_output: "failed assertion",
				extension_log: "log",
				environment_manifest: "environment",
				usage: "usage",
				stop_reason: "failed",
			},
			store,
		),
	}
	bundle.bundleDigest = evidenceBundleDigest(bundle)
	const evidence = { bundle, store }
	const expectedBehavior = "Sum positive integers and ignore negative inputs."
	const feedback = await sealFeedback(
		{
			schemaVersion: 1,
			recordType: "feedback",
			id: "finding-1",
			createdAt: "2026-10-23T12:00:00Z",
			source: {
				type: "model",
				reviewerId: "review-model",
				modelIdentity: "scripted-review",
				rubricIdentity: sha256("rubric"),
			},
			finding: "Negative quantities are included in the total.",
			expectedBehavior,
			severity: "medium",
			classification: "implementation-defect",
			evidence: {
				runId: bundle.runId,
				trialId: bundle.trialId,
				attemptId: bundle.attemptId,
				bundleDigest: bundle.bundleDigest,
			},
		},
		evidence,
	)
	const review = sealFeedbackReview(
		{
			schemaVersion: 1,
			recordType: "feedback-review",
			id: "review-1",
			createdAt: "2026-10-23T13:00:00Z",
			source: { type: "human", reviewerId: "reviewer" },
			feedbackDigest: feedback.digest,
			decision: "accepted",
			rationale: "The retained assertion demonstrates the missing filter.",
		},
		feedback,
	)
	const patch = (content: string) => [{ path: "src/total.mjs", content }]
	const draft: RegressionDraft = {
		id: "positive-total",
		prompt: "Repair the total function without changing tests.",
		expectedBehavior,
		files: patch("export function total(values) { return values.reduce((a, b) => a + b, 0) }\n"),
		verifier: {
			files: [
				{
					path: "test/total.test.mjs",
					content: `import test from "node:test"
import assert from "node:assert/strict"
import { total } from "../src/total.mjs"
test("positive totals", () => {
  assert.equal(total([2, -4, 3]), 5, "REGRESSION_POSITIVE_TOTAL")
  assert.equal(total([]), 0, "REGRESSION_POSITIVE_TOTAL")
  assert.equal(total([0, 1, 1]), 2, "REGRESSION_POSITIVE_TOTAL")
})\n`,
				},
			],
			commands: [{ command: "node", args: ["--test", "test/total.test.mjs"] }],
			failureMarker: "REGRESSION_POSITIVE_TOTAL",
		},
		controls: {
			reference: patch(
				"export function total(values) { return values.filter(x => x > 0).reduce((a, b) => a + b, 0) }\n",
			),
			alternative: patch(
				"export function total(values) { let sum = 0; for (const value of values) if (value >= 0) sum += value; return sum }\n",
			),
			incorrect: [
				{ id: "returns-zero", files: patch("export function total() { return 0 }\n") },
				{
					id: "counts-absolute",
					files: patch(
						"export function total(values) { return values.reduce((a, b) => a + Math.abs(b), 0) }\n",
					),
				},
				{
					id: "first-only",
					files: patch("export function total(values) { return values.find(x => x > 0) ?? 0 }\n"),
				},
			],
		},
	}
	const policy: RegressionHostPolicy = {
		schemaVersion: 1,
		allowedSourceTaskIdentities: ["public-source@1"],
		allowedCommands: draft.verifier.commands,
		maxFiles: 8,
		maxBytes: 65_536,
		network: "disabled",
	}
	return { root, draft, feedback, review, sourceTask, evidence, policy }
}

describe("reviewed feedback regression materialization", () => {
	it("materializes reconstructable draft provenance and executes real original/alternative/mutant grader controls only after explicit code approval", async () => {
		const input = await setup()
		const proposal = await createRegressionProposal(input)
		expect(Object.isFrozen(proposal.draft.controls.reference)).toBe(true)
		const materialized = await materializeRegressionProposal({
			...input,
			proposal,
			selectedProposalDigest: proposal.digest,
			ownedRoot: input.root,
			destinationName: "selected",
		})
		expect(benchmarkTaskManifestSchema.parse(materialized.task)).toMatchObject({
			admission: "draft",
			improvement: {
				feedbackDigest: input.feedback.digest,
				reviewDigest: input.review.digest,
				proposalDigest: proposal.digest,
			},
		})
		expect(parseRegressionProposal(JSON.parse(await fs.readFile(materialized.provenancePath, "utf8")))).toEqual(
			proposal,
		)
		const approval = { proposalDigest: proposal.digest, policyDigest: proposal.policyDigest }
		const absent = await verifyRegressionControls({
			materialized,
			policy: input.policy,
			executionApproval: approval,
		})
		expect(absent).toMatchObject({ status: "inconclusive", controls: [], admission: "draft" })
		// This known authored fixture exercises the real grader. The injected test runner models the
		// trusted host boundary; it does not establish network isolation for the local machine.
		const receipt = await verifyRegressionControls({
			materialized,
			policy: input.policy,
			executionApproval: approval,
			executionBoundary: {
				processRunner: new ExecaHarnessProcessRunner(),
				policyDigest: proposal.policyDigest,
				network: "disabled",
			},
		})
		expect(
			receipt.status,
			JSON.stringify(
				receipt.controls.map(({ id, status, matchedExpectedFailure, result }) => ({
					id,
					status,
					matchedExpectedFailure,
					result,
				})),
			),
		).toBe("passed")
		expect(receipt.controls).toHaveLength(6)
		expect(
			receipt.controls.filter(({ expectedPassed, status }) => expectedPassed && status === "passed"),
		).toHaveLength(2)
		expect(
			receipt.controls.filter(
				({ expectedPassed, matchedExpectedFailure }) => !expectedPassed && matchedExpectedFailure,
			),
		).toHaveLength(4)
		expect(parseRegressionControlReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt)
		expect(materialized.task.admission).toBe("draft")
		await expect(
			materializeRegressionProposal({
				...input,
				proposal,
				selectedProposalDigest: proposal.digest,
				ownedRoot: input.root,
				destinationName: "selected",
			}),
		).rejects.toThrow()
	}, 60_000)

	it.each([
		["syntax failure", "export function broken( {"],
		[
			"printed assertion marker",
			"console.error('AssertionError REGRESSION_POSITIVE_TOTAL'); export function total() { throw new Error('unrelated bootstrap failure') }",
		],
		[
			"forged assertion error code",
			"export function total() { throw Object.assign(new Error('REGRESSION_POSITIVE_TOTAL'), { code: 'ERR_ASSERTION' }) }",
		],
	])(
		"rejects %s as a wrong-reason negative control",
		async (_name, content) => {
			const input = await setup()
			input.draft.controls.incorrect[0]!.files[0]!.content = content
			const proposal = await createRegressionProposal(input)
			const materialized = await materializeRegressionProposal({
				...input,
				proposal,
				selectedProposalDigest: proposal.digest,
				ownedRoot: input.root,
				destinationName: "wrong-reason",
			})
			const receipt = await verifyRegressionControls({
				materialized,
				policy: input.policy,
				executionApproval: { proposalDigest: proposal.digest, policyDigest: proposal.policyDigest },
				executionBoundary: {
					processRunner: new ExecaHarnessProcessRunner(),
					policyDigest: proposal.policyDigest,
					network: "disabled",
				},
			})
			expect(receipt.status).toBe("failed")
			expect(receipt.controls.find(({ id }) => id === "returns-zero")?.matchedExpectedFailure).toBe(false)
		},
		60_000,
	)

	it("rejects holdout sources, altered review ancestry and widened host commands", async () => {
		const input = await setup()
		await expect(
			createRegressionProposal({ ...input, sourceTask: { ...input.sourceTask, partition: "holdout" } }),
		).rejects.toThrow(/Holdout/)
		await expect(
			createRegressionProposal({ ...input, review: { ...input.review, feedbackDigest: sha256("other") } }),
		).rejects.toThrow()
		await expect(
			createRegressionProposal({
				...input,
				draft: {
					...input.draft,
					verifier: {
						...input.draft.verifier,
						commands: [{ command: "node", args: ["-e", "process.exit(0)"] }],
					},
				},
			}),
		).rejects.toThrow(/policy/)
		const { digest: _digest, ...reviewInput } = input.review
		await expect(
			createRegressionProposal({
				...input,
				review: sealFeedbackReview({ ...reviewInput, decision: "needs-info" }, input.feedback),
			}),
		).rejects.toThrow()
	})

	it.each(["prompt", "source", "verifier", "reference", "alternative", "incorrect"] as const)(
		"rejects configured secrets in generated %s bytes before sealing a public proposal",
		async (location) => {
			const input = await setup()
			const secret = "SYNTHETIC_PRIVATE_EVAL_VALUE_42"
			if (location === "prompt") input.draft.prompt += ` ${secret}`
			else {
				const files =
					location === "source"
						? input.draft.files
						: location === "verifier"
							? input.draft.verifier.files
							: location === "incorrect"
								? input.draft.controls.incorrect[0]!.files
								: input.draft.controls[location]
				files[0]!.content += `\n// ${secret}\n`
			}
			await expect(
				createRegressionProposal({ ...input, evidence: { ...input.evidence, secrets: [secret] } }),
			).rejects.toThrow(/credentials|secrets/)
		},
	)

	it("rechecks newly configured secrets before materializing previously sealed draft bytes", async () => {
		const input = await setup()
		const secret = "SYNTHETIC_NEWLY_CONFIGURED_EVAL_VALUE_42"
		input.draft.files[0]!.content += `\n// ${secret}\n`
		const proposal = await createRegressionProposal(input)
		const destinationName = "private-draft"
		await expect(
			materializeRegressionProposal({
				...input,
				evidence: { ...input.evidence, secrets: [secret] },
				proposal,
				selectedProposalDigest: proposal.digest,
				ownedRoot: input.root,
				destinationName,
			}),
		).rejects.toThrow(/credentials|secrets/)
		await expect(fs.stat(path.join(input.root, destinationName))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("checks accepted review text for configured secrets before sealing its proposal", async () => {
		const input = await setup()
		const secret = "SYNTHETIC_PRIVATE_REVIEW_VALUE_42"
		const { digest: _digest, ...review } = input.review
		input.review = sealFeedbackReview({ ...review, rationale: `Reviewed ${secret}` }, input.feedback)
		await expect(
			createRegressionProposal({ ...input, evidence: { ...input.evidence, secrets: [secret] } }),
		).rejects.toThrow(/credentials|secrets/)
	})

	it("rejects credential-shaped draft text when parsing a sealed proposal", async () => {
		const input = await setup()
		const { digest: _digest, ...proposal } = await createRegressionProposal(input)
		const content = {
			...proposal,
			draft: { ...proposal.draft, prompt: "Authorization: Bearer syntheticCredentialValue123456" },
		}
		expect(() => parseRegressionProposal({ ...content, digest: sha256(canonicalJson(content)) })).toThrow(
			/credentials/,
		)
	})

	it("rejects non-JSON evidence before snapshotting can invoke an untrusted accessor", async () => {
		const input = await setup()
		const getter = vi.fn(() => {
			throw new Error("Untrusted accessor was evaluated")
		})
		Object.defineProperty(input.evidence.bundle.events[0]!, "payload", { enumerable: true, get: getter })
		await expect(createRegressionProposal(input)).rejects.toThrow(/accessors/)
		expect(getter).not.toHaveBeenCalled()
	})

	it.each([
		"../escape.mjs",
		"C:/escape.mjs",
		"/escape.mjs",
		"src/../../escape.mjs",
		"src/CON.txt",
		"AGENTS.md",
		"src/alias.",
	])("rejects untrusted file path %s", async (file) => {
		const input = await setup()
		input.draft.files[0]!.path = file
		await expect(createRegressionProposal(input)).rejects.toThrow()
	})

	it("rejects case-insensitive duplicates, verifier replacements, overlarge files and command authority embedded in draft fields", async () => {
		const input = await setup()
		await expect(
			createRegressionProposal({
				...input,
				draft: {
					...input.draft,
					files: [...input.draft.files, { ...input.draft.files[0]!, path: "SRC/TOTAL.MJS" }],
				},
			}),
		).rejects.toThrow(/Duplicate/)
		await expect(
			createRegressionProposal({
				...input,
				draft: {
					...input.draft,
					controls: { ...input.draft.controls, reference: [{ path: "test/total.test.mjs", content: "" }] },
				},
			}),
		).rejects.toThrow(/source/)
		await expect(createRegressionProposal({ ...input, policy: { ...input.policy, maxBytes: 1 } })).rejects.toThrow(
			/bounds/,
		)
		await expect(
			createRegressionProposal({ ...input, draft: { ...input.draft, approval: "auto" } }),
		).rejects.toThrow()
		await expect(
			createRegressionProposal({
				...input,
				draft: {
					...input.draft,
					controls: {
						...input.draft.controls,
						incorrect: input.draft.controls.incorrect.map((control, index) =>
							index === 0 ? { ...control, files: input.draft.files } : control,
						),
					},
				},
			}),
		).rejects.toThrow(/distinct/)
	})

	it("rejects unselected proposals, policy changes and tampered expected files before executing anything", async () => {
		const input = await setup()
		const proposal = await createRegressionProposal(input)
		await expect(
			materializeRegressionProposal({
				...input,
				proposal,
				selectedProposalDigest: "",
				ownedRoot: input.root,
				destinationName: "not-selected",
			}),
		).rejects.toThrow(/selection/)
		await expect(
			materializeRegressionProposal({
				...input,
				proposal,
				selectedProposalDigest: proposal.digest,
				ownedRoot: input.root,
				destinationName: "changed-policy",
				policy: { ...input.policy, maxBytes: 10 },
			}),
		).rejects.toThrow(/policy/)
		const materialized = await materializeRegressionProposal({
			...input,
			proposal,
			selectedProposalDigest: proposal.digest,
			ownedRoot: input.root,
			destinationName: "tampered",
		})
		const verifier = path.join(materialized.fixtureRoot, "test/total.test.mjs")
		const handle = await fs.open(verifier, "r+")
		await handle.truncate(1_000_000)
		await handle.close()
		await expect(
			verifyRegressionControls({
				materialized,
				policy: input.policy,
				executionApproval: { proposalDigest: proposal.digest, policyDigest: proposal.policyDigest },
			}),
		).rejects.toThrow(/size/)
	})

	it("propagates cancellation to the active process, stops later controls and cleans its owned workspaces", async () => {
		const input = await setup()
		const proposal = await createRegressionProposal(input)
		const materialized = await materializeRegressionProposal({
			...input,
			proposal,
			selectedProposalDigest: proposal.digest,
			ownedRoot: input.root,
			destinationName: "cancelled",
		})
		const controller = new AbortController()
		let calls = 0
		await expect(
			verifyRegressionControls({
				materialized,
				policy: input.policy,
				executionApproval: { proposalDigest: proposal.digest, policyDigest: proposal.policyDigest },
				signal: controller.signal,
				executionBoundary: {
					network: "disabled",
					policyDigest: proposal.policyDigest,
					processRunner: {
						run: async (spec) => {
							calls++
							expect(spec.signal).toBe(controller.signal)
							controller.abort(new Error("Operator cancelled controls"))
							return {
								exitCode: 0,
								stdout: "",
								stderr: "",
								durationMs: 0,
								timedOut: false,
								outputTruncated: false,
							}
						},
					},
				},
			}),
		).rejects.toThrow(/cancelled/)
		expect(calls).toBe(1)
		expect((await fs.readdir(materialized.root)).filter((name) => name.startsWith("verification-"))).toEqual([])
	})

	it("rejects symbolic-link ownership roots when the platform permits creating a link", async (context) => {
		const input = await setup()
		const proposal = await createRegressionProposal(input)
		const target = path.join(input.root, "actual")
		await fs.mkdir(target)
		const link = path.join(input.root, "linked")
		try {
			await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir")
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				["EPERM", "ENOSYS", "EACCES"].includes(String(error.code))
			)
				context.skip()
			throw error
		}
		await expect(
			materializeRegressionProposal({
				...input,
				proposal,
				selectedProposalDigest: proposal.digest,
				ownedRoot: link,
				destinationName: "escape",
			}),
		).rejects.toThrow(/symbolic/)
	})

	it("rejects unapproved directory trees and fabricated passed receipt metadata", async () => {
		const input = await setup()
		const proposal = await createRegressionProposal(input)
		const materialized = await materializeRegressionProposal({
			...input,
			proposal,
			selectedProposalDigest: proposal.digest,
			ownedRoot: input.root,
			destinationName: "extra-tree",
		})
		await fs.mkdir(path.join(materialized.fixtureRoot, "unapproved"))
		await expect(
			verifyRegressionControls({
				materialized,
				policy: input.policy,
				executionApproval: { proposalDigest: proposal.digest, policyDigest: proposal.policyDigest },
			}),
		).rejects.toThrow(/directory/)
		const content = {
			schemaVersion: 1,
			recordType: "regression-control-receipt",
			proposalDigest: proposal.digest,
			policyDigest: proposal.policyDigest,
			fixtureDigest: materialized.task.fixtureDigest,
			failureMarker: proposal.draft.verifier.failureMarker,
			evidenceKind: "offline-fixture-control",
			status: "passed",
			controls: [],
			admission: "draft",
		}
		expect(() => parseRegressionControlReceipt({ ...content, digest: sha256(canonicalJson(content)) })).toThrow(
			/contradicts/,
		)
	})
})
