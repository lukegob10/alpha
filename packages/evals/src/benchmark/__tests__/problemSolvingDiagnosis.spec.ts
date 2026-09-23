import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { diagnoseProblemSolvingCampaign, problemSolvingDiagnosisMarkdown } from "../problemSolvingDiagnosis"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const roots: string[] = []

async function createCampaign() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-live-diagnosis-"))
	roots.push(root)
	const attemptId = "ps-alpha-scheduler-ordering-r1"
	const artifactDirectory = path.join(root, attemptId, "artifacts", attemptId)
	await fs.mkdir(artifactDirectory, { recursive: true })
	await fs.writeFile(
		path.join(artifactDirectory, "manifest.json"),
		JSON.stringify({ captureComplete: true, bundleSha256: "b".repeat(64) }),
	)
	await fs.writeFile(
		path.join(artifactDirectory, "task-agent_turn_events.jsonl.projection.json"),
		JSON.stringify({
			projection: {
				validationStatus: "validated",
				events: [
					{ type: "model_request_started" },
					{ type: "request_usage", inputTokens: 900, outputTokens: 120 },
					{ type: "tool_result", toolCategory: "search", status: "success" },
					{ type: "tool_batch_finished", durationMs: 250, parallelToolCount: 2 },
					{ type: "policy_snapshot", policyDigestSha256: "e".repeat(64) },
					{ type: "verification_result" },
				],
			},
		}),
	)
	await fs.writeFile(
		path.join(artifactDirectory, "task-agent_lifecycle_events.jsonl.projection.json"),
		JSON.stringify({ projection: { validationStatus: "validated", events: [] } }),
	)
	await fs.writeFile(path.join(artifactDirectory, "task-evidence-join.json"), JSON.stringify({ status: "captured" }))
	const reportPath = path.join(root, "report.json")
	await fs.writeFile(
		reportPath,
		JSON.stringify({
			hostVersion: "1.136.1",
			modelId: "gpt-test",
			effort: "high",
			buildIdentity: "a".repeat(40),
			extensionBundleSha256: "b".repeat(64),
			taskSetSha256: "d".repeat(64),
			selection: { selected: 1, repetitions: 1, taskIds: ["alpha-scheduler-ordering"] },
			attempts: [
				{
					taskId: "alpha-scheduler-ordering",
					attemptId,
					lane: "development",
					countsAsSolving: true,
					status: "passed",
					graderDecision: "passed",
					usage: { requests: 1, inputTokens: 900, outputTokens: 120, cost: null },
				},
			],
		}),
	)
	return reportPath
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("problem-solving campaign diagnosis", () => {
	it("aggregates live outcomes and safe trajectory counters without importing raw content", async () => {
		const reportPath = await createCampaign()
		const diagnosis = await diagnoseProblemSolvingCampaign({
			reportPath,
			evalRoot,
			now: new Date("2026-09-22T12:00:00.000Z"),
		})
		const markdown = problemSolvingDiagnosisMarkdown(diagnosis)

		expect(diagnosis.run).toMatchObject({
			attemptCount: 1,
			taskExecutionStartedAttemptCount: 1,
			pendingExecutionCount: 0,
			taskSetSha256: "d".repeat(64),
			plannedTaskIds: ["alpha-scheduler-ordering"],
			plannedRepetitions: 1,
			hostVersion: "1.136.1",
			modelId: "gpt-test",
		})
		expect(diagnosis.attempts[0]?.executionStartEvidence).toBe("request_receipt")
		expect(diagnosis.outcomes).toMatchObject({ passed: 1, scoredAttempts: 1, passRate: 1 })
		expect(diagnosis.evidence).toMatchObject({
			completeCaptures: 1,
			validatedEventTraces: 1,
			capturedJoins: 1,
			missingJoins: 0,
			categorizedToolResultCoverage: 1,
			usageTraceMatches: 1,
		})
		expect(diagnosis.extensionArtifact).toMatchObject({
			observedBundleSha256s: ["b".repeat(64)],
			missingStartedAttemptDigests: 0,
			mismatchedStartedAttemptDigests: 0,
			matchesExpected: true,
		})
		expect(diagnosis.attempts[0]?.evidence.policyDigestSha256s).toEqual(["e".repeat(64)])
		expect(diagnosis.policyArtifacts).toMatchObject({
			policySnapshotEventCount: 1,
			observedPolicyDigestSha256s: ["e".repeat(64)],
			startedAttemptsWithoutPolicyDigest: 0,
			attemptsWithMultiplePolicyDigests: 0,
		})
		expect(diagnosis.evidence.toolResultsByCategory).toEqual({ search: 1 })
		expect(diagnosis.evidence.verificationResults).toBe(1)
		expect(diagnosis.evidence.parallelTools).toMatchObject({ count: 1, median: 2, p95: 2 })
		expect(diagnosis.coverage.candidateGaps.map(({ area }) => area)).toContain(
			"Git branch, commit, and worktree operations",
		)
		expect(markdown).toContain("One sample per task cannot estimate run-to-run variance")
		expect(markdown).toContain("Git branch, commit, and worktree operations")
		expect(markdown).toContain(`Task-set SHA-256: ${"d".repeat(64)}`)
		expect(markdown).toContain("Planned selection: 1 task(s) × 1 repetition(s): alpha-scheduler-ordering.")
		expect(markdown).toContain(
			"Effective tool-policy hashes captured: 1 unique digest(s); 1 policy_snapshot event(s)",
		)
		expect(markdown).toContain(
			"Campaign execution complete: 1/1 planned task executions started (recorded attempts: 1).",
		)
		expect(markdown).toContain(
			"verification_result trajectory events: 1 (grader outcomes are reported separately).",
		)
		expect(markdown).toContain(
			`Extension bundle SHA-256: prelaunch ${"b".repeat(64)}; runner-captured ${"b".repeat(64)}; missing on started attempts 0; mismatches 0; prelaunch match confirmed.`,
		)
		expect(markdown).not.toContain("/tmp/alpha-live-diagnosis-")
	})

	it("flags runner-captured extension bundle digests that differ from the prelaunch fingerprint", async () => {
		const reportPath = await createCampaign()
		const data = JSON.parse(await fs.readFile(reportPath, "utf8")) as Record<string, unknown>
		data.extensionBundleSha256 = "c".repeat(64)
		await fs.writeFile(reportPath, JSON.stringify(data))

		const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })

		expect(diagnosis.extensionArtifact).toMatchObject({
			observedBundleSha256s: ["b".repeat(64)],
			missingStartedAttemptDigests: 0,
			mismatchedStartedAttemptDigests: 1,
			matchesExpected: false,
		})
		expect(diagnosis.hypotheses[0]?.finding).toContain("bundle digest differs from the prelaunch fingerprint")
	})

	it("flags campaigns that captured more than one extension entrypoint digest", async () => {
		const reportPath = await createCampaign()
		const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
			extensionBundleSha256?: string
			selection: { selected: number; repetitions: number; taskIds: string[] }
			attempts: Array<Record<string, unknown>>
		}
		const secondAttemptId = "ps-repo-cache-invalidation-r1"
		const artifactDirectory = path.join(path.dirname(reportPath), secondAttemptId, "artifacts", secondAttemptId)
		await fs.mkdir(artifactDirectory, { recursive: true })
		await fs.writeFile(
			path.join(artifactDirectory, "manifest.json"),
			JSON.stringify({ captureComplete: true, bundleSha256: "c".repeat(64) }),
		)
		delete report.extensionBundleSha256
		report.selection = {
			selected: 2,
			repetitions: 1,
			taskIds: ["alpha-scheduler-ordering", "repo-cache-invalidation"],
		}
		report.attempts.push({
			taskId: "repo-cache-invalidation",
			attemptId: secondAttemptId,
			lane: "core",
			countsAsSolving: false,
			status: "failed",
			graderDecision: "outcome_failed",
			usage: { requests: 1, inputTokens: 10, outputTokens: 3, cost: null },
		})
		await fs.writeFile(reportPath, JSON.stringify(report))

		const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })

		expect(diagnosis.extensionArtifact).toMatchObject({
			observedBundleSha256s: ["b".repeat(64), "c".repeat(64)],
			matchesExpected: null,
		})
		expect(diagnosis.hypotheses[0]?.finding).toContain("Multiple runner-captured extension bundle digests")
	})

	it("keeps missing capture, missing categories, and unknown costs distinct", async () => {
		const reportPath = await createCampaign()
		const data = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
			attempts: Array<Record<string, unknown>>
			selection?: { selected: number; repetitions: number; taskIds: string[] }
		}
		const attempt = data.attempts[0]
		if (!attempt) throw new Error("Test campaign attempt is missing")
		attempt.usage = { requests: 1, inputTokens: 900, outputTokens: 120, cost: null }
		await fs.writeFile(reportPath, JSON.stringify(data))
		const attemptRoot = path.join(path.dirname(reportPath), "ps-alpha-scheduler-ordering-r1")
		await fs.rm(attemptRoot, { recursive: true, force: true })
		const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })
		expect(diagnosis.evidence.missingCaptures).toBe(1)
		expect(diagnosis.evidence.categorizedToolResultCoverage).toBeNull()
		expect(diagnosis.usage.unknownCostAttempts).toBe(1)
		expect(diagnosis.attempts[0]?.evidence.eventLogValidation).toBe("missing")
	})

	it("separates command-policy failures from task-solving outcomes without exposing command text", async () => {
		const reportPath = await createCampaign()
		const data = JSON.parse(await fs.readFile(reportPath, "utf8")) as { attempts: Array<Record<string, unknown>> }
		const attempt = data.attempts[0]
		if (!attempt) throw new Error("Test campaign attempt is missing")
		attempt.countsAsSolving = false
		attempt.status = "failed"
		attempt.failureClass = "infrastructure"
		attempt.failureCategory = "policy"
		attempt.failureCode = "unexpected_command"
		attempt.graderDecision = "outcome_failed"
		attempt.rejectedCommandText = "SENSITIVE-COMMAND-CONTENT"
		await fs.writeFile(reportPath, JSON.stringify(data))

		const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })
		const markdown = problemSolvingDiagnosisMarkdown(diagnosis)

		expect(diagnosis.failureReasons).toEqual({ "infrastructure/policy/unexpected_command": 1 })
		expect(diagnosis.hypotheses[0]?.finding).toContain("command approval gate")
		expect(diagnosis.hypotheses[0]?.nextCheck).toContain("without relaxing approvals")
		expect(markdown).toContain("| infrastructure/policy/unexpected_command | 1 |")
		expect(markdown).toContain(
			"| alpha-scheduler-ordering | alpha-task-bank | development | failed | request_receipt | infrastructure/policy/unexpected_command | outcome_failed |",
		)
		expect(JSON.stringify(diagnosis)).not.toContain("SENSITIVE-COMMAND-CONTENT")
		expect(markdown).not.toContain("SENSITIVE-COMMAND-CONTENT")
	})

	it("classifies a blocked profile lease from its bounded runner receipt", async () => {
		const reportPath = await createCampaign()
		const data = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
			attempts: Array<Record<string, unknown>>
			selection?: { selected: number; repetitions: number; taskIds: string[] }
		}
		const attempt = data.attempts[0]
		if (!attempt) throw new Error("Test campaign attempt is missing")
		attempt.countsAsSolving = false
		attempt.status = "failed"
		attempt.failureClass = "infrastructure"
		attempt.failureCode = "runner_failure"
		attempt.graderDecision = "outcome_failed"
		data.selection = {
			selected: 3,
			repetitions: 2,
			taskIds: ["alpha-scheduler-ordering", "repo-cache-invalidation", "repo-pagination-cursor"],
		}
		await fs.writeFile(reportPath, JSON.stringify(data))
		const attemptId = "ps-alpha-scheduler-ordering-r1"
		const artifactDirectory = path.join(path.dirname(reportPath), attemptId, "artifacts", attemptId)
		await Promise.all([
			fs.rm(path.join(artifactDirectory, "task-agent_turn_events.jsonl.projection.json"), { force: true }),
			fs.rm(path.join(artifactDirectory, "task-agent_lifecycle_events.jsonl.projection.json"), { force: true }),
			fs.rm(path.join(artifactDirectory, "task-evidence-join.json"), { force: true }),
		])
		await fs.writeFile(
			path.join(artifactDirectory, "run-result.json"),
			JSON.stringify({ status: "blocked", failure: "profile-busy" }),
		)

		const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })

		expect(diagnosis.attempts[0]).toMatchObject({
			status: "blocked",
			executionState: "preflight_blocked",
			executionStartEvidence: "preflight_blocked",
			failureClass: "profile_busy",
			failureCategory: "runner",
			failureCode: "profile_busy",
		})
		expect(diagnosis.outcomes).toMatchObject({ blocked: 1, scoredAttempts: 0, passRate: null, wilson95: null })
		expect(diagnosis.run).toMatchObject({
			attemptCount: 1,
			taskExecutionStartedAttemptCount: 0,
			preExecutionBlockedAttemptCount: 1,
			executionStartUnknownAttemptCount: 0,
			plannedAttemptCount: 6,
			pendingExecutionCount: 6,
			campaignComplete: false,
			stopSignal: "profile_busy/runner/profile_busy",
			notAttemptedTaskIds: ["alpha-scheduler-ordering", "repo-cache-invalidation", "repo-pagination-cursor"],
		})
		expect(diagnosis.coverage).toMatchObject({ sources: {}, lanes: {}, tags: {}, candidateGaps: [] })
		expect(diagnosis.failureReasons).toEqual({ "profile_busy/runner/profile_busy": 1 })
		expect(diagnosis.hypotheses[0]).toMatchObject({
			priority: "high",
			finding: "A busy VS Code profile lease blocked campaign execution.",
		})
		expect(diagnosis.hypotheses[0]?.nextCheck).toContain("rerun the declared selection in a fresh run root")
		expect(diagnosis.hypotheses[0]?.finding).not.toContain("model quality")
		expect(problemSolvingDiagnosisMarkdown(diagnosis)).toContain(
			"Campaign execution incomplete: 1/6 attempts recorded; 0 task executions started; 1 blocked before execution; 0 execution starts unknown; 6 planned execution(s) pending. Last safe signal profile_busy/runner/profile_busy. Pending task IDs for remaining repetitions: alpha-scheduler-ordering, repo-cache-invalidation, repo-pagination-cursor.",
		)
		expect(problemSolvingDiagnosisMarkdown(diagnosis)).toContain("1 attempt had no usable grader score.")
		expect(problemSolvingDiagnosisMarkdown(diagnosis)).toContain(
			"| alpha-scheduler-ordering | alpha-task-bank | development | blocked | preflight_blocked | profile_busy/runner/profile_busy | excluded from score (recorded outcome_failed) |",
		)
		expect(problemSolvingDiagnosisMarkdown(diagnosis)).toContain(
			"Candidate gap analysis not run because no task execution start was evidenced.",
		)
	})

	it("does not infer task execution from profile and policy initialization events", async () => {
		const reportPath = await createCampaign()
		const data = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
			attempts: Array<Record<string, unknown>>
		}
		const attempt = data.attempts[0]
		if (!attempt) throw new Error("Test campaign attempt is missing")
		attempt.countsAsSolving = false
		attempt.status = "failed"
		attempt.graderDecision = "outcome_failed"
		attempt.usage = { requests: 0, inputTokens: null, outputTokens: null, cost: null }
		await fs.writeFile(reportPath, JSON.stringify(data))
		const artifactDirectory = path.join(
			path.dirname(reportPath),
			"ps-alpha-scheduler-ordering-r1",
			"artifacts",
			"ps-alpha-scheduler-ordering-r1",
		)
		await fs.writeFile(
			path.join(artifactDirectory, "task-agent_turn_events.jsonl.projection.json"),
			JSON.stringify({
				projection: {
					validationStatus: "validated",
					events: [
						{ type: "profile_resolved" },
						{ type: "policy_snapshot", policyDigestSha256: "f".repeat(64) },
					],
				},
			}),
		)

		const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })

		expect(diagnosis.attempts[0]?.executionState).toBe("unknown")
		expect(diagnosis.attempts[0]?.executionStartEvidence).toBe("unknown")
		expect(diagnosis.run).toMatchObject({
			taskExecutionStartedAttemptCount: 0,
			executionStartUnknownAttemptCount: 1,
			pendingExecutionCount: 1,
			campaignComplete: false,
		})
		expect(diagnosis.coverage.sources).toEqual({})
	})

	it("records verification evidence as a distinct task execution start signal", async () => {
		const reportPath = await createCampaign()
		const data = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
			attempts: Array<Record<string, unknown>>
		}
		const attempt = data.attempts[0]
		if (!attempt) throw new Error("Test campaign attempt is missing")
		attempt.status = "failed"
		attempt.countsAsSolving = false
		attempt.graderDecision = "outcome_failed"
		attempt.usage = { requests: 0, inputTokens: null, outputTokens: null, cost: null }
		await fs.writeFile(reportPath, JSON.stringify(data))
		const artifactDirectory = path.join(
			path.dirname(reportPath),
			"ps-alpha-scheduler-ordering-r1",
			"artifacts",
			"ps-alpha-scheduler-ordering-r1",
		)
		await fs.writeFile(
			path.join(artifactDirectory, "task-agent_turn_events.jsonl.projection.json"),
			JSON.stringify({
				projection: { validationStatus: "validated", events: [{ type: "verification_result" }] },
			}),
		)

		const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })

		expect(diagnosis.attempts[0]).toMatchObject({
			executionState: "started",
			executionStartEvidence: "verification_event",
		})
	})

	it("summarizes timeout receipts into a bounded runner signal", async () => {
		const reportPath = await createCampaign()
		const data = JSON.parse(await fs.readFile(reportPath, "utf8")) as { attempts: Array<Record<string, unknown>> }
		const attempt = data.attempts[0]
		if (!attempt) throw new Error("Test campaign attempt is missing")
		attempt.countsAsSolving = false
		attempt.status = "failed"
		attempt.failureClass = "budget"
		attempt.failureCode = "runner_failure"
		attempt.graderDecision = "outcome_failed"
		await fs.writeFile(reportPath, JSON.stringify(data))
		const attemptId = "ps-alpha-scheduler-ordering-r1"
		const artifactDirectory = path.join(path.dirname(reportPath), attemptId, "artifacts", attemptId)
		await fs.writeFile(
			path.join(artifactDirectory, "run-result.json"),
			JSON.stringify({ status: "failed", failure: "scenario-timeout" }),
		)

		const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })

		expect(diagnosis.failureReasons).toEqual({ "budget/timeout/runner_timeout": 1 })
		expect(JSON.stringify(diagnosis)).not.toContain("scenario-timeout")
	})
})
