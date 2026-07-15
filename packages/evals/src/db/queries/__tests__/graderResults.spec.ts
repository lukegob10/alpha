import { describe, expect, it } from "vitest"

import type { GraderResult } from "../../../grading/index"
import { ensureAttempt } from "../lifecycle"
import { getGraderResults, persistGraderResults } from "../graderResults"
import { createRun } from "../runs"
import { createTask } from "../tasks"

const result: GraderResult = {
	graderId: "hidden-tests",
	graderVersion: 2,
	type: "command",
	status: "failed",
	hardGate: true,
	failureClass: "outcome",
	startedAt: "2026-01-01T00:00:00.000Z",
	finishedAt: "2026-01-01T00:00:01.000Z",
	durationMs: 1_000,
	diagnostics: [{ code: "command_exit_nonzero", message: "failed", severity: "error" }],
	evidence: [
		{
			id: "stdout",
			kind: "stdout",
			mediaType: "text/plain",
			digest: "sha256:abc",
			byteLength: 3,
		},
	],
}

describe("grader result persistence", () => {
	it("persists ordered versioned evidence against an attempt", async () => {
		const run = await createRun({ model: "test", socketPath: "test.sock" })
		const task = await createTask({ runId: run.id, language: "javascript", exercise: "grader-results" })
		const attempt = await ensureAttempt(task.id, 1)
		await persistGraderResults(attempt.id, [result, { ...result, graderId: "scope", type: "diff-policy" }])
		const persisted = await getGraderResults(attempt.id)
		expect(persisted).toHaveLength(2)
		expect(persisted[0]).toMatchObject({
			graderId: "hidden-tests",
			graderVersion: 2,
			status: "failed",
			diagnostics: result.diagnostics,
			evidence: result.evidence,
		})
	})

	it("rejects overwriting an immutable grader identity", async () => {
		const run = await createRun({ model: "test", socketPath: "test.sock" })
		const task = await createTask({ runId: run.id, language: "javascript", exercise: "grader-duplicate" })
		const attempt = await ensureAttempt(task.id, 1)
		await persistGraderResults(attempt.id, [result])
		await expect(persistGraderResults(attempt.id, [result])).rejects.toThrow()
		expect(await getGraderResults(attempt.id)).toHaveLength(1)
	})
})
