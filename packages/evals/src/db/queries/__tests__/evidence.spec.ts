import { describe, expect, it } from "vitest"

import {
	EventJournal,
	manifestIdentity,
	type ArtifactDescriptor,
	type TaskManifest,
	type VariantManifest,
} from "../../../evidence/index"
import {
	getArtifactDescriptors,
	getEvalEvents,
	getPresentationModelCallPolicyEvents,
	getReconstructableEvidenceBundle,
	persistArtifactDescriptors,
	persistEvalEvent,
	recordEvidenceIntegrity,
	persistRuntimeIdentities,
	getRuntimeVariantManifest,
} from "../evidence"
import { ensureAttempt } from "../lifecycle"
import { createRun } from "../runs"
import { createTask } from "../tasks"

describe("M4 evidence persistence", () => {
	it("isolates presentation policy evidence by attempt and type without loading other event payloads", async () => {
		const run = await createRun({ model: "test", socketPath: "policy-evidence.sock" })
		const task = await createTask({ runId: run.id, language: "javascript", exercise: "policy-evidence" })
		const attempt = await ensureAttempt(task.id, 1)
		const foreignTask = await createTask({
			runId: run.id,
			language: "javascript",
			exercise: "foreign-policy-evidence",
		})
		const foreignAttempt = await ensureAttempt(foreignTask.id, 1)
		const journal = new EventJournal({ runId: String(run.id), trialId: "trial", attemptId: String(attempt.id) })
		const foreignJournal = new EventJournal({
			runId: String(run.id),
			trialId: "foreign",
			attemptId: String(foreignAttempt.id),
		})
		const policy = { schemaVersion: 1, presentationModelCalls: false, presentationModelCallOptOut: true }
		await persistEvalEvent(
			attempt.id,
			journal.append("agent.turn.request_usage", { output: "unrelated-payload-canary" }),
		)
		await persistEvalEvent(
			foreignAttempt.id,
			foreignJournal.append("extension.presentation_model_call_policy", policy),
		)
		expect(await getPresentationModelCallPolicyEvents(attempt.id)).toEqual([])
		const event = journal.append("extension.presentation_model_call_policy", policy)
		await persistEvalEvent(attempt.id, event)
		const rows = await getPresentationModelCallPolicyEvents(attempt.id)
		expect(rows).toEqual([
			{
				attemptId: attempt.id,
				type: event.type,
				payload: policy,
				payloadDigest: event.payloadDigest,
				late: false,
			},
		])
		expect(JSON.stringify(rows)).not.toContain("unrelated-payload-canary")
	})

	it("bounds duplicate policy retrieval to two ordered rows without deleting stored evidence", async () => {
		const run = await createRun({ model: "test", socketPath: "duplicate-policy-evidence.sock" })
		const task = await createTask({ runId: run.id, language: "javascript", exercise: "duplicate-policy-evidence" })
		const attempt = await ensureAttempt(task.id, 1)
		const journal = new EventJournal({ runId: String(run.id), trialId: "trial", attemptId: String(attempt.id) })
		const policy = { schemaVersion: 1, presentationModelCalls: false, presentationModelCallOptOut: true }
		for (const late of [false, true, false])
			await persistEvalEvent(
				attempt.id,
				journal.append("extension.presentation_model_call_policy", policy, new Date().toISOString(), late),
			)
		const bounded = await getPresentationModelCallPolicyEvents(attempt.id)
		expect(bounded).toHaveLength(2)
		expect(bounded.map((row) => row.late)).toEqual([false, true])
		expect(await getEvalEvents(attempt.id)).toHaveLength(3)
	})

	it("retrieves observed installed identities by their verified content identity", async () => {
		const digest = `sha256:${"a".repeat(64)}`
		const task: TaskManifest = {
			schemaVersion: 1,
			id: "installation-fixture",
			version: 1,
			fixtureDigest: digest,
			capabilities: ["coding"],
			risk: "medium",
			network: "disabled",
			graders: [{ id: "tests", version: 1 }],
		}
		const variant: VariantManifest = {
			schemaVersion: 1,
			id: "installation-observation",
			extensionCommit: "installed:Alpha.alpha@1.0.0",
			workingTreeDigest: digest,
			model: "fixed-model",
			promptDigest: digest,
			toolSchemaDigest: digest,
			runnerImageDigest: digest,
			identityStatus: "observed_entrypoint",
			executionIdentity: {
				schemaVersion: 1,
				hostVersion: "1.138.0",
				extensionId: "Alpha.alpha",
				extensionVersion: "1.0.0",
				entrypointDigest: digest,
				manifestDigest: digest,
				identityScope: "observed-entrypoint-and-manifest",
			},
		}
		await persistRuntimeIdentities(task, variant)
		expect(await getRuntimeVariantManifest(manifestIdentity(variant))).toEqual(variant)
		expect(await getRuntimeVariantManifest("unavailable-installed-identity")).toBeNull()
	})
	it("idempotently persists normalized events and artifact descriptors", async () => {
		const run = await createRun({ model: "test", socketPath: "evidence.sock" })
		const task = await createTask({ runId: run.id, language: "javascript", exercise: "evidence" })
		const attempt = await ensureAttempt(task.id, 1)
		const journal = new EventJournal({ runId: String(run.id), trialId: "trial", attemptId: String(attempt.id) })
		const event = journal.append("lifecycle.attempt_started", { attemptId: attempt.id })
		await persistEvalEvent(attempt.id, event)
		await persistEvalEvent(attempt.id, event)
		expect(await getEvalEvents(attempt.id)).toHaveLength(1)

		const descriptor: ArtifactDescriptor = {
			schemaVersion: 1,
			id: `sha256:${"a".repeat(64)}`,
			attemptId: String(attempt.id),
			kind: "final_diff",
			digest: `sha256:${"a".repeat(64)}`,
			mediaType: "text/plain",
			sizeBytes: 12,
			access: "reviewer",
			retention: "campaign",
			uploadState: "complete",
			createdAt: "2026-01-01T00:00:00.000Z",
		}
		await persistArtifactDescriptors(attempt.id, [descriptor], ".artifacts")
		await persistArtifactDescriptors(attempt.id, [descriptor], ".artifacts")
		expect(await getArtifactDescriptors(attempt.id)).toEqual([
			expect.objectContaining({ kind: "final_diff", digest: descriptor.digest, uploadState: "complete" }),
		])
		const updated = await recordEvidenceIntegrity({
			attemptId: attempt.id,
			status: "valid",
			taskIdentity: "task@1:sha256:task",
			variantIdentity: "variant@1:sha256:variant",
			bundleDigest: `sha256:${"b".repeat(64)}`,
		})
		expect(updated).toMatchObject({ evidenceStatus: "valid", evidenceBundleDigest: `sha256:${"b".repeat(64)}` })
		expect(await getReconstructableEvidenceBundle(attempt.id)).toMatchObject({
			runId: String(run.id),
			attemptId: String(attempt.id),
			taskIdentity: "task@1:sha256:task",
			variantIdentity: "variant@1:sha256:variant",
			events: [expect.objectContaining({ sequence: 1 })],
			artifacts: [expect.objectContaining({ kind: "final_diff" })],
		})
	})
})
