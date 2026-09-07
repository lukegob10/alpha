import { strict as assert } from "node:assert"
import { test } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import { createDevelopmentSuite } from "../developmentSuites"
import { assertLiveGateConfig, evaluateLiveGate, fingerprintGateArtifacts, prepareLiveGate } from "../liveGate"
import type { CampaignConfig, CampaignReport } from "../types"

const config = (): CampaignConfig =>
	createDevelopmentSuite({
		suite: "development",
		id: "gate-test",
		provider: "live-copilot",
		modelId: "exact-model",
		effort: "high",
	})

function completeReport(plan = config()): CampaignReport {
	const attempts = plan.hosts.flatMap((host) =>
		plan.scenarioIds.map((scenarioId, index) => ({
			request: {
				campaignId: plan.id,
				attemptId: `${host.version}-${index}`,
				host,
				scenarioId,
				sample: 1,
				phase: "sample" as const,
				provider: plan.provider,
				requestLimit: 40,
			},
			result: {
				status: "passed" as const,
				usage: { requests: 2, inputTokens: null, outputTokens: null, cost: null },
				actualHostVersion: host.version,
				model: { id: "exact-model", effort: "high" },
				taskIds: [`task-${index}`],
			},
			elapsedMs: 10,
			evidence: `${host.version}-${index}/evidence-index.json`,
		})),
	)
	return {
		version: 1,
		id: plan.id,
		mode: "report-only",
		requestedProvider: plan.provider,
		startedAt: "2026-09-07T00:00:00Z",
		finishedAt: "2026-09-07T00:01:00Z",
		stopReason: "completed",
		counts: { passed: attempts.length, failed: 0, blocked: 0 },
		usage: { requests: attempts.length * 2, inputTokens: null, outputTokens: null, cost: null },
		attempts,
		repairs: [],
		retention: { status: "complete" },
	}
}

test("gate covers the whole registered matrix and labels single-host acceptance separately", () => {
	const plan = config()
	const result = evaluateLiveGate(plan, completeReport(plan))
	assert.equal(result.status, "passed")
	assert.equal(result.scope, "reference-and-current-hosts")
	assert.equal(result.cells.length, plan.scenarioIds.length * 2)
	plan.hosts = [{ version: "1.136.1" }]
	assert.equal(evaluateLiveGate(plan, completeReport(plan)).scope, "single-host-only")
})

test("gate rejects scripted, partial catalog and missing model configuration", () => {
	for (const alter of [
		(plan: CampaignConfig) => {
			plan.provider.mode = "scripted"
		},
		(plan: CampaignConfig) => {
			plan.scenarioIds.pop()
		},
		(plan: CampaignConfig) => {
			delete plan.provider.effort
		},
		(plan: CampaignConfig) => {
			delete plan.provider.modelId
		},
	]) {
		const plan = config()
		alter(plan)
		assert.throws(() => assertLiveGateConfig(plan))
	}
})

test("gate cannot pass empty, missing, duplicate or fabricated coverage even with green counters", () => {
	for (const alter of [
		(report: CampaignReport) => {
			report.attempts = []
		},
		(report: CampaignReport) => {
			report.attempts.pop()
		},
		(report: CampaignReport) => {
			report.attempts[1] = structuredClone(report.attempts[0]!)
		},
		(report: CampaignReport) => {
			report.attempts[0]!.request.scenarioId = "not-registered"
		},
		(report: CampaignReport) => {
			report.attempts[0]!.request.campaignId = "old-campaign"
		},
		(report: CampaignReport) => {
			report.attempts[0]!.request.phase = "reproduce"
		},
	]) {
		const report = completeReport()
		alter(report)
		assert.equal(evaluateLiveGate(config(), report).status, "failed")
	}
})

test("gate requires actual live identity, usage, task and retained evidence for every cell", () => {
	for (const alter of [
		(report: CampaignReport) => {
			report.attempts[0]!.result.actualHostVersion = "1.136.1"
		},
		(report: CampaignReport) => {
			report.attempts[0]!.result.model!.id = "other-model"
		},
		(report: CampaignReport) => {
			report.attempts[0]!.result.model!.effort = "low"
		},
		(report: CampaignReport) => {
			report.attempts[0]!.result.usage.requests = 0
		},
		(report: CampaignReport) => {
			report.attempts[0]!.result.usage.requests = null
		},
		(report: CampaignReport) => {
			report.attempts[0]!.result.taskIds = []
		},
		(report: CampaignReport) => {
			delete report.attempts[0]!.evidence
		},
		(report: CampaignReport) => {
			report.attempts[0]!.evidenceFailed = true
		},
		(report: CampaignReport) => {
			report.attempts[0]!.result.retentionFailed = true
		},
		(report: CampaignReport) => {
			report.attempts[0]!.result.status = "failed"
		},
		(report: CampaignReport) => {
			report.attempts[0]!.result.failure = { class: "tool", fingerprint: "error" }
		},
		(report: CampaignReport) => {
			report.stopReason = "cancelled"
		},
		(report: CampaignReport) => {
			report.usage.requests = null
		},
		(report: CampaignReport) => {
			delete report.retention
		},
		(report: CampaignReport) => {
			delete report.finishedAt
		},
	]) {
		const report = completeReport()
		alter(report)
		assert.equal(evaluateLiveGate(config(), report).status, "failed")
	}
})

test("a later passing reproduction cannot erase the original failure", () => {
	const report = completeReport()
	const retry = structuredClone(report.attempts[0]!)
	retry.request.attemptId = "retry"
	retry.request.phase = "reproduce"
	report.attempts[0]!.result.status = "failed"
	report.attempts.push(retry)
	assert.equal(evaluateLiveGate(config(), report).status, "failed")
})

test("a green workflow matrix reports the retention blocker in its final verdict", () => {
	const report = completeReport()
	report.retention = { status: "blocked", receipt: "retention-result.json" }
	const verdict = evaluateLiveGate(config(), report)
	assert.ok(verdict.cells.every((cell) => cell.status === "passed"))
	assert.equal(verdict.status, "failed")
	assert.deepEqual(verdict.retention, report.retention)
})

test("preparation fails before the host build when unit tests fail and preserves its receipt", async (context) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-live-gate-")))
	context.after(async () => {
		assert.equal(await fs.realpath(root), root)
		assert.match(path.basename(root), /^alpha-live-gate-/)
		await fs.rm(root, { recursive: true, force: true })
	})
	const calls: string[] = []
	assert.equal(
		await prepareLiveGate(
			root,
			path.join(root, "pnpm.cjs"),
			root,
			new AbortController().signal,
			async (command) => {
				calls.push(command.args.at(-1)!)
				return {
					exitCode: 1,
					signal: null,
					stdout: "test failure",
					stderr: "",
					cleanupVerified: false,
					outputTruncated: false,
				}
			},
		),
		false,
	)
	assert.deepEqual(calls, ["test:unit"])
	assert.equal(JSON.parse(await fs.readFile(path.join(root, "prepare-test-unit.json"), "utf8")).exitCode, 1)
})

test("artifact fingerprints detect modified, added and removed runtime files", async (context) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-live-gate-")))
	context.after(async () => {
		assert.equal(await fs.realpath(root), root)
		assert.match(path.basename(root), /^alpha-live-gate-/)
		await fs.rm(root, { recursive: true, force: true })
	})
	for (const file of [
		"src/package.json",
		"src/dist/extension.js",
		"src/webview-ui/build/assets/index.js",
		"apps/vscode-e2e/out/runTest.js",
	]) {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
		await fs.writeFile(path.join(root, file), "original")
	}
	const baseline = await fingerprintGateArtifacts(root)
	assert.equal(await fingerprintGateArtifacts(root), baseline)
	await fs.writeFile(path.join(root, "src/dist/extension.js"), "changed!")
	assert.notEqual(await fingerprintGateArtifacts(root), baseline)
	await fs.writeFile(path.join(root, "src/dist/extension.js"), "original")
	await fs.writeFile(path.join(root, "src/webview-ui/build/extra.js"), "new")
	assert.notEqual(await fingerprintGateArtifacts(root), baseline)
	await fs.unlink(path.join(root, "src/webview-ui/build/extra.js"))
	assert.equal(await fingerprintGateArtifacts(root), baseline)
	await fs.unlink(path.join(root, "src/dist/extension.js"))
	await assert.rejects(fingerprintGateArtifacts(root))
})
