import { describe, expect, it } from "vitest"

import { EventJournal, type ArtifactDescriptor } from "../../../evidence/index"
import {
	getArtifactDescriptors,
	getEvalEvents,
	getReconstructableEvidenceBundle,
	persistArtifactDescriptors,
	persistEvalEvent,
	recordEvidenceIntegrity,
} from "../evidence"
import { ensureAttempt } from "../lifecycle"
import { createRun } from "../runs"
import { createTask } from "../tasks"

describe("M4 evidence persistence", () => {
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
