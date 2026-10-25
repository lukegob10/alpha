import { strict as assert } from "node:assert"
import { test } from "node:test"

import { campaignConfigDigest } from "../config"
import { compareLiveProviderIdentity } from "../../liveProviderIdentity"
import {
	createLiveModelMatrix,
	runLiveModelMatrix,
	type CampaignExecutionResult,
	type LiveModelMatrixReport,
} from "../liveModelMatrix"
import type { CampaignConfig, CampaignReport } from "../types"

const plan = () => createLiveModelMatrix({ id: "provider-coverage", suite: "core" })

function complete(config: CampaignConfig): CampaignExecutionResult {
	const attempts: CampaignReport["attempts"] = config.scenarioIds.map((scenarioId, index) => ({
		request: {
			campaignId: config.id,
			attemptId: `attempt-${index}`,
			host: config.hosts[0]!,
			scenarioId,
			sample: 1,
			phase: "sample",
			provider: config.provider,
			requestLimit: 40,
		},
		result: {
			status: "passed",
			usage: { requests: 2, inputTokens: null, outputTokens: null, cost: null },
			actualHostVersion: "1.138.0",
			model: { id: config.provider.modelId!, effort: config.provider.effort },
			providerIdentity: compareLiveProviderIdentity(
				{ id: "github.copilot-chat", version: "0.66.0", entrypointSha256: "f".repeat(64) },
				{ id: "github.copilot-chat", version: "0.66.0", entrypointSha256: "f".repeat(64) },
			),
			taskIds: [`task-${index}`],
		},
		elapsedMs: 10,
		evidence: `attempt-${index}/evidence-index.json`,
	}))
	return {
		exitCode: 0,
		artifactsUnchanged: true,
		resultPath: `${config.id}/gate-result.json`,
		report: {
			version: 1,
			id: config.id,
			mode: "report-only",
			requestedProvider: config.provider,
			startedAt: "2026-10-24T00:00:00Z",
			finishedAt: "2026-10-24T00:01:00Z",
			stopReason: "completed",
			counts: { passed: attempts.length, failed: 0, blocked: 0 },
			usage: { requests: attempts.length * 2, inputTokens: null, outputTokens: null, cost: null },
			attempts,
			repairs: [],
			retention: { status: "complete" },
			evaluationIdentity: {
				extensionCommit: "a".repeat(40),
				workingTreeDigest: "a".repeat(64),
				extensionBuildDigest: "b".repeat(64),
				harnessDigest: "c".repeat(64),
				taskSetDigest: "d".repeat(64),
				sourceComponentsDigest: "e".repeat(64),
				configDigest: campaignConfigDigest(config),
				unchanged: true,
				missing: [],
			},
			evaluationPlan: {
				scenarioIds: [...config.scenarioIds],
				hostVersions: ["1.138.0"],
				samples: config.samples,
			},
		},
	}
}

test("matrix plans one identical exact-host suite for Luna max, Haiku high and Grok low in order", () => {
	const matrix = plan()
	assert.deepEqual(
		matrix.campaigns.map(({ provider, hosts, samples }) => ({ provider, hosts, samples })),
		[
			{ modelId: "gpt-6-luna", effort: "max" },
			{ modelId: "claude-haiku-5.5", effort: "high" },
			{ modelId: "grok-4.6", effort: "low" },
		].map((provider) => ({
			provider: { mode: "live-copilot", ...provider },
			hosts: [{ version: "1.138.0" }],
			samples: 1,
		})),
	)
	assert.equal(new Set(matrix.campaigns.map(campaignConfigDigest)).size, 1)
	for (const version of ["stable", "1.125.0", "1.139.1"]) {
		assert.throws(() =>
			createLiveModelMatrix({ id: "invalid-host", suite: "core", host: { version: version as never } }),
		)
	}
	assert.throws(() => createLiveModelMatrix({ id: "partial-suite", suite: "smoke" }))
})

test("each completed campaign settles before the next starts and every passing result retains its own evidence", async () => {
	const started: string[] = []
	const checkpoints: LiveModelMatrixReport[] = []
	let active = false
	const report = await runLiveModelMatrix(plan(), {
		async run(config) {
			assert.equal(active, false)
			active = true
			started.push(config.provider.modelId!)
			await Promise.resolve()
			active = false
			return complete(config)
		},
		async persist(report) {
			checkpoints.push(report)
		},
	})
	assert.deepEqual(started, ["gpt-6-luna", "claude-haiku-5.5", "grok-4.6"])
	assert.equal(report.status, "passed")
	assert.deepEqual(report.counts, { passed: 3, failed: 0, blocked: 0, notRun: 0 })
	assert.equal(report.maxRequests, 900)
	assert.equal(new Set(report.entries.map((entry) => entry.resultPath)).size, 3)
	assert.equal(
		checkpoints[0]!.entries.every((entry) => entry.status === "not-run"),
		true,
	)
	assert.equal(checkpoints.at(-1)!.status, "passed")
})

test("a model failure remains failed while the remaining models still run", async () => {
	const report = await runLiveModelMatrix(plan(), {
		async run(config) {
			const result = complete(config)
			if (config.provider.modelId === "gpt-6-luna") {
				result.exitCode = 1
				result.report!.attempts[0]!.result.status = "failed"
				result.report!.attempts[0]!.result.failure = { class: "assertion", fingerprint: "wrong-output" }
				result.report!.counts.passed--
				result.report!.counts.failed++
			}
			return result
		},
		async persist() {},
	})
	assert.equal(report.status, "failed")
	assert.deepEqual(
		report.entries.map((entry) => entry.status),
		["failed", "passed", "passed"],
	)
})

test("executor mutation cannot change the declared model, workload or acceptance checks", async () => {
	const matrix = plan()
	const original = structuredClone(matrix)
	const report = await runLiveModelMatrix(matrix, {
		async run(config) {
			const result = complete(config)
			config.provider = { mode: "scripted" }
			config.scenarioIds = []
			return result
		},
		async persist() {},
	})
	assert.equal(report.status, "passed")
	assert.deepEqual(matrix, original)
})

test("conditions changed within the first model prevent any later launch", async () => {
	let runs = 0
	const report = await runLiveModelMatrix(plan(), {
		async run(config) {
			runs++
			const result = complete(config)
			result.report!.evaluationIdentity!.unchanged = false
			return result
		},
		async persist() {},
	})
	assert.equal(runs, 1)
	assert.equal(report.status, "blocked")
	assert.deepEqual(report.counts, { passed: 0, failed: 0, blocked: 1, notRun: 2 })
})

test("a successful exit cannot hide absent live evidence, fallback models, downgraded effort or another host", async () => {
	for (const alter of [
		(result: CampaignExecutionResult) => {
			delete result.report
		},
		(result: CampaignExecutionResult) => {
			delete result.artifactsUnchanged
		},
		(result: CampaignExecutionResult) => {
			result.report!.attempts = []
		},
		(result: CampaignExecutionResult) => {
			result.report!.attempts[0]!.result.model!.id = "fallback-model"
		},
		(result: CampaignExecutionResult) => {
			result.report!.attempts[0]!.result.model!.effort = "medium"
		},
		(result: CampaignExecutionResult) => {
			result.report!.attempts[0]!.result.actualHostVersion = "1.139.1" as never
		},
	]) {
		const report = await runLiveModelMatrix(plan(), {
			async run(config) {
				const result = complete(config)
				if (config.provider.modelId === "claude-haiku-5.5") alter(result)
				return result
			},
			async persist() {},
		})
		assert.notEqual(report.status, "passed")
		assert.notEqual(report.entries[1]!.status, "passed")
	}
})

test("build or Copilot changes between models stop the matrix and leave unexecuted models visible", async () => {
	for (const alter of [
		(result: CampaignExecutionResult) => {
			result.artifactsUnchanged = false
		},
		(result: CampaignExecutionResult) => {
			result.report!.evaluationIdentity!.extensionBuildDigest = "0".repeat(64)
		},
		(result: CampaignExecutionResult) => {
			for (const { result: scenario } of result.report!.attempts) {
				scenario.providerIdentity!.before.entrypointSha256 = "0".repeat(64)
				scenario.providerIdentity!.after.entrypointSha256 = "0".repeat(64)
			}
		},
	]) {
		let runs = 0
		const report = await runLiveModelMatrix(plan(), {
			async run(config) {
				const result = complete(config)
				if (++runs === 2) alter(result)
				return result
			},
			async persist() {},
		})
		assert.equal(runs, 2)
		assert.equal(report.status, "blocked")
		assert.deepEqual(report.counts, { passed: 1, failed: 0, blocked: 1, notRun: 1 })
		assert.equal(report.entries[1]!.reason, "conditions_changed")
	}
})

test("cancellation stops future models after owned execution settles", async () => {
	const abort = new AbortController()
	let runs = 0
	const report = await runLiveModelMatrix(
		plan(),
		{
			async run(config, signal) {
				assert.equal(signal, abort.signal)
				runs++
				abort.abort()
				return complete(config)
			},
			async persist() {},
		},
		abort.signal,
	)
	assert.equal(runs, 1)
	assert.equal(report.status, "cancelled")
	assert.equal(report.counts.notRun, 2)
})

test("unsafe plans are rejected before execution or checkpoint creation", async () => {
	for (const alter of [
		(matrix: ReturnType<typeof plan>) => {
			matrix.campaigns.pop()
		},
		(matrix: ReturnType<typeof plan>) => {
			matrix.campaigns.reverse()
		},
		(matrix: ReturnType<typeof plan>) => {
			matrix.campaigns[1]!.samples = 2
		},
		(matrix: ReturnType<typeof plan>) => {
			matrix.campaigns[1]!.provider.effort = "low"
		},
		(matrix: ReturnType<typeof plan>) => {
			matrix.campaigns[1]!.hosts[0]!.version = "1.125.0" as never
		},
	]) {
		const matrix = plan()
		alter(matrix)
		await assert.rejects(
			runLiveModelMatrix(matrix, {
				async run() {
					assert.fail("Invalid matrix executed")
				},
				async persist() {
					assert.fail("Invalid matrix persisted")
				},
			}),
		)
	}
})

test("executor errors and failed checkpoints cannot launch later models or manufacture passes", async () => {
	let runs = 0
	const report = await runLiveModelMatrix(plan(), {
		async run() {
			runs++
			throw new Error("fixture executor failed")
		},
		async persist() {},
	})
	assert.equal(runs, 1)
	assert.equal(report.status, "blocked")
	assert.equal(report.counts.notRun, 2)
	await assert.rejects(
		runLiveModelMatrix(plan(), {
			async run() {
				assert.fail("Missing checkpoint must prevent execution")
			},
			async persist() {
				throw new Error("fixture checkpoint failed")
			},
		}),
	)
})
