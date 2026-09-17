import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { canonicalJson } from "../../evidence/index"
import { stringify } from "yaml"

import {
	aggregateHoldoutTrials,
	calibrationOutcome,
	createTaskTemplate,
	evaluateAdmission,
	evaluateFrontierConvergence,
	loadBenchmarkCatalog,
	mergeModelCalibration,
	reviewerHoldoutExport,
	scoredBenchmarkTasks,
	serveGraderRequest,
	submitGraderRequest,
	validateFrontierBankShape,
	type BenchmarkTaskManifest,
} from "../index"

describe("frontier benchmark contracts", () => {
	it("keeps infrastructure and grader failures out of capability calibration", () => {
		expect(calibrationOutcome("infrastructure_error")).toBeUndefined()
		expect(calibrationOutcome("grader_error")).toBeUndefined()
		expect(calibrationOutcome("cancelled")).toBeUndefined()
		expect(calibrationOutcome("passed")).toEqual({ passed: true, safetyFailed: false })
		expect(calibrationOutcome("outcome_failed")).toEqual({ passed: false, safetyFailed: false })
		expect(calibrationOutcome("safety_failed")).toEqual({ passed: false, safetyFailed: true })
	})

	it("loads the repository suites and keeps smoke tasks out of frontier scoring", async () => {
		const catalog = await loadBenchmarkCatalog(path.resolve(process.cwd(), "../../evals"))
		expect(catalog.suites.map(({ id }) => id)).toEqual(["smoke-v1", "frontier-v1"])
		expect([...catalog.tasks.values()].filter(({ task }) => task.partition === "smoke")).toHaveLength(8)
		expect([...catalog.tasks.values()].filter(({ task }) => task.partition !== "smoke")).toHaveLength(40)
		expect(scoredBenchmarkTasks(catalog)).toHaveLength(0)
		expect(() => validateFrontierBankShape(catalog.suites.find(({ id }) => id === "frontier-v1")!)).not.toThrow()
	})

	it("rejects duplicate identities and paths escaping the benchmark root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-invalid-"))
		try {
			await fs.writeFile(path.join(root, "benchmark-suites.yaml"), "suites: [suite.yaml]\n")
			const escape = { ...createTaskTemplate({ id: "escape", profile: "compact" }), fixture: "../outside" }
			await fs.writeFile(
				path.join(root, "suite.yaml"),
				stringify({
					schemaVersion: 1,
					id: "invalid",
					version: 1,
					status: "draft",
					primaryModel: "luna-high",
					referenceModel: "sol-high",
					tasks: [escape],
				}),
			)
			await expect(loadBenchmarkCatalog(root)).rejects.toThrow("Path escapes benchmark root")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it("requires and verifies an explicit private bundle version", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-bundle-version-"))
		const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-private-version-"))
		try {
			await fs.mkdir(path.join(privateRoot, "private-bundle", "task"), { recursive: true })
			await fs.writeFile(path.join(privateRoot, "private-bundle", "task", "hidden_tests.js"), "export {}\n")
			const { sha256 } = await import("../../evidence/index")
			const entryDigest = sha256(
				await fs.readFile(path.join(privateRoot, "private-bundle", "task", "hidden_tests.js")),
			)
			const bundleDigest = sha256(`task/hidden_tests.js\0${entryDigest}`)
			await fs.writeFile(
				path.join(privateRoot, "private-bundle", "bundle.json"),
				JSON.stringify({
					schemaVersion: 2,
					id: "private-bundle",
					version: 2,
					contentDigest: bundleDigest,
					readOnly: true,
					network: false,
					diagnostics: "bounded-decision-codes-only",
					graders: [
						{ id: "task.private", version: 2, entrypoint: "task/hidden_tests.js", digest: entryDigest },
					],
				}),
			)
			const { loadPrivateGraderBundle } = await import("../loader")
			const validation = { commands: [{ command: "node", args: ["--test"] }], network: "disabled" as const }
			const task = {
				id: "task",
				version: 1,
				partition: "holdout",
				admission: "draft",
				fixture: "tasks/task/workspace",
				prompt: "prompt.md",
				repository: { upstream: "local", commit: "one" },
				family: "test",
				capabilities: ["test"],
				risk: "low",
				difficulty: "foundation",
				contextBand: "compact",
				editTopology: { kind: "single-file", minFiles: 1, maxFiles: 2, allowedRoots: ["src", "test"] },
				validation,
				evidenceRequirements: ["final_workspace", "changed_paths", "usage", "environment", "grader_evidence"],
				graderReferenceDigest: sha256(
					canonicalJson([
						{
							id: "private",
							version: 2,
							alias: "hidden_tests",
							bundleId: "private-bundle",
							bundleVersion: 1,
							bundleDigest,
						},
					]),
				),
				environmentDigest: sha256(canonicalJson(validation)),
				restraint: false,
				budgets: { wallSeconds: 1, modelCalls: 1, toolCalls: 1, costUsd: 0 },
				repetitions: { smoke: 1, scored: 1 },
				graders: [
					{
						id: "private",
						version: 2,
						alias: "hidden_tests",
						bundleId: "private-bundle",
						bundleVersion: 1,
						bundleDigest,
					},
				],
			} satisfies BenchmarkTaskManifest
			await expect(loadPrivateGraderBundle(task, privateRoot)).rejects.toThrow("Private bundle version mismatch")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
			await fs.rm(privateRoot, { recursive: true, force: true })
		}
	})

	it("enforces strict calibration admission", () => {
		const base = {
			schemaVersion: 1,
			taskIdentity: "task@1",
			fixtureInitiallyFails: true,
			gold: { repetitions: 20, passed: 20 },
			broken: ["a", "b", "c"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: "wrong-output" })),
			determinism: { repetitions: 50, distinctDigests: 1 },
			models: [
				{
					model: "luna-high",
					repetitions: 5,
					passed: 3,
					trialIds: ["trial-0", "trial-1", "trial-2", "trial-3", "trial-4"],
					unexpectedTrialIds: [],
					safetyFailureTrialIds: [],
				},
			],
			humanReview: {
				unresolvedFalsePositivePasses: 0,
				reviewedTrialIds: ["trial-0"],
				reviewer: "reviewer",
				qualityApproved: true,
			},
			admitted: true,
		} as const
		expect(evaluateAdmission(base).admitted).toBe(true)
		const missingTrialEvidence = evaluateAdmission({
			...base,
			models: [{ ...base.models[0], trialIds: [] }],
		})
		expect(missingTrialEvidence.admitted).toBe(false)
		expect(missingTrialEvidence.issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "invalid_calibration_report" })]),
		)
		expect(evaluateAdmission({ ...base, gold: { repetitions: 20, passed: 19 } })).toMatchObject({
			admitted: false,
			issues: [{ code: "gold_instability" }],
		})
	})

	it("returns aggregate-only holdout results unless a reviewer explicitly authorizes details", () => {
		const trials = [
			{
				taskId: "secret-task",
				family: "safety",
				difficulty: "frontier",
				passed: false,
				safetyFailed: true,
				durationMs: 10,
				costUsd: 0.1,
				traceArtifact: "private/trace",
				diagnostics: { answer: "secret" },
			},
		]
		const aggregate = aggregateHoldoutTrials(trials)
		expect(aggregate).toMatchObject({ total: 1, passed: 0, safetyFailures: 1 })
		expect(JSON.stringify(aggregate)).not.toContain("secret-task")
		expect(() => reviewerHoldoutExport(trials, { reviewer: "", allowDetails: false })).toThrow(
			"Reviewer authorization",
		)
		expect(reviewerHoldoutExport(trials, { reviewer: "human", allowDetails: true })).toEqual(trials)
	})

	it("requires certification, paired Luna improvement, and complete holdouts", () => {
		const holdout = aggregateHoldoutTrials(
			Array.from({ length: 12 }, (_, index) => ({
				taskId: `h-${index}`,
				family: "mixed",
				difficulty: "frontier",
				passed: true,
				safetyFailed: false,
				durationMs: 10,
				costUsd: 0.1,
			})),
		)
		const valid = {
			harnessCertified: true,
			primaryModel: "luna-high" as const,
			smokePassed: true,
			fullyPaired: true,
			predictedSegmentImproved: true,
			criticalRegressions: 0,
			safetyFailures: 0,
			infrastructureErrorRate: 0,
			costPerSuccessIncrease: 0,
			p95LatencyIncrease: 0,
			holdout,
		}
		expect(evaluateFrontierConvergence(valid)).toEqual({ promote: true, reasons: [] })
	})

	it("records five Luna trials and enforces mandatory plus ten-percent human review", () => {
		const base = {
			schemaVersion: 1,
			taskIdentity: "task@1",
			fixtureInitiallyFails: true,
			restraint: false,
			gold: { repetitions: 20, passed: 20 },
			broken: ["a", "b", "c"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: "wrong-output" })),
			determinism: { repetitions: 50, distinctDigests: 1 },
			models: [],
			humanReview: {
				unresolvedFalsePositivePasses: 0,
				reviewedTrialIds: [],
				reviewer: "reviewer",
				qualityApproved: true,
			},
			admitted: false,
		}
		const trials = Array.from({ length: 5 }, (_, index) => ({
			id: `trial-${index}`,
			taskIdentity: "task@1",
			model: "luna-high" as const,
			passed: index > 0,
			unexpected: index === 0,
			safetyFailed: false,
			reviewed: index === 0,
		}))
		const merged = mergeModelCalibration(base, trials)
		expect(evaluateAdmission({ ...merged, admitted: true })).toMatchObject({ admitted: true, issues: [] })
		expect(
			evaluateAdmission({
				...merged,
				admitted: true,
				models: [{ ...merged.models[0]!, model: "sol-high" }],
			}),
		).toMatchObject({
			admitted: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "non_luna_calibration" })]),
		})
		expect(() => mergeModelCalibration(base, trials.slice(0, 4))).toThrow("At least five")
	})

	it("brokers grading through a trusted filesystem boundary", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "grader-broker-"))
		const abort = new AbortController()
		try {
			const server = serveGraderRequest({
				root,
				timeoutMs: 5_000,
				signal: abort.signal,
				execute: async (request) => ({
					run: { decision: "passed", results: [] },
					artifacts: [
						{
							schemaVersion: 1 as const,
							id: "artifact",
							attemptId: String(request.attemptId),
							kind: "grader_evidence" as const,
							mediaType: "text/plain",
							digest: `sha256:${"a".repeat(64)}`,
							sizeBytes: 1,
							access: "private" as const,
							retention: "campaign" as const,
							uploadState: "complete" as const,
							createdAt: new Date(0).toISOString(),
						},
					],
				}),
			})
			const result = await submitGraderRequest(
				root,
				{
					schemaVersion: 1,
					attemptId: 7,
					workspaceRoot: "/workspace",
					changedPaths: [],
					trace: [],
					environment: {},
				},
				5_000,
			)
			await server
			expect(result).toMatchObject({ run: { decision: "passed" }, artifacts: [{ attemptId: "7" }] })
		} finally {
			abort.abort()
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
